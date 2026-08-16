-- ─── Migration 0009: Fix BUG-K19 — BM25 doc_length trigger order is inverted ──
--
-- The trigger `ai_kb_entries_bm25_doclength_trigger` (migration 0007) was
-- named such that it sorts BEFORE `ai_kb_entries_search_tsvector_trigger`
-- (migration 0006) alphabetically: `bm25_...` < `search_...`. PostgreSQL
-- fires BEFORE triggers in alphabetical name order, so the doc-length
-- trigger fires FIRST and reads `NEW.search_tsvector` BEFORE the tsvector
-- trigger has populated it.
--
-- Result:
--   - On INSERT: NEW.search_tsvector is NULL → coalesce(NULL, 0) →
--     bm25_doc_length = 0 for every new row. Forever (until the row is
--     updated).
--   - On UPDATE of title/content: NEW.search_tsvector is the OLD tsvector
--     (UPDATE statement doesn't change it yet — the search_tsvector trigger
--     fires after this one and updates search_tsvector, but bm25_doc_length
--     was already computed from the stale value). Doc length lags one
--     update behind.
--
-- Effect on BM25 scoring:
--   - BM25 length normalization: 1 - b + b * (|D|/avgdl) becomes
--     1 - 0.75 + 0.75 * 0 = 0.25 for fresh entries.
--   - TF saturation term: tf * (k1+1) / (tf + k1 * 0.25) is INFLATED.
--   - Fresh entries rank artificially high. Bulk-imported sources have
--     ALL entries with bm25_doc_length = 0 → BM25 ranking is completely
--     broken for new content.
--
-- Fix (Approach 1 from the engineering brief — rename trigger):
--   1. Drop the buggy trigger + function.
--   2. Recreate the function (identical logic).
--   3. Recreate the trigger with a name that sorts AFTER
--      `ai_kb_entries_search_tsvector_trigger`. The `zz_` prefix
--      guarantees this: `zz_` > `ai_` in ASCII / UTF-8 collation.
--   4. Backfill bm25_doc_length for all existing rows (recompute from
--      the current search_tsvector). This fixes any rows that were
--      inserted with bm25_doc_length = 0 (i.e. all rows created since
--      migration 0007 was applied).
--   5. Refresh the BM25 term stats (avg_doc_length, total_docs) so the
--      bm25_score() function uses the corrected doc lengths.
--
-- Why rename (not merge into a single AFTER trigger)?
--   Modifying migration 0006 is forbidden — it's already shipped to
--   production. A new migration that only renames + recreates the
--   bm25 trigger is the smallest possible change. The `zz_` prefix is
--   ugly but explicit about intent: "this trigger must run LAST".
--
-- ─── Safety ──────────────────────────────────────────────────────────────────
--
-- All statements are idempotent (IF EXISTS / OR REPLACE) and safe to run
-- on a live DB. Cannot run inside a transaction (CONCURRENTLY not used
-- here, but the UPDATE backfill may be slow on huge tables — run with
-- autocommit). Apply each statement separately.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Drop the buggy trigger (named so it sorts BEFORE search_tsvector).
DROP TRIGGER IF EXISTS ai_kb_entries_bm25_doclength_trigger ON ai_kb_entries;

-- Drop the function too (we recreate it below with the same name + body).
-- DROP FUNCTION IF EXISTS is safe — if the function doesn't exist, no-op.
DROP FUNCTION IF EXISTS ai_kb_entries_bm25_doclength_update();

-- 2. Recreate the function with the SAME logic but an explicit comment
--    explaining the trigger-ordering requirement.
CREATE OR REPLACE FUNCTION ai_kb_entries_bm25_doclength_update() RETURNS trigger AS $$
BEGIN
  -- Recompute the doc length whenever the search_tsvector changes.
  --
  -- IMPORTANT (BUG-K19 fix): this trigger must fire AFTER
  -- ai_kb_entries_search_tsvector_trigger (migration 0006) so that
  -- NEW.search_tsvector is already populated when we read it.
  -- PostgreSQL fires BEFORE triggers in alphabetical name order, so
  -- we name this trigger `zz_ai_kb_entries_bm25_doclength_trigger`
  -- to sort AFTER `ai_kb_entries_search_tsvector_trigger`
  -- (ASCII: 'z' > 'a', so 'zz_...' > 'ai_...').
  --
  -- The original buggy name `ai_kb_entries_bm25_doclength_trigger`
  -- sorted BEFORE `ai_kb_entries_search_tsvector_trigger` because
  -- 'b' < 's', so it read NEW.search_tsvector before the tsvector
  -- trigger populated it — resulting in bm25_doc_length = 0 for all
  -- new rows.
  NEW.bm25_doc_length := coalesce(
    (SELECT count(*) FROM unnest(NEW.search_tsvector)),
    0
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 3. Recreate the trigger with the new name (sorts AFTER search_tsvector_trigger).
--    DROP first so the migration is idempotent — CREATE TRIGGER doesn't
--    support OR REPLACE safely across PG versions, so we always DROP IF
--    EXISTS before CREATE.
DROP TRIGGER IF EXISTS zz_ai_kb_entries_bm25_doclength_trigger ON ai_kb_entries;
CREATE TRIGGER zz_ai_kb_entries_bm25_doclength_trigger
  BEFORE INSERT OR UPDATE OF title, content
  ON ai_kb_entries
  FOR EACH ROW
  EXECUTE FUNCTION ai_kb_entries_bm25_doclength_update();

-- 4. Backfill: recompute bm25_doc_length for all existing rows.
--    This is idempotent (WHERE search_tsvector IS NOT NULL is always true
--    for rows that have content) and safe to run multiple times.
--    Rows with empty tsvectors (no lexemes) get bm25_doc_length = 0,
--    which is correct (an empty doc has zero length).
UPDATE ai_kb_entries
SET bm25_doc_length = coalesce(
  (SELECT count(*) FROM unnest(search_tsvector)),
  0
)
WHERE search_tsvector IS NOT NULL;

-- 5. Refresh the BM25 term stats (avg_doc_length, total_docs) so bm25_score()
--    uses the corrected doc lengths. The refresh function is defined in
--    migration 0007; if for some reason it doesn't exist (partial migration
--    apply), the SELECT-WHERE-EXISTS guard makes this a no-op.
SELECT refresh_kb_term_stats() WHERE EXISTS (
  SELECT 1 FROM pg_proc WHERE proname = 'refresh_kb_term_stats'
);

-- 6. Verification query (NOT asserted by the migration — for operator inspection).
--    Run after migration to confirm rows now have non-zero bm25_doc_length:
--
--      SELECT COUNT(*) FILTER (WHERE bm25_doc_length = 0) AS zero_count,
--             COUNT(*) AS total
--      FROM ai_kb_entries
--      WHERE search_tsvector IS NOT NULL;
--
--    Expected: zero_count = 0 (or very small if any rows have empty tsvectors).
--
--    Verify trigger firing order:
--
--      SELECT tgname FROM pg_trigger
--      WHERE tgrelid = 'ai_kb_entries'::regclass AND tgtype & 2 = 2
--      ORDER BY tgname;
--
--    Expected: ai_kb_entries_search_tsvector_trigger FIRST,
--              zz_ai_kb_entries_bm25_doclength_trigger SECOND.
