/**
 * KB cache invalidation — thin wrapper around `invalidateCatalogCache`.
 *
 * ─── Why this file exists (BUG-1 fix) ────────────────────────────────────────
 *
 * The chatbot's system prompt template (`lib/aiContext.ts`) interpolates
 * dynamic blocks into the persona header:
 *
 *   {{summary}}{{knowledge}}{{catalog}}{{tone}}
 *
 * The `{{knowledge}}` block is auto-injected from the Knowledge Base on
 * every chat request via `getTopKbEntriesForPrompt()`. So whenever an
 * admin edits any KB content (entries / creators / sources / categories),
 * the system prompt for the next chat changes — but cached responses
 * built from the OLD KB content would still be served for up to 1 hour
 * (the cache TTL).
 *
 * The fix: every KB mutation route in `routes/aiAdmin.ts` calls
 * `invalidateKbCache(reason)` AFTER the DB write succeeds, fire-and-forget.
 *
 * ─── What gets invalidated ───────────────────────────────────────────────────
 *
 * Delegates to `invalidateCatalogCache()` which flushes three layers:
 *
 *   1. Redis exact-match cache (`ai:cache:*` — all keys, not just tool)
 *   2. Postgres pgvector semantic cache (`ai_response_cache` — all rows)
 *   3. Reranker cache (L1 LRU + L2 Redis via `clearAllRerankCache`)
 *
 * What is NOT cleared:
 *   - `queryEmbeddingCache` — query embeddings are deterministic per
 *     query (doc-independent); clearing them just wastes an LLM call.
 *   - `ai_kb_entries.embedding` column — doc embeddings are regenerated
 *     by the background `kbEmbeddingJob` (separate pipeline).
 *
 * ─── Best-effort, fire-and-forget ────────────────────────────────────────────
 *
 * `invalidateCatalogCache` is internally best-effort (each layer in its
 * own try/catch, never throws). This wrapper adds an outer safety net so
 * an unexpected throw cannot roll back the user-facing mutation response
 * (the DB write has already committed by the time this runs).
 *
 * ─── Why a wrapper? ──────────────────────────────────────────────────────────
 *
 * Today the wrapper just forwards to `invalidateCatalogCache`. The
 * dedicated function exists so future KB-specific invalidation logic
 * (e.g. targeted entry-level invalidation, version counters, tag-based
 * flushing) can be added in ONE place without touching every call site
 * in `aiAdmin.ts`.
 */
import { invalidateCatalogCache } from "./catalogCache";
import { logger } from "./logger";

/**
 * Invalidate all AI chat caches after a Knowledge Base mutation.
 *
 * Call this AFTER the DB mutation has committed, fire-and-forget is
 * acceptable. Never call this BEFORE the DB write — a failed write
 * would leave caches empty for no reason (the data didn't actually
 * change).
 *
 * @param reason - human-readable label for audit logging.
 *                 Examples: "entry.update", "creator.tone.regen",
 *                 "source.batch-entries", "category.move".
 */
export async function invalidateKbCache(reason: string): Promise<void> {
  try {
    await invalidateCatalogCache(`kb:${reason}`);
    logger.info({ reason }, "KB cache: invalidated after mutation");
  } catch (err) {
    // invalidateCatalogCache is internally best-effort, but defend
    // against unexpected throws so a Redis/pgvector outage cannot
    // crash the admin request that triggered the mutation.
    logger.error(
      { err, reason },
      "KB cache: invalidation failed (stale answers may be served until TTL expiry)",
    );
  }
}
