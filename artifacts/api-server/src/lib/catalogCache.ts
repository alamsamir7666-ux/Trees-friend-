/**
 * Catalog cache invalidation — fires when product/seller-listing data mutates.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 *
 * The AI chat has TWO caches (see semanticCache.ts + embeddingCache.ts):
 *
 *   1. Exact-match cache (Redis): keyed by hash(systemPrompt + history + msg).
 *      Tool-call responses are stored under a `:t:1` suffix (Bug #4 fix) so
 *      they don't collide with non-tool responses (different TTLs).
 *
 *   2. Semantic cache (Postgres `ai_response_cache` w/ pgvector): catches
 *      paraphrased queries via embedding similarity. Tool-call responses
 *      have `had_tool_calls = TRUE` (Bug #4 fix) and use a shorter TTL
 *      (default 5 min, via AI_TOOL_CACHE_TTL_SECONDS).
 *
 * Both caches were previously "TTL-only" — there was no event-driven
 * invalidation when the catalog actually changed. That meant:
 *
 *   - A seller updates a price → AI keeps serving the OLD price for up to
 *     5 min (the tool-call TTL).
 *   - An admin approves a new listing → AI keeps saying "not available"
 *     for up to 5 min.
 *   - An admin deletes a product → AI keeps recommending it for up to 5 min.
 *
 * 5 min of staleness is acceptable for cost optimization (re-calling the
 * LLM on every query would be expensive), but it's strictly better to
 * invalidate on known mutations. This module wires those mutations to
 * the cache.
 *
 * ─── Industry-standard pattern ───────────────────────────────────────────────
 *
 *   - Vercel AI SDK: tag-based cache invalidation (`revalidateTag`).
 *   - OpenAI Assistants: cache invalidated on file/code_interpreter changes.
 *   - Anthropic prompt cache: invalidated when prompt prefix changes.
 *
 * Our approach is the same idea: a "tag" (`catalog`) covers all cache
 * entries derived from product/seller-listing data. When that data
 * mutates, we invalidate the tag.
 *
 * Concretely:
 *   - Redis (exact-match): delete all keys matching `ai:cache:*:t:1`
 *     (the tool-call entries — the only ones that contain live catalog data;
 *     non-tool entries don't reference the catalog so they're safe to keep).
 *   - Postgres (semantic): delete rows from `ai_response_cache` where
 *     `had_tool_calls = TRUE` (same rationale).
 *
 * We do NOT clear non-tool cache entries because they contain general
 * botanical knowledge ("how often to water mango") that doesn't depend
 * on the catalog. Clearing them would force unnecessary re-computation.
 *
 * ─── Best-effort, non-blocking ───────────────────────────────────────────────
 *
 * Invalidation is fired `.catch(() => {})` from the route handlers. The
 * DB write has already succeeded by the time we invalidate — failing to
 * invalidate is NOT a correctness issue, it just means the AI serves a
 * slightly stale response for up to 5 min (the TTL). That's acceptable.
 */
import { getRedis } from "./redisClient";
import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * The Redis key suffix used by semanticCache.ts to mark tool-call entries
 * (the ones that contain live catalog data). Kept in sync here so we can
 * target them for invalidation without depending on the internal format.
 *
 * If semanticCache.ts changes this suffix, update it here too.
 */
const TOOL_CALL_KEY_SUFFIX = ":t:1";

/**
 * Scan batch size for Redis SCAN. Larger = fewer round-trips but more
 * memory per batch. 100 is the documented sweet spot for Redis SCAN.
 */
const REDIS_SCAN_BATCH = 100;

/**
 * Invalidate all catalog-derived AI cache entries.
 *
 * Call this whenever product or seller-listing data mutates:
 *   - POST /products (create)
 *   - PUT /products/:id (update)
 *   - DELETE /products/:id (soft delete)
 *   - POST /products/:id/duplicate (create)
 *   - POST /seller-listings (create)
 *   - PUT /seller-listings/:id (update — price/stock/etc.)
 *   - DELETE /seller-listings/:id (delete)
 *   - PUT /admin/seller-listings/:id/approve (goes live)
 *   - PUT /admin/seller-listings/:id/reject (no longer live)
 *
 * @param reason - Short label for the log (e.g. "product.update", "seller_listing.create").
 *                 Not used for filtering — all catalog entries are invalidated.
 */
