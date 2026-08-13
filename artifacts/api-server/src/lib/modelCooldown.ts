/**
 * Distributed per-model cooldown (Redis-backed).
 *
 * Replaces the in-memory `_modelCooldowns` Map that was in groq.ts and
 * gemini.ts. On multi-instance deployments (Vercel serverless, Render
 * with multiple workers), an in-memory Map is broken — each instance
 * has its own cooldown state, so instance A doesn't know that instance
 * B already got a 429 from the same model.
 *
 * This module uses Redis for distributed coordination. When any instance
 * gets a 429 from a model, it sets a cooldown key in Redis. ALL instances
 * check Redis before trying a model, so they all skip the cooldown period.
 *
 * Distinction from the circuit breaker:
 *   - Cooldown: immediate 60s skip after a SINGLE 429 (fast response to
 *     quota exhaustion). Lightweight — just a Redis key with TTL.
 *   - Circuit breaker: opens after N failures in a window (protects
 *     against cascading failures). Heavier — tracks failure history.
 *
 * Both are needed:
 *   - Cooldown is the first line of defense (immediate skip on 429)
 *   - Circuit breaker is the second line (sustained failure detection)
 *
 * Redis keys:
 *   ai:cd:{provider}:{model}  — exists = on cooldown, TTL = remaining seconds
 *
 * Fallback:
 *   If Redis is not configured, falls back to in-memory Map (dev only).
 *   Logs a warning in production.
 */
import { getRedis } from "./redisClient";
import { logger } from "./logger";

const COOLDOWN_MS = Number(process.env.AI_QUOTA_COOLDOWN_MS ?? 60_000);

// ─── In-memory fallback (dev only) ──────────────────────────────────────────

const _inMemoryCooldowns = new Map<string, number>(); // key -> cooldown-until-ms

function inMemoryKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

function isInMemoryOnCooldown(provider: string, model: string): boolean {
  const key = inMemoryKey(provider, model);
  const until = _inMemoryCooldowns.get(key);
  if (!until) return false;
  if (Date.now() >= until) {
    _inMemoryCooldowns.delete(key);
    return false;
  }
  return true;
}

function setInMemoryCooldown(provider: string, model: string): void {
  _inMemoryCooldowns.set(inMemoryKey(provider, model), Date.now() + COOLDOWN_MS);
}

function clearInMemoryCooldowns(): void {
  _inMemoryCooldowns.clear();
}

// ─── Redis-backed cooldown ──────────────────────────────────────────────────

function redisKey(provider: string, model: string): string {
  return `ai:cd:${provider}:${model}`;
}

/**
 * Checks if a model is on cooldown (should be skipped).
 *
 * Returns true if the model received a 429 recently and should not be
 * tried. Returns false if the model is available (or Redis is down —
 * fail open, better to try than to block all traffic).
 */
export async function isOnCooldown(provider: string, model: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    return isInMemoryOnCooldown(provider, model);
  }

  try {
    const exists = await redis.exists(redisKey(provider, model));
    return exists > 0;
  } catch (err) {
    // Redis error → fail open (don't block traffic)
    logger.warn({ err, provider, model }, "Cooldown: Redis error, failing open");
    return false;
  }
}

/**
 * Sets a cooldown on a model (after it returned 429).
 *
 * The cooldown lasts AI_QUOTA_COOLDOWN_MS (default 60s). During this
 * period, all instances will skip this model.
 */
export async function setCooldown(provider: string, model: string): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    setInMemoryCooldown(provider, model);
    return;
  }

  try {
    // Redis SET with EX (seconds) + NX (only set if not exists, though
    // we actually want to overwrite with a fresh TTL, so no NX).
    // Round up to the nearest second (Redis EX is integer seconds).
    const ttlSeconds = Math.ceil(COOLDOWN_MS / 1000);
    await redis.set(redisKey(provider, model), String(Date.now()), { ex: ttlSeconds });
  } catch (err) {
    // Redis error → fall back to in-memory so THIS instance at least skips
    logger.warn({ err, provider, model }, "Cooldown: Redis error, using in-memory fallback");
    setInMemoryCooldown(provider, model);
  }
}

/**
 * Returns the remaining cooldown time in ms, or 0 if not on cooldown.
 * Used by the admin debug endpoint.
 */
export async function getCooldownRemaining(
  provider: string,
  model: string,
): Promise<number> {
  const redis = getRedis();
  if (!redis) {
    const key = inMemoryKey(provider, model);
    const until = _inMemoryCooldowns.get(key);
    if (!until) return 0;
    return Math.max(0, until - Date.now());
  }

  try {
    const ttl = await redis.ttl(redisKey(provider, model));
    if (ttl <= 0) return 0;
    return ttl * 1000;
  } catch {
    return 0;
  }
}

/**
 * Clears all cooldowns. Used by the admin refresh endpoint.
 */
export async function clearAllCooldowns(): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    clearInMemoryCooldowns();
    return;
  }

  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, { match: "ai:cd:*", count: 100 });
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  } catch {
    // non-fatal
  }
  clearInMemoryCooldowns();
}

/**
 * Returns debug info about all cooldowns. Used by the admin endpoint.
 */
export async function getCooldownsDebugInfo(): Promise<{
  enabled: boolean;
  cooldownMs: number;
  activeCooldowns: { provider: string; model: string; remainingMs: number }[];
}> {
  const redis = getRedis();

  if (!redis) {
    const now = Date.now();
    const activeCooldowns: { provider: string; model: string; remainingMs: number }[] = [];
    for (const [key, until] of _inMemoryCooldowns.entries()) {
      const remaining = until - now;
      if (remaining > 0) {
        const [provider, model] = key.split(":");
        activeCooldowns.push({ provider, model, remainingMs: remaining });
      }
    }
    return { enabled: false, cooldownMs: COOLDOWN_MS, activeCooldowns };
  }

  try {
    const activeCooldowns: { provider: string; model: string; remainingMs: number }[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, { match: "ai:cd:*", count: 100 });
      cursor = next;
      for (const key of keys) {
        // Parse provider:model from "ai:cd:{provider}:{model}"
        const parts = key.split(":");
        if (parts.length >= 4) {
          const provider = parts[2];
          const model = parts.slice(3).join(":"); // handle model names with colons
          const ttl = await redis.ttl(key);
          if (ttl > 0) {
            activeCooldowns.push({ provider, model, remainingMs: ttl * 1000 });
          }
        }
      }
    } while (cursor !== "0");

    return { enabled: true, cooldownMs: COOLDOWN_MS, activeCooldowns };
  } catch {
    return { enabled: true, cooldownMs: COOLDOWN_MS, activeCooldowns: [] };
  }
}
