/**
 * KB content version — a fingerprint of the currently-active KB state.
 *
 * Used by the semantic cache (BUG-3 fix) to reject stale cache rows at
 * SELECT time, eliminating the race window between event-driven
 * invalidation (BUG-1) and concurrent in-flight requests.
 *
 * ─── How it works ────────────────────────────────────────────────────────────
 *
 * P2 #10 fix: the version is now a Redis counter (integer) that gets
 * INCRemented on every KB mutation. This is faster than the previous
 * approach (full table scan + SHA-1 hash) — one Redis GET (~2ms) vs
 * one DB SELECT over all entries (~1ms for <10K entries, but scales
 * poorly with KB size).
 *
 * The counter is stored at Redis key `ai:kb:version`. On every KB mutation
 * (entry create/update/delete/activate/deactivate), `invalidateKbCache()`
 * calls `incrementKbContentVersion()` which INCRs the counter.
 *
 * Fallback: if Redis is unavailable (dev environment, outage), the version
 * is computed via the original DB table scan + SHA-1 hash. This is the
 * fail-safe path — slower but correct.
 *
 * The version string format:
 *   - Redis counter path: `rN` where N is the counter value (e.g., `r42`).
 *     The `r` prefix distinguishes Redis-counter versions from DB-hash
 *     versions (which are 16-char hex strings). This is important for
 *     debugging — if a cache row has `kb_content_version = 'r42'`, we
 *     know it was built with the Redis counter; if it has a 16-char hex,
 *     it was built with the DB hash (legacy or Redis-unavailable fallback).
 *
 * ─── What triggers a version change ──────────────────────────────────────────
 *
 * The Redis counter increments whenever `invalidateKbCache()` is called
 * (after any KB mutation: entries / creators / sources / categories).
 * This covers:
 *   - An entry's content/title/keywords change (updated_at bumps)
 *   - An entry is created (new row)
 *   - An entry is deleted (row removed)
 *   - An entry is activated/deactivated (is_active flag flips)
 *
 * It does NOT change when:
 *   - A category is renamed (doesn't affect entry content)
 *   - A creator's tone_profile is regenerated (tone affects the system
 *     prompt but is tracked separately — see note in kbCache.ts)
 *   - A source's metadata is updated (entries inherit at creation, not live)
 *
 * ─── Caching ─────────────────────────────────────────────────────────────────
 *
 * The version is cached in-process for 5 seconds to avoid hitting Redis
 * on every chat request. The cache is cleared by
 * `clearKbContentVersionCache()` which is wired into `invalidateKbCache()`
 * (BUG-1 fix) so every KB mutation forces the next request to re-read.
 *
 * ─── Fail-safe ───────────────────────────────────────────────────────────────
 *
 * On Redis error: falls back to the DB table scan + SHA-1 hash (the
 * original approach). If THAT also fails (DB error), returns the sentinel
 * string "unknown". The route handler treats "unknown" as "bypass cache"
 * (neither read from nor write to the semantic cache). Safer to miss the
 * cache than serve stale content when we can't determine the KB version.
 *
 * ─── Performance ─────────────────────────────────────────────────────────────
 *
 * Redis GET: ~2ms (typical). Cached in-process for 5 seconds to avoid
 * re-querying on every chat request.
 *
 * DB table scan (fallback): ~1ms for <10K entries, but scales poorly with
 * KB size. Used only when Redis is unavailable.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { createHash } from "crypto";
// P2 #10 fix: use Redis counter instead of DB table scan.
import { getRedis } from "./redisClient";

const CACHE_TTL_MS = 5000; // 5 seconds — short, just to dedupe concurrent requests

/**
 * The Redis key for the KB content version counter.
 *
 * Stored as a simple integer (Redis string). INCR'd on every KB mutation
 * via `incrementKbContentVersion()`. Read by `getKbContentVersion()` on
 * every chat request (cached in-process for 5 seconds).
 */
const KB_VERSION_REDIS_KEY = "ai:kb:version";

/**
 * Sentinel value returned when the KB version can't be computed (Redis
 * AND DB both fail). Callers should treat this as "bypass cache" —
 * neither read from nor write to the semantic cache.
 */
export const KB_CONTENT_VERSION_UNKNOWN = "unknown";

let cachedVersion: { value: string; expiresAt: number } | null = null;

/**
 * Computes the current KB content version.
 *
 * P2 #10 fix: tries Redis counter FIRST (fast — ~2ms GET). If Redis is
 * unavailable or the key doesn't exist, falls back to the DB table scan
 * + SHA-1 hash (the original approach — slower but correct).
 *
 * Returns a version string:
 *   - Redis counter path: `rN` (e.g., `r42`).
 *   - DB hash fallback: 16-char hex string (e.g., `a1b2c3d4e5f6g7h8`).
 *   - Both fail: "unknown" (KB_CONTENT_VERSION_UNKNOWN).
 *
 * The version is cached in-process for 5 seconds to avoid re-querying
 * on every chat request.
 */