export async function invalidateCatalogCache(reason: string = "catalog.mutation"): Promise<void> {
  // Fire both invalidations in parallel — they target independent stores.
  const [redisDeleted, pgDeleted] = await Promise.allSettled([
    invalidateRedisCatalogCache(),
    invalidateSemanticCatalogCache(),
  ]);

  const redisCount = redisDeleted.status === "fulfilled" ? redisDeleted.value : 0;
  const pgCount = pgDeleted.status === "fulfilled" ? pgDeleted.value : 0;

  if (redisDeleted.status === "rejected") {
    logger.debug(
      { err: (redisDeleted.reason as any)?.message ?? String(redisDeleted.reason), reason },
      "catalogCache: Redis invalidation failed (non-fatal — TTL will expire stale entries)",
    );
  }
  if (pgDeleted.status === "rejected") {
    logger.debug(
      { err: (pgDeleted.reason as any)?.message ?? String(pgDeleted.reason), reason },
      "catalogCache: Semantic cache invalidation failed (non-fatal — TTL will expire stale entries)",
    );
  }

  // Only log at INFO level if we actually invalidated something — keeps the
  // logs clean when Redis isn't configured (dev) or pgvector isn't available.
  if (redisCount > 0 || pgCount > 0) {
    logger.info(
      { reason, redisDeleted: redisCount, semanticDeleted: pgCount },
      "catalogCache: invalidated catalog-derived AI cache entries",
    );
  }
}

/**
 * Deletes all Redis exact-match cache entries that contain tool-call
 * responses (the `:t:1` suffix). These are the entries that embed live
 * catalog data (search_catalog results, get_product_care results).
 *
 * Non-tool entries (no `:t:1` suffix) are NOT deleted — they contain
 * general botanical knowledge that doesn't depend on the catalog.
 *
 * Returns the number of keys deleted.
 */
async function invalidateRedisCatalogCache(): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;

  let cursor = "0";
  let deleted = 0;
  do {
    // SCAN for all AI cache keys (we'll filter by suffix below — Redis SCAN
    // MATCH doesn't support suffix matching directly, only glob patterns).
    const [next, keys] = await redis.scan(cursor, {
      match: "ai:cache:*",
      count: REDIS_SCAN_BATCH,
    });
    cursor = next;

    // Filter to only tool-call entries (the ones with the `:t:1` suffix).
    const toolKeys = keys.filter((k) => k.endsWith(TOOL_CALL_KEY_SUFFIX));
    if (toolKeys.length > 0) {
      await redis.del(...toolKeys);
      deleted += toolKeys.length;
    }
  } while (cursor !== "0");

  return deleted;
}

/**
 * Deletes semantic cache entries (Postgres `ai_response_cache` rows) that
 * contain tool-call responses — the ones with `had_tool_calls = TRUE`.
 *
 * Non-tool entries (had_tool_calls = FALSE or NULL) are NOT deleted —
 * they contain general botanical knowledge that doesn't depend on the
 * catalog.
 *
 * Returns the number of rows deleted.
 */
async function invalidateSemanticCatalogCache(): Promise<number> {
  try {
    const result = await pool.query(
      `DELETE FROM ai_response_cache WHERE had_tool_calls = TRUE`,
    );
    return result.rowCount ?? 0;
  } catch (err) {
    // Common causes:
    //   - Table doesn't exist (ensureAiTables migration hasn't run yet)
    //   - pgvector extension missing (no semantic cache at all)
    //   - had_tool_calls column missing (older schema)
    // All are non-fatal — the TTL will expire stale entries.
    const msg = (err as any)?.message ?? String(err);
    if (
      msg.includes("does not exist") ||
      msg.includes("column") ||
      msg.includes("relation")
    ) {
      // Expected on legacy DBs — silent.
      return 0;
    }
    throw err;
  }
}
