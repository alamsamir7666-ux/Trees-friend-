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
 * Concretely (BUG-1 fix):
 *   - Redis (exact-match): delete ALL keys matching `ai:cache:*`.
 *     Every response (tool or non-tool) embeds dynamic blocks
 *     (`{{knowledge}}`, `{{catalog}}`, `{{tone}}`) that are derived from
 *     the catalog and KB. Keeping non-tool entries would serve stale
 *     answers whenever an admin edits a product or KB entry.
 *   - Postgres (semantic): DELETE FROM ai_response_cache (all rows).
 *     Same rationale.
 *   - Reranker cache (L1 LRU + L2 Redis): cleared via
 *     `clearAllRerankCache()` — rerank scores depend on doc text hashes
 *     which change when KB content changes.
 *
 * We do NOT clear `queryEmbeddingCache` — query embeddings are
 * deterministic per query (doc-independent); clearing them just wastes
 * an LLM call on the next request.
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
import { clearAllRerankCache } from "./rerankerCache";

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
 * BUG-1 fix: also called by `invalidateKbCache()` after every KB mutation
 * (entries / creators / sources / categories). The system prompt's
 * `{{knowledge}}` block is auto-injected from the KB on every chat, so a
 * stale KB entry would otherwise produce a stale cached response for up
 * to 1 hour.
 *
 * Flushes three layers, each best-effort in its own try/catch:
 *   1. Redis exact-match cache (all `ai:cache:*` keys)
 *   2. Postgres pgvector semantic cache (all `ai_response_cache` rows)
 *   3. Reranker cache (L1 LRU + L2 Redis via `clearAllRerankCache`)
 *
 * @param reason - Short label for the log (e.g. "product.update", "kb.entry.update").
 *                 Not used for filtering — all entries are invalidated.
 */
export async function invalidateCatalogCache(reason: string = "catalog.mutation"): Promise<void> {
  // Fire all three invalidations in parallel — they target independent stores.
  const [redisDeleted, pgDeleted, rerankDeleted] = await Promise.allSettled([
    invalidateRedisCatalogCache(),
    invalidateSemanticCatalogCache(),
    clearAllRerankCache(),
  ]);

  const redisCount = redisDeleted.status === "fulfilled" ? redisDeleted.value : 0;
  const pgCount = pgDeleted.status === "fulfilled" ? pgDeleted.value : 0;
  const rerankCount = rerankDeleted.status === "fulfilled" ? rerankDeleted.value : 0;

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
  if (rerankDeleted.status === "rejected") {
    logger.debug(
      { err: (rerankDeleted.reason as any)?.message ?? String(rerankDeleted.reason), reason },
      "catalogCache: Reranker cache invalidation failed (non-fatal)",
    );
  }

  // Only log at INFO level if we actually invalidated something — keeps the
  // logs clean when Redis isn't configured (dev) or pgvector isn't available.
  if (redisCount > 0 || pgCount > 0 || rerankCount > 0) {
    logger.info(
      { reason, redisDeleted: redisCount, semanticDeleted: pgCount, rerankDeleted: rerankCount },
      "catalogCache: invalidated catalog-derived AI cache entries",
    );
  }
}

/**
 * Deletes ALL Redis exact-match cache entries (every key matching
 * `ai:cache:*`).
 *
 * BUG-1 fix: previously this only cleared tool-call entries (those ending
 * in `:t:1`). That was wrong — non-tool responses also embed `{{catalog}}`,
 * `{{knowledge}}`, and `{{tone}}` blocks via auto-injection, so they go
 * stale on any catalog or KB mutation. We now clear everything.
 *
 * Returns the number of keys deleted.
 */
async function invalidateRedisCatalogCache(): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;

  let cursor = "0";
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, {
      match: "ai:cache:*",
      count: REDIS_SCAN_BATCH,
    });
    cursor = next;
    if (keys.length > 0) {
      await redis.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== "0");

  return deleted;
}

/**
 * Deletes ALL semantic cache entries (every row in `ai_response_cache`).
 *
 * BUG-1 fix: previously this only cleared rows with `had_tool_calls = TRUE`.
 * That was wrong — non-tool responses also embed catalog/KB/tone blocks
 * via auto-injection and go stale on any mutation. We now clear all rows.
 *
 * The `had_tool_calls` column is preserved (still useful for analytics and
 * for the TTL-aware SELECT in `embeddingCache.ts`); we just no longer
 * filter on it during invalidation.
 *
 * Returns the number of rows deleted.
 */
async function invalidateSemanticCatalogCache(): Promise<number> {
  try {
    const result = await pool.query(`DELETE FROM ai_response_cache`);
    return result.rowCount ?? 0;
  } catch (err) {
    // Common causes:
    //   - Table doesn't exist (ensureAiTables migration hasn't run yet)
    //   - pgvector extension missing (no semantic cache at all)
    // All are non-fatal — the TTL will expire stale entries.
    const msg = (err as any)?.message ?? String(err);
    if (msg.includes("does not exist") || msg.includes("relation")) {
      // Expected on legacy DBs — silent.
      return 0;
    }
    throw err;
  }
}
