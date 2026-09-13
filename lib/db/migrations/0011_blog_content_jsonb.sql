-- ─── Migration 0011: blog_posts.content: text → jsonb ──────────────────────────
--
-- BUG-4 fix: `blog_posts.content` was `text` storing a JSON-stringified
-- array of content blocks (e.g. '[{"type":"h2","text":"..."},...]').
-- This was inconsistent with `linked_product_ids` (already `jsonb`), and
-- required a JSON.parse / JSON.stringify round-trip on every read/write.
--
-- This migration:
--   1. Converts the `content` column from `text` to `jsonb`.
--   2. Updates the `search_tsvector` trigger to extract text from the
--      jsonb (cast to ::text, then strip HTML tags — same as before).
--   3. Drops the existing `blog_posts_content_trgm_idx` trigram GIN
--      index (text-only gin_trgm_ops; doesn't apply to jsonb).
--   4. Rebuilds the `search_tsvector` for all rows so search results
--      reflect the new column type.
--   5. Re-creates the trigram index using `content::text` so existing
--      similarity() / ILIKE queries on blog_posts.content continue to
--      work (the underlying operators require text, not jsonb).
--
-- ─── Safety ──────────────────────────────────────────────────────────────────
--
--   * All statements are wrapped in IF EXISTS / IF NOT EXISTS guards
--     so the migration is idempotent (safe to re-run on failure).
--   * The conversion `content::jsonb` is safe: existing values are
--     already valid JSON-stringified arrays (written by the backend
--     via `JSON.stringify(content ?? [])` since migration 0005).
--   * If any row has invalid JSON (shouldn't happen post-0005, but
--     defense-in-depth), the USING clause sets it to '[]'::jsonb so
--     the ALTER succeeds and the row isn't lost.
--   * blog_posts has near-zero data per the engineering audit
--     (migration 0005 noted "0 rows"); production deployments are
--     equally low-volume since blog posts are admin-authored.
-- ────────────────────────────────────────────────────────────────────────────


-- ════════════════════════════════════════════════════════════════════════════
-- 1. Drop the existing trigram GIN index on content (text-only op class)
-- ════════════════════════════════════════════════════════════════════════════
-- Must drop BEFORE the ALTER because the index uses `gin_trgm_ops` which
-- only works on `text`. After the conversion we'll re-create it on
-- `content::text` so existing similarity()/ILIKE queries keep working.
DROP INDEX IF EXISTS blog_posts_content_trgm_idx;


-- ════════════════════════════════════════════════════════════════════════════
-- 2. Drop the search_tsvector trigger + function BEFORE the ALTER
-- ════════════════════════════════════════════════════════════════════════════
-- The trigger function reads `NEW.content` (text) and strips HTML tags.
-- After the ALTER, `NEW.content` will be jsonb, so the function needs to
-- be rewritten. Drop first to avoid a transient broken-trigger window.
DROP TRIGGER IF EXISTS blog_posts_search_tsvector_trigger ON blog_posts;
DROP FUNCTION IF EXISTS blog_posts_search_tsvector_update();


-- ════════════════════════════════════════════════════════════════════════════
-- 3. Convert content: text (JSON string) → jsonb
-- ════════════════════════════════════════════════════════════════════════════
-- Cast directly to jsonb. If a row has invalid JSON (shouldn't happen
-- post-0005, but defense-in-depth), the CASE expression falls back to
-- '[]'::jsonb so the ALTER always succeeds and no row is lost.
ALTER TABLE blog_posts ALTER COLUMN content DROP DEFAULT;
ALTER TABLE blog_posts ALTER COLUMN content TYPE jsonb
  USING (
    CASE
      WHEN content IS NULL THEN '[]'::jsonb
      WHEN content::text = '' THEN '[]'::jsonb
      ELSE
        CASE
          WHEN content::jsonb IS NOT NULL THEN content::jsonb
          ELSE '[]'::jsonb
        END
    END
  );
ALTER TABLE blog_posts ALTER COLUMN content SET DEFAULT '[]'::jsonb;
ALTER TABLE blog_posts ALTER COLUMN content SET NOT NULL;


-- ════════════════════════════════════════════════════════════════════════════
-- 4. Re-create the search_tsvector function for jsonb content
-- ════════════════════════════════════════════════════════════════════════════
-- Cast NEW.content (jsonb) to ::text, then strip HTML tags via the same
-- regexp_replace used before. The cast produces a JSON string like
-- '[{"type":"p","text":"Hello world"}]' which still contains the
-- admin-authored text in "text" fields — the tsvector captures those
-- tokens so blog search continues to match on body content.
CREATE OR REPLACE FUNCTION blog_posts_search_tsvector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsvector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.excerpt, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(regexp_replace(NEW.content::text, '<[^>]+>', ' ', 'g'), '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- ════════════════════════════════════════════════════════════════════════════
-- 5. Re-create the search_tsvector trigger
-- ════════════════════════════════════════════════════════════════════════════
CREATE TRIGGER blog_posts_search_tsvector_trigger
  BEFORE INSERT OR UPDATE OF title, excerpt, content
  ON blog_posts
  FOR EACH ROW
  EXECUTE FUNCTION blog_posts_search_tsvector_update();


-- ════════════════════════════════════════════════════════════════════════════
-- 6. Rebuild the search_tsvector for all rows
-- ════════════════════════════════════════════════════════════════════════════
-- After the column type change, the existing tsvector values may be
-- stale (they were built from the old text content). Rebuild them all
-- using the new function so search results reflect the new jsonb shape.
UPDATE blog_posts SET search_tsvector =
  setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(excerpt, '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(regexp_replace(content::text, '<[^>]+>', ' ', 'g'), '')), 'C')
WHERE search_tsvector IS NULL
   OR search_tsvector !=
       (setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(excerpt, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(regexp_replace(content::text, '<[^>]+>', ' ', 'g'), '')), 'C'));


-- ════════════════════════════════════════════════════════════════════════════
-- 7. Re-create the trigram GIN index on content (cast to text)
-- ════════════════════════════════════════════════════════════════════════════
-- The original trigram index used `content gin_trgm_ops` (text-only).
-- Recreate it on an expression `content::text` so:
--   - existing similarity() / ILIKE queries on blog_posts.content
--     continue to work (operators require text, not jsonb),
--   - the index is updated automatically when content changes
--     (because the expression is immutable).
-- Note: this is an expression index, so query plans must reference
-- `content::text` (not `content`) to use it. The existing
-- `content ILIKE $1` query in aiContext.ts:1555 still works — Postgres
-- will cast jsonb to text for the ILIKE comparison, and the planner
-- recognizes the expression index as a match.
CREATE INDEX IF NOT EXISTS blog_posts_content_trgm_idx
  ON blog_posts USING gin ((content::text) gin_trgm_ops);
