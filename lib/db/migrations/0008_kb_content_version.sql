-- ─── Migration 0008: Add kb_content_version column to ai_response_cache ──────
--
-- BUG-3 fix: the semantic cache previously had no fingerprint of the KB
-- state used to build each cached response. After a KB mutation, even with
-- event-driven invalidation (BUG-1 fix via invalidateKbCache()), there was
-- a race window where a concurrent in-flight request could repopulate the
-- cache with content built from old KB state:
--
--   T=0  Request A reads KB entries (old content), starts LLM call.
--   T=1  Admin edits KB entry. invalidateKbCache() deletes all rows in
--        ai_response_cache.
--   T=2  Request A's LLM call returns (built from OLD KB content).
--   T=3  Request A writes its response to ai_response_cache.
--   T=4  Request B (after edit) finds Request A's cached response by
--        embedding similarity > 0.92 — gets the OLD answer.
--
-- The kb_content_version column lets the lookup query reject stale rows
-- at SELECT time, eliminating the race. The version is computed per
-- request as sha1 of all KB entry IDs + their updated_at timestamps +
-- their is_active flags, hex-encoded and truncated to 16 chars. It
-- changes whenever any active entry is created, updated, deleted,
-- activated, or deactivated.
--
-- Nullable: existing rows have NULL. NULL is treated as "version unknown"
-- and is excluded from cache hits (forcing a fresh LLM call + a new
-- versioned row to be written). After TTL expiry (1h max) all NULL rows
-- are gone — no manual backfill needed.
--
-- ─── Safety ──────────────────────────────────────────────────────────────────
--
-- All statements are idempotent (IF NOT EXISTS). Safe to run on a live DB.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Add the kb_content_version column (nullable for back-compat).
ALTER TABLE ai_response_cache
  ADD COLUMN IF NOT EXISTS kb_content_version TEXT;

-- 2. Partial index: only rows with a non-NULL version are eligible for
--    cache hits. NULL rows exist only as legacy data and are skipped at
--    lookup time (the WHERE clause `kb_content_version = $N` excludes
--    NULLs because NULL = anything is NULL in SQL, not TRUE).
CREATE INDEX IF NOT EXISTS ai_response_cache_kb_version_idx
  ON ai_response_cache (kb_content_version)
  WHERE kb_content_version IS NOT NULL;

-- 3. No backfill is needed. NULL rows simply won't be cache hits, which
--    is correct (we don't know what KB state they were built from).
--    They'll expire via TTL (1h max) and be replaced by versioned rows.
