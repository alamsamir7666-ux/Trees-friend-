/**
 * Per-tool rate limiter (v5.6).
 *
 * Problem:
 *   The global chat rate limiter (30 req/hour/IP) covers the overall chat
 *   endpoint, but individual tools have different sensitivity levels:
 *     - search_catalog: public data, can be spammy (AI calls it many times)
 *     - get_user_orders: PRIVATE user data, should be very tight
 *     - get_order_details: PRIVATE order data, should be very tight
 *     - get_product_care: public data, moderate
 *     - search_knowledge_base: public KB data, moderate
 *
 *   Without per-tool limits, a single chat session could call get_user_orders
 *   10+ times (the AI loops), or search_catalog 20+ times (model is stuck).
 *   This wastes resources + risks data exposure for private tools.
 *
 * Industry standard:
 *   - OpenAI: per-endpoint rate limits (different tiers for different APIs)
 *   - Stripe: per-resource rate limits (charges vs. customers vs. webhooks)
 *   - GitHub: per-endpoint limits (core vs. search vs. code scanning)
 *   - AWS: per-API-method throttling (configurable per-action)
 *
 * Solution (this module):
 *   Each tool gets its own rate limit, tracked by (userId OR ip) + toolName.
 *   When a tool exceeds its limit, executeTool() returns a friendly error
 *   that the AI can relay to the user (instead of the actual data).
 *
 *   Limits are enforced via the existing Redis infrastructure (same Upstash
 *   connection as the global rate limiter). Falls back to in-memory for dev.
 *
 * Tool limit tiers:
 *   - SENSITIVE (get_user_orders, get_order_details): 10 calls/hour
 *     Very tight — private user data. Even a legitimate multi-order lookup
 *     rarely needs more than 3-4 calls in a conversation.
 *   - CATALOG (search_catalog, get_product_care, search_knowledge_base): 60 calls/hour
 *     Moderate — public data. The AI might call search_catalog 3-5 times in
 *     a complex multi-product comparison, which is legitimate. 60/hour
 *     allows ~12 conversations with 5 calls each — generous for real use,
 *     tight enough to prevent spam.
 *
 * Config (env vars, all optional):
 *   TOOL_RATE_LIMIT_ENABLED — master switch (default: "true")
 *   TOOL_RATE_LIMIT_SENSITIVE_MAX — calls/hour for sensitive tools (default: 10)
 *   TOOL_RATE_LIMIT_CATALOG_MAX — calls/hour for catalog tools (default: 60)
 */
import { getRedis } from "./redisClient";
import { logger } from "./logger";

// ─── Config ──────────────────────────────────────────────────────────────────

const RATE_LIMIT_ENABLED =
  (process.env.TOOL_RATE_LIMIT_ENABLED ?? "true").toLowerCase() !== "false";
const SENSITIVE_MAX = Number(process.env.TOOL_RATE_LIMIT_SENSITIVE_MAX ?? 10);
const CATALOG_MAX = Number(process.env.TOOL_RATE_LIMIT_CATALOG_MAX ?? 60);
const WINDOW_SECONDS = 60 * 60; // 1 hour

// ─── Tool tiers ──────────────────────────────────────────────────────────────

export type ToolTier = "sensitive" | "catalog" | "unlimited";

export const TOOL_TIERS: Record<string, ToolTier> = {
  search_catalog: "catalog",
  get_product_care: "catalog",
  search_knowledge_base: "catalog",
  // v6.1: seller-listing search is public catalog data (listings + variants
  // + sellers are all visible on the public marketplace). Same tier as the
  // other catalog tools — 60 calls/hour.
  search_seller_listings: "catalog",
  get_user_orders: "sensitive",
  get_order_details: "sensitive",
};

