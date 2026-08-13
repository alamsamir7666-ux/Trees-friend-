/**
 * Semantic response cache for AI chat.
 *
 * Industry standard: cache AI responses to avoid redundant API calls.
 * 30-50% of chat queries are semantic duplicates ("how often to water
 * mango?" vs "how often should I water a mango tree?"). Caching cuts
 * costs dramatically.
 *
 * Two-tier cache:
 *   1. Exact-match: hash the (systemPrompt + userMessage + history hash)
 *      → instant cache hit, zero API cost.
 *   2. Similarity-based: (future — requires embeddings) compare the
 *      user's message embedding against cached query embeddings. If
 *      similarity > threshold, return the cached response.
 *
 * This implementation does tier 1 (exact-match) with Redis. Tier 2
 * requires an embedding model (Gemini text-embedding or OpenAI
 * text-embedding-3-small) and a vector store (Upstash Vector or
 * pgvector). The interface is designed so tier 2 can be added later
 * without changing the caller.
 *
 * Cache invalidation:
 *   - TTL-based: cached responses expire after AI_CACHE_TTL_SECONDS (default 1h)
 *   - Manual: DELETE /api/ai/admin/cache clears all entries
 *   - Automatic: product catalog changes should invalidate (via webhook
 *     from the admin product update route — not implemented yet)
 *
 * What's NOT cached:
 *   - Messages that triggered USER-SCOPED tool calls (get_user_orders,
 *     get_order_details — private data). Caching would leak user data.
 *   - Messages from signed-in users asking about their orders (private data)
 *   - Messages shorter than 10 chars (too generic, cache hit rate too high)
 *
 * ─── Bug #4 fix: tool-call cache policy ──────────────────────────────────────
 *
 * Previously the route always passed `hadToolCalls: false` to the cache
 * setters, even when tool calls happened. This meant responses containing
 * live product data (search_catalog results with current prices) got
 * cached and served stale for 1 hour. If a seller updated a price, the
 * cache still showed the old price.
 *
 * The new policy (3 tiers):
 *   1. NO tools called → normal long-TTL cache (1 hour, configurable).
 *   2. CATALOG tools called (search_catalog, get_product_care) → short-TTL
 *      cache (5 min, configurable via AI_TOOL_CACHE_TTL_SECONDS). The data
 *      is public so no privacy issue, but it changes (prices, availability)
 *      so we use a shorter TTL. If AI_TOOL_CACHE_TTL_SECONDS=0, skip caching
 *      entirely (maximum freshness).
 *   3. USER-SCOPED tools called (get_user_orders, get_order_details) →
 *      NEVER cache. The data is private to the authenticated user.
 *
 * The cache key includes a `t:` suffix for tool-call responses so they
 * don't collide with non-tool responses for the same message (which would
 * cause the short-TTL entry to be served when a long-TTL entry exists,
 * or vice versa).
 */
import { getRedis } from "./redisClient";
import { logger } from "./logger";
import { createHash } from "crypto";

const CACHE_TTL_SECONDS = Number(process.env.AI_CACHE_TTL_SECONDS ?? 3600); // 1 hour
// Bug #4 fix: short TTL for tool-call responses (catalog data changes).
// Default 5 min. Set to 0 to disable caching tool-call responses entirely.
const TOOL_CACHE_TTL_SECONDS = Number(process.env.AI_TOOL_CACHE_TTL_SECONDS ?? 300);
const MIN_MESSAGE_LENGTH = 10;

// ─── Cache key generation ───────────────────────────────────────────────────

/**
 * Generates a deterministic cache key from the inputs.
 *
 * The key includes:
 *   - A hash of the system prompt (so prompt changes invalidate the cache)
 *   - A hash of the recent history (so different conversation context = different cache entry)
 *   - The user message (normalized: trimmed, lowercased, collapsed whitespace)
 *
 * We use SHA-256 and take the first 16 hex chars (64 bits) — collision-safe
 * for cache keys (birthday bound: ~4 billion entries before 50% collision chance).
 */