export async function getKbContentVersion(): Promise<string> {
  // L1 cache: avoid hitting Redis/DB on every chat request.
  if (cachedVersion && cachedVersion.expiresAt > Date.now()) {
    return cachedVersion.value;
  }

  // P2 #10: try Redis counter first (fast path).
  const redisVersion = await getKbContentVersionFromRedis();
  if (redisVersion !== null) {
    cachedVersion = { value: redisVersion, expiresAt: Date.now() + CACHE_TTL_MS };
    return redisVersion;
  }

  // Fallback: DB table scan + SHA-1 hash (original approach).
  const dbVersion = await getKbContentVersionFromDb();
  if (dbVersion !== null) {
    cachedVersion = { value: dbVersion, expiresAt: Date.now() + CACHE_TTL_MS };
    return dbVersion;
  }

  // Both failed — return "unknown" (bypass cache).
  return KB_CONTENT_VERSION_UNKNOWN;
}

/**
 * P2 #10 fix: reads the KB content version from the Redis counter.
 *
 * Returns the version string `rN` (where N is the counter value), or
 * null if Redis is unavailable, the key doesn't exist, or the read fails.
 *
 * The `r` prefix distinguishes Redis-counter versions from DB-hash
 * versions (16-char hex). This is useful for debugging — if a cache row
 * has `kb_content_version = 'r42'`, we know it was built with the Redis
 * counter; if it has a 16-char hex, it was built with the DB hash.
 *
 * @returns The version string (e.g., `r42`), or null if unavailable.
 */
async function getKbContentVersionFromRedis(): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;

  try {
    const counter = await redis.get(KB_VERSION_REDIS_KEY);
    if (counter === null) {
      // Key doesn't exist yet — no KB mutations have happened since the
      // Redis counter was introduced. Initialize it to 0 + return "r0".
      // This avoids the DB fallback on every subsequent request.
      // (The INCR on the next KB mutation will bump it to 1.)
      await redis.set(KB_VERSION_REDIS_KEY, "0");
      return "r0";
    }
    return `r${counter}`;
  } catch (err) {
    logger.debug(
      { err: (err as Error)?.message ?? String(err) },
      "KB content version: Redis counter read failed (falling back to DB hash)",
    );
    return null;
  }
}

/**
 * P2 #10 fix: fallback — computes the KB content version from the DB via
 * a full table scan + SHA-1 hash (the original approach).
 *
 * This is used when Redis is unavailable. It's slower (~1ms for <10K
 * entries, but scales poorly with KB size) but correct.
 *
 * Returns a 16-char hex string, or null if the DB query fails.
 */
async function getKbContentVersionFromDb(): Promise<string | null> {
  try {
    const result = await pool.query<{
      id: number;
      updated_at: Date;
      is_active: boolean;
    }>(
      `SELECT id, updated_at, is_active
       FROM ai_kb_entries
       ORDER BY id ASC`,
    );

    // Build a stable string representation: id:updated_at:is_active per
    // row, separated by newlines. updated_at is converted to ISO string
    // for stable stringification (PG timestamp -> JS Date -> ISO string
    // is deterministic).
    const input = result.rows
      .map((r) => `${r.id}:${r.updated_at.toISOString()}:${r.is_active ? 1 : 0}`)
      .join("\n");

    const version = createHash("sha1").update(input).digest("hex").slice(0, 16);
    return version;
  } catch (err) {
    // On DB error: log + return null (caller will return "unknown").
    logger.debug(
      { err: (err as any)?.message ?? String(err) },
      "KB content version: DB hash computation failed (returning 'unknown')",
    );
    return null;
  }
}

/**
 * P2 #10 fix: increments the Redis KB content version counter.
 *
 * Called by `invalidateKbCache()` after every KB mutation (entry
 * create/update/delete/activate/deactivate). The INCR is atomic —
 * concurrent mutations are safe (each gets a unique counter value).
 *
 * Best-effort: if Redis is unavailable, the counter is not incremented.
 * The next `getKbContentVersion()` call will fall back to the DB hash
 * (which will have a different value because the DB changed). The
 * semantic cache rows built with the OLD version will be rejected by
 * the `WHERE kb_content_version = $N` filter.
 *
 * Also clears the in-process cache (via `clearKbContentVersionCache()`)
 * so the next request reads the new counter value from Redis.
 *
 * @returns The new counter value (for logging), or null if Redis is unavailable.
 */
export async function incrementKbContentVersion(): Promise<number | null> {
  const redis = getRedis();
  if (!redis) return null;

  try {
    const newCounter = await redis.incr(KB_VERSION_REDIS_KEY);
    logger.info(
      { newCounter, key: KB_VERSION_REDIS_KEY },
      "KB content version: Redis counter incremented after KB mutation",
    );
    // Clear the in-process cache so the next request reads the new value.
    clearKbContentVersionCache();
    return newCounter;
  } catch (err) {
    logger.debug(
      { err: (err as Error)?.message ?? String(err) },
      "KB content version: Redis counter increment failed (non-fatal — DB hash fallback will be used)",
    );
    return null;
  }
}

/**
 * Clears the in-process cache of the KB content version.
 *
 * Call this after any KB mutation to force the next request to re-read
 * the version (otherwise it would use the stale 5-second-cached value).
 *
 * Wired into `invalidateKbCache()` (BUG-1 fix) so every KB mutation
 * clears both the response cache AND the version cache.
 *
 * P2 #10: also called by `incrementKbContentVersion()` after the Redis
 * counter is INCRemented.
 */
export function clearKbContentVersionCache(): void {
  cachedVersion = null;
}