const TIER_LIMITS: Record<ToolTier, number> = {
  sensitive: SENSITIVE_MAX,
  catalog: CATALOG_MAX,
  unlimited: Infinity,
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToolRateLimitResult {
  /** True if the call is allowed (under the limit). */
  allowed: boolean;
  /** The tool name being checked. */
  toolName: string;
  /** The tier (sensitive/catalog/unlimited). */
  tier: ToolTier;
  /** Max calls per window. */
  limit: number;
  /** Remaining calls in the current window. */
  remaining: number;
  /** Seconds until the window resets (for Retry-After messaging). */
  retryAfterSeconds: number;
}

// ─── In-memory fallback (dev only) ──────────────────────────────────────────

interface InMemoryCounter {
  count: number;
  resetAt: number;
}

const _inMemory = new Map<string, InMemoryCounter>();

// Clean up expired entries every 5 minutes (long-lived processes only)
if (typeof setInterval !== "undefined") {
  setInterval(
    () => {
      const now = Date.now();
      for (const [key, entry] of _inMemory.entries()) {
        if (entry.resetAt < now) _inMemory.delete(key);
      }
    },
    5 * 60 * 1000,
  ).unref?.();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Checks if a tool call is allowed under its per-tool rate limit.
 *
 * Called by executeTool() in aiTools.ts BEFORE executing the tool. If
 * `allowed` is false, the caller should return a friendly error message
 * to the AI (which relays it to the user) instead of executing the tool.
 *
 * @param toolName - The tool name (e.g. "search_catalog", "get_user_orders")
 * @param userId - The user's Clerk ID (null for anonymous)
 * @param ip - The user's IP address (fallback key when userId is null)
 * @returns ToolRateLimitResult with allowed flag + remaining calls
 */
export async function checkToolRateLimit(
  toolName: string,
  userId: string | null,
  ip: string,
): Promise<ToolRateLimitResult> {
  const tier = TOOL_TIERS[toolName] ?? "unlimited";

  // Unlimited tools (unknown tools, future tools without a tier) skip
  // rate limiting entirely.
  if (tier === "unlimited" || !RATE_LIMIT_ENABLED) {
    return {
      allowed: true,
      toolName,
      tier,
      limit: Infinity,
      remaining: Infinity,
      retryAfterSeconds: 0,
    };
  }

  const limit = TIER_LIMITS[tier];
  const key = buildKey(toolName, userId, ip, tier);

  const redis = getRedis();
  if (!redis) {
    return checkInMemory(key, limit);
  }

  // ─── Redis path (production) ────────────────────────────────────────────
  // Use a simple INCR + EXPIRE pattern:
  //   1. INCR the counter key
  //   2. If it's the first call (INCR returns 1), set the TTL
  //   3. Check if the count exceeds the limit
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, WINDOW_SECONDS);
    }

    const remaining = Math.max(0, limit - count);
    const allowed = count <= limit;

    if (!allowed) {
      // Get the TTL for Retry-After
      const ttl = await redis.ttl(key);
      logger.warn(
        { toolName, tier, count, limit, key: key.slice(0, 40), userId: userId ?? "anon" },
        "Tool rate limit EXCEEDED — blocking tool call",
      );
      return {
        allowed: false,
        toolName,
        tier,
        limit,
        remaining: 0,
        retryAfterSeconds: ttl > 0 ? ttl : WINDOW_SECONDS,
      };
    }

    return {
      allowed: true,
      toolName,
      tier,
      limit,
      remaining,
      retryAfterSeconds: 0,
    };
  } catch (err) {
    // Redis error → fail-open (allow the call, better than blocking all tools)
    logger.warn({ err, toolName }, "Tool rate limit: Redis error, failing open");
    return {
      allowed: true,
      toolName,
      tier,
      limit,
      remaining: limit,
      retryAfterSeconds: 0,
    };
  }
}

/**
 * Builds the Redis key for a tool rate limit.
 *
 * Key format: `ai:tool-rl:{tier}:{toolName}:{userId or ip}`
 *
 * - `ai:tool-rl:` namespace — separate from `ai:cache:`, `ai:inj:`, `ai:topic:`
 * - `{tier}` — sensitive/catalog (so different tiers don't collide)
 * - `{toolName}` — per-tool (so search_catalog calls don't count against get_user_orders)
 * - `{userId or ip}` — per-user (anonymous users tracked by IP)
 */
function buildKey(toolName: string, userId: string | null, ip: string, tier: ToolTier): string {
  const identity = userId ?? `ip:${ip}`;
  return `ai:tool-rl:${tier}:${toolName}:${identity}`;
}

/**
 * In-memory rate limit check (dev fallback when Redis is unavailable).
 */
function checkInMemory(key: string, limit: number): ToolRateLimitResult {
  const now = Date.now();
  const existing = _inMemory.get(key);

  if (!existing || existing.resetAt < now) {
    // First call or window expired — start fresh
    _inMemory.set(key, { count: 1, resetAt: now + WINDOW_SECONDS * 1000 });
    return {
      allowed: true,
      toolName: key.split(":")[3] ?? "unknown",
      tier: key.split(":")[2] as ToolTier,
      limit,
      remaining: limit - 1,
      retryAfterSeconds: 0,
    };
  }

  existing.count++;
  const remaining = Math.max(0, limit - existing.count);
  const allowed = existing.count <= limit;

  if (!allowed) {
    const retryAfterSeconds = Math.ceil((existing.resetAt - now) / 1000);
    return {
      allowed: false,
      toolName: key.split(":")[3] ?? "unknown",
      tier: key.split(":")[2] as ToolTier,
      limit,
      remaining: 0,
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
    };
  }

  return {
    allowed: true,
    toolName: key.split(":")[3] ?? "unknown",
    tier: key.split(":")[2] as ToolTier,
    limit,
    remaining,
    retryAfterSeconds: 0,
  };
}

// ─── Config inspection (for admin endpoint) ──────────────────────────────────

/**
 * Returns the per-tool rate limit config (for admin endpoint).
 */
export function getToolRateLimitStatus(): {
  enabled: boolean;
  sensitiveMax: number;
  catalogMax: number;
  windowSeconds: number;
  tools: { name: string; tier: ToolTier; limit: number }[];
} {
  const tools = Object.entries(TOOL_TIERS).map(([name, tier]) => ({
    name,
    tier,
    limit: TIER_LIMITS[tier],
  }));

  return {
    enabled: RATE_LIMIT_ENABLED,
    sensitiveMax: SENSITIVE_MAX,
    catalogMax: CATALOG_MAX,
    windowSeconds: WINDOW_SECONDS,
    tools,
  };
}
