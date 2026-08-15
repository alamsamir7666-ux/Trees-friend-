# Summary — BUG-3 + BUG-K19 Fix

## Problem

Two interconnected bugs in the Trees-friend monorepo:

1. **BUG-3** — The pgvector semantic cache (`ai_response_cache` table) had
   no KB-content fingerprint. Even after BUG-1's `invalidateKbCache()`
   cleared the cache, there was a race window where a concurrent
   in-flight request could re-cache a response built from old KB content,
   and a later request would find it by embedding similarity.

2. **BUG-K19** — The PostgreSQL trigger `ai_kb_entries_bm25_doclength_trigger`
   fired BEFORE `ai_kb_entries_search_tsvector_trigger` due to alphabetical
   name ordering (`bm25_...` < `search_...`). On INSERT, the doc-length
   trigger read `NEW.search_tsvector` which was NULL → `bm25_doc_length = 0`
   forever for new rows. This broke BM25 length normalization — fresh
   entries scored artificially high.

## Files Changed

| File                                                            | Status   | Description                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/db/migrations/0008_kb_content_version.sql`                 | **New**  | BUG-3: ALTER TABLE adds `kb_content_version TEXT` (nullable) + partial index.                                                                                                                                                                                                                   |
| `lib/db/migrations/0009_bm25_trigger_order_fix.sql`             | **New**  | BUG-K19: drops buggy trigger, recreates as `zz_ai_kb_entries_bm25_doclength_trigger` (sorts AFTER `ai_kb_entries_search_tsvector_trigger`), backfills `bm25_doc_length` for existing rows, refreshes BM25 term stats.                                                                           |
| `lib/db/migrations/meta/_journal.json`                          | Modified | Added entries for migrations 0008 and 0009.                                                                                                                                                                                                                                                     |
| `lib/db/src/schema/aiChat.ts`                                   | Modified | Declares the `aiResponseCacheTable` Drizzle schema (was missing — table was only managed via raw SQL in `ensureAiTables.ts`) with the new `kbContentVersion` column.                                                                                                                            |
| `artifacts/api-server/src/lib/kbContentVersion.ts`              | **New**  | `getKbContentVersion()` computes a 16-char hex sha1 of all KB entry IDs + updated_at + is_active. Cached in-process for 5s. Returns `"unknown"` on DB error (fail-safe).                                                                                                                        |
| `artifacts/api-server/src/lib/kbCache.ts`                       | Modified | Calls `clearKbContentVersionCache()` BEFORE `invalidateCatalogCache()` so the next request recomputes the version from updated DB state.                                                                                                                                                        |
| `artifacts/api-server/src/lib/embeddingCache.ts`                | Modified | `getSemanticCachedResponse` + `setSemanticCachedResponse` signatures now accept `kbContentVersion: string`. SQL filters `WHERE kb_content_version = $N` (NULL rows excluded — `NULL = anything` is NULL, not TRUE). INSERT stores the version. Cache write skipped when version is `"unknown"`. |
| `artifacts/api-server/src/lib/ensureAiTables.ts`                | Modified | Added `ALTER TABLE ai_response_cache ADD COLUMN IF NOT EXISTS kb_content_version TEXT` + partial index for fresh DBs (without migration history).                                                                                                                                               |
| `artifacts/api-server/src/routes/ai.ts`                         | Modified | Computes `kbContentVersion` before cache lookup; skips cache (both read + write) when version is `"unknown"`; passes version to both `getSemanticCachedResponse` and `setSemanticCachedResponse`.                                                                                               |
| `artifacts/api-server/test/kbContentVersion.test.ts`            | **New**  | 20 tests: source-shape + behavioral (mocked pool) — version format, in-process caching, clear-cache, different KB states produce different versions, fail-safe on DB error, activation/updated_at/deletion all change version.                                                                  |
| `artifacts/api-server/test/embeddingCacheVersion.test.ts`       | **New**  | 18 tests: SQL filter uses `=` not `IS NOT DISTINCT FROM`, signatures accept `kbContentVersion`, route computes version before lookup, route skips cache on `"unknown"`, route passes version to cache write.                                                                                    |
| `artifacts/api-server/test/ensureAiTablesVersionColumn.test.ts` | **New**  | 5 tests: CREATE TABLE/ALTER includes column + index, no backfill (NULL is correct), comments explain the fix.                                                                                                                                                                                   |
| `artifacts/api-server/test/bm25TriggerOrder.test.ts`            | **New**  | 26 tests: migration drops buggy trigger, creates `zz_`-prefixed trigger, backfills `bm25_doc_length`, calls `refresh_kb_term_stats`, migration 0007 unmodified, journal includes 0009, idempotent.                                                                                              |

## Architecture Decisions

1. **Content-Addressable Cache with Version Fingerprint** (Anthropic
   prompt-cache pattern) — every cached row stores a 16-char hex sha1
   of `(id, updated_at, is_active)` for all active KB entries. Lookup
   filters `WHERE kb_content_version = $N` so stale rows are rejected
   at SELECT time, eliminating the race.

2. **Fail-Safe Cache Bypass** — when `getKbContentVersion()` returns
   `"unknown"` (DB error), the route bypasses the semantic cache
   entirely (neither reads nor writes). Safer to miss the cache than
   risk serving stale content.

3. **Two-Layer Invalidation** — `invalidateKbCache()` now clears the
   in-process version cache FIRST (so the next request recomputes from
   updated DB state), then calls `invalidateCatalogCache()` to flush
   Redis + pgvector + reranker caches. Order matters: clearing the
   version cache after the catalog cache would let a concurrent request
   read the stale versioned cache during the invalidation window.

4. **Trigger Rename (Approach 1)** — the BM25 trigger was renamed from
   `ai_kb_entries_bm25_doclength_trigger` to
   `zz_ai_kb_entries_bm25_doclength_trigger` so it sorts AFTER
   `ai_kb_entries_search_tsvector_trigger` (PostgreSQL fires BEFORE
   triggers in alphabetical name order). Migration 0007 is NOT modified
   (already shipped).

5. **What is NOT changed** — `queryEmbeddingCache` (query embeddings are
   deterministic per query, doc-independent), `ai_kb_entries.embedding`
   column (regenerated by background `kbEmbeddingJob`), `had_tool_calls`
   column (still used for TTL-aware filtering).

## Test Results

- **New tests**: 69/69 passing across 4 new test files.
- **Existing tests**: 125/125 BUG-1 + related source-shape tests still pass.
  KB-related tests: 375/378 pass — the 3 failures in `kbToneProfiles.test.ts`
  are pre-existing (verified via `git stash` baseline run).
- **Typecheck**: `pnpm typecheck` (api-server) + `pnpm typecheck:test`
  - `pnpm typecheck:libs` all pass with zero errors.
- **Lint**: 0 errors on modified files (12 warnings, all `any` types in
  error-access patterns consistent with the existing codebase).