function generateCacheKey(
  systemPrompt: string,
  history: { role: string; text: string }[],
  userMessage: string,
  /** Bug #4 fix: include a tool-call marker in the key so tool-call + non-tool-call
   * responses for the same message don't collide (different TTLs). */
  hasToolCalls: boolean = false,
): string {
  // Normalize the user message: trim, lowercase, collapse whitespace
  const normalizedMessage = userMessage.trim().toLowerCase().replace(/\s+/g, " ");

  // Hash the system prompt (only first 500 chars — the prompt is long but
  // the version-specific part is usually at the top)
  const promptHash = createHash("sha256")
    .update(systemPrompt.slice(0, 500))
    .digest("hex")
    .slice(0, 16);

  // Hash the last 3 history messages (recent context affects the response)
  const recentHistory = history.slice(-3);
  const historyStr = recentHistory.map((h) => `${h.role}:${h.text.slice(0, 200)}`).join("|");
  const historyHash = createHash("sha256")
    .update(historyStr)
    .digest("hex")
    .slice(0, 16);

  // Bug #4 fix: add a `t:1` segment for tool-call responses so they're
  // stored separately from non-tool responses (different TTLs).
  const toolSegment = hasToolCalls ? ":t:1" : "";
  return `ai:cache:${promptHash}:${historyHash}:${createHash("sha256").update(normalizedMessage).digest("hex").slice(0, 16)}${toolSegment}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface CacheEntry {
  response: string;
  model: string;
  provider: string;
  cachedAt: number;
  hitCount: number;
}

/**
 * Checks the cache for a matching response.
 *
 * Bug #4 fix: checks BOTH the non-tool key (long TTL) AND the tool-call
 * key (short TTL) for the same message. If both exist, the tool-call entry
 * is fresher (shorter TTL) so we prefer it — but only if it's still valid.
 * In practice, only one will exist per message (a given message either
 * triggered tools or it didn't), so the dual-check is just defensive.
 *
 * Returns the cached response if found, or null if not cached / cache
 * is disabled / the message is too short to cache / isPrivate is true.
 *
 * @param systemPrompt - The system prompt (used in cache key for invalidation)
 * @param history - Conversation history (last 3 messages used in key)
 * @param userMessage - The user's new message
 * @param isPrivate - If true, skip cache entirely (e.g. user is asking about their orders)
 */
export async function getCachedResponse(
  systemPrompt: string,
  history: { role: string; text: string }[],
  userMessage: string,
  isPrivate: boolean = false,
): Promise<CacheEntry | null> {
  // Don't cache private queries (order lookups, user-specific data)
  if (isPrivate) return null;

  // Don't cache very short messages (too generic)
  if (userMessage.trim().length < MIN_MESSAGE_LENGTH) return null;

  const redis = getRedis();
  if (!redis) return null; // cache disabled in dev

  try {
    // Bug #4 fix: check the non-tool key first (long TTL, more likely to
    // exist for general questions). If miss, check the tool-call key
    // (short TTL, exists for search_catalog responses).
    const nonToolKey = generateCacheKey(systemPrompt, history, userMessage, false);
    const toolKey = generateCacheKey(systemPrompt, history, userMessage, true);

    const [nonToolRaw, toolRaw] = await Promise.all([
      redis.get<string>(nonToolKey),
      redis.get<string>(toolKey),
    ]);

    // Prefer the tool-call entry if it exists (it's fresher — shorter TTL
    // means it was written more recently relative to any catalog changes).
    const raw = toolRaw ?? nonToolRaw;
    const key = toolRaw ? toolKey : nonToolKey;
    if (!raw) return null;

    const entry = JSON.parse(raw) as CacheEntry;

    // Increment hit count (fire-and-forget)
    entry.hitCount++;
    redis.set(key, JSON.stringify(entry), { ex: CACHE_TTL_SECONDS }).catch(() => {});

    logger.debug({ key, model: entry.model, hitCount: entry.hitCount, hadToolCalls: !!toolRaw }, "AI cache: HIT");
    return entry;
  } catch (err) {
    logger.debug({ err }, "AI cache: get failed (non-fatal)");
    return null;
  }
}

/**
 * Stores a response in the cache.
 *
 * Bug #4 fix: the `hadToolCalls` parameter now controls the TTL, not whether
 * to cache at all:
 *   - `hadToolCalls = false` (default) → long TTL (1 hour). For general
 *     plant-care questions with no tool calls.
 *   - `hadToolCalls = true` → short TTL (5 min, configurable via
 *     AI_TOOL_CACHE_TTL_SECONDS). For search_catalog / get_product_care
 *     responses where the data is public but changes (prices, availability).
 *     If AI_TOOL_CACHE_TTL_SECONDS = 0, skip caching entirely.
 *   - `isPrivate = true` → NEVER cache. For get_user_orders / get_order_details
 *     responses (user-scoped data).
 *
 * The cache key includes a `:t:1` segment for tool-call responses so they
 * don't collide with non-tool responses (which have a different TTL).
 *
 * @param systemPrompt - The system prompt
 * @param history - Conversation history
 * @param userMessage - The user's message
 * @param response - The AI's full response text
 * @param model - The model that generated the response
 * @param provider - The provider ("gemini" or "groq")
 * @param hadToolCalls - If true, use short TTL (catalog data changes)
 * @param isPrivate - If true, don't cache at all (user-specific data)
 */
export async function setCachedResponse(
  systemPrompt: string,
  history: { role: string; text: string }[],
  userMessage: string,
  response: string,
  model: string,
  provider: string,
  hadToolCalls: boolean = false,
  isPrivate: boolean = false,
): Promise<void> {
  // Never cache private queries (user-scoped tool data, order lookups).
  if (isPrivate) return;

  // Bug #4 fix: if tool calls happened AND the tool-cache TTL is 0, skip
  // caching entirely (admin configured maximum freshness).
  if (hadToolCalls && TOOL_CACHE_TTL_SECONDS <= 0) return;

  // Don't cache very short messages
  if (userMessage.trim().length < MIN_MESSAGE_LENGTH) return;

  // Don't cache very long responses (would consume too much Redis memory)
  if (response.length > 10_000) return;

  const redis = getRedis();
  if (!redis) return;

  try {
    const key = generateCacheKey(systemPrompt, history, userMessage, hadToolCalls);
    const ttl = hadToolCalls ? TOOL_CACHE_TTL_SECONDS : CACHE_TTL_SECONDS;
    const entry: CacheEntry = {
      response,
      model,
      provider,
      cachedAt: Date.now(),
      hitCount: 0,
    };
    await redis.set(key, JSON.stringify(entry), { ex: ttl });
    logger.debug({ key, model, provider, ttl, hadToolCalls }, "AI cache: SET");
  } catch (err) {
    logger.debug({ err }, "AI cache: set failed (non-fatal)");
  }
}

/**
 * Clears all cached AI responses. Used by the admin cache-clear endpoint.
 */
export async function clearAiCache(): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;

  try {
    let cursor = "0";
    let deleted = 0;
    do {
      const [next, keys] = await redis.scan(cursor, { match: "ai:cache:*", count: 100 });
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== "0");
    logger.info({ deleted }, "AI cache: cleared all entries");
    return deleted;
  } catch (err) {
    logger.error({ err }, "AI cache: clear failed");
    return 0;
  }
}

/**
 * Returns cache statistics for the admin endpoint.
 */
export async function getCacheStats(): Promise<{
  enabled: boolean;
  ttlSeconds: number;
  entryCount: number;
}> {
  const redis = getRedis();
  if (!redis) {
    return { enabled: false, ttlSeconds: CACHE_TTL_SECONDS, entryCount: 0 };
  }

  try {
    let cursor = "0";
    let count = 0;
    do {
      const [next, keys] = await redis.scan(cursor, { match: "ai:cache:*", count: 100 });
      cursor = next;
      count += keys.length;
    } while (cursor !== "0");

    return { enabled: true, ttlSeconds: CACHE_TTL_SECONDS, entryCount: count };
  } catch {
    return { enabled: true, ttlSeconds: CACHE_TTL_SECONDS, entryCount: 0 };
  }
}
