-- ─── Migration 0006: tsvector columns for stemming-aware full-text search ────
--
-- Implements the industry-standard hybrid search pattern:
--   PRIMARY:   websearch_to_tsquery('english', ...) @@ tsvector  → ts_rank_cd
--   FALLBACK:  pg_trgm similarity() for typo tolerance
--
-- Previously the codebase used ILIKE '%term%' + pg_trgm similarity() with
-- no stemming. This meant:
--   - "watering" didn't match "water" (no stemming)
--   - "mangoes" didn't match "mango" (no plural normalization)
--   - "growing" didn't match "grow" (no gerund normalization)
--
-- Postgres built-in full-text search handles ALL of these via Snowball
-- stemmer ('english' config). It's also faster than ILIKE on large tables
-- (GIN index on tsvector vs seq scan for ILIKE).
--
-- ─── Why tsvector columns + triggers (not computed in queries)? ─────────────
--
-- We could compute `to_tsvector('english', name || ' ' || description)` in
-- each query, but that recomputes the tsvector on every search (slow on
-- large tables). Instead we store it as a column + maintain it via a
-- trigger, so searches just read the precomputed column. This is the
-- pattern recommended by the Postgres docs + Supabase's FTS guide.
--
-- ─── Why websearch_to_tsquery (not plainto_tsquery, not to_tsquery)? ────────
--
--   - to_tsquery: requires boolean operators (&, |, !) — breaks on user input
--       like "mango tree" (would need "mango & tree")
--   - plainto_tsquery: handles plain text but treats all tokens as AND
--       (no OR, no phrase, no negation)
--   - websearch_to_tsquery: handles user-style search syntax:
--       "mango tree"        → mango AND tree
--       "mango OR tree"     → mango OR tree
--       "mango -tree"       → mango AND NOT tree
--       "mango tree"        → mango AND tree (phrases via quotes)
--     This is the best fit for AI-generated search queries.
--
-- ─── ts_rank_cd vs ts_rank ──────────────────────────────────────────────────
--
-- ts_rank_cd uses "cover density" ranking — how close the matched lexemes
-- are to each other in the document. This produces better relevance
-- ordering than ts_rank (which uses term frequency). We use ts_rank_cd.
--
-- ─── Safety ──────────────────────────────────────────────────────────────────
--
-- All statements are idempotent (IF NOT EXISTS) + safe on a live DB:
--   - ADD COLUMN ... IF NOT EXISTS (PG 9.6+) — no table rewrite
--   - CREATE INDEX ... CONCURRENTLY IF NOT EXISTS (PG 8.2+) — no write lock
--   - CREATE TRIGGER ... OR REPLACE (PG 14+) — updates in place
--
-- Cannot run inside a transaction (CONCURRENTLY). Apply each statement
-- separately with autocommit.
-- ────────────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 1: products — tsvector on (name, scientific_name, description)
-- ════════════════════════════════════════════════════════════════════════════

-- Add the tsvector column (nullable — populated by trigger).
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS search_tsvector tsvector;

-- Backfill existing rows (one-time). Uses COALESCE so NULL scientific_name
-- doesn't produce a NULL tsvector (which would be excluded from searches).
UPDATE products
SET search_tsvector =
  setweight(to_tsvector('english', COALESCE(name, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(scientific_name, '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(description, '')), 'C')
WHERE search_tsvector IS NULL;

-- GIN index for fast @@ queries. GIN is the standard for tsvector.
CREATE INDEX CONCURRENTLY IF NOT EXISTS products_search_tsvector_idx
  ON products USING gin (search_tsvector);

-- Trigger to keep the column in sync on INSERT/UPDATE.
-- DROP + CREATE so the function definition is always current (idempotent).
DROP TRIGGER IF EXISTS products_search_tsvector_trigger ON products;
DROP FUNCTION IF EXISTS products_search_tsvector_update();

CREATE FUNCTION products_search_tsvector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsvector :=
    setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.scientific_name, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TRIGGER products_search_tsvector_trigger
  BEFORE INSERT OR UPDATE OF name, scientific_name, description
  ON products
  FOR EACH ROW
  EXECUTE FUNCTION products_search_tsvector_update();

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 2: blog_posts — tsvector on (title, excerpt, content)
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE blog_posts
  ADD COLUMN IF NOT EXISTS search_tsvector tsvector;

-- content is JSON-stringified content blocks (TipTap). Strip HTML tags via
-- a regexp so the tsvector indexes the visible text, not the markup.
UPDATE blog_posts
SET search_tsvector =
  setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(excerpt, '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(regexp_replace(content, '<[^>]+>', ' ', 'g'), '')), 'C')
WHERE search_tsvector IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS blog_posts_search_tsvector_idx
  ON blog_posts USING gin (search_tsvector);

DROP TRIGGER IF EXISTS blog_posts_search_tsvector_trigger ON blog_posts;
DROP FUNCTION IF EXISTS blog_posts_search_tsvector_update();

CREATE FUNCTION blog_posts_search_tsvector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsvector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.excerpt, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(regexp_replace(NEW.content, '<[^>]+>', ' ', 'g'), '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TRIGGER blog_posts_search_tsvector_trigger
  BEFORE INSERT OR UPDATE OF title, excerpt, content
  ON blog_posts
  FOR EACH ROW
  EXECUTE FUNCTION blog_posts_search_tsvector_update();

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 3: ai_kb_entries — tsvector on (title, content)
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE ai_kb_entries
  ADD COLUMN IF NOT EXISTS search_tsvector tsvector;

UPDATE ai_kb_entries
SET search_tsvector =
  setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(content, '')), 'C')
WHERE search_tsvector IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_kb_entries_search_tsvector_idx
  ON ai_kb_entries USING gin (search_tsvector);

DROP TRIGGER IF EXISTS ai_kb_entries_search_tsvector_trigger ON ai_kb_entries;
DROP FUNCTION IF EXISTS ai_kb_entries_search_tsvector_update();

CREATE FUNCTION ai_kb_entries_search_tsvector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsvector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TRIGGER ai_kb_entries_search_tsvector_trigger
  BEFORE INSERT OR UPDATE OF title, content
  ON ai_kb_entries
  FOR EACH ROW
  EXECUTE FUNCTION ai_kb_entries_search_tsvector_update();

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 4: trigram GIN indexes (typo-tolerance fallback)
-- ════════════════════════════════════════════════════════════════════════════
--
-- These complement the tsvector indexes. When the user types "mangoo" (typo),
-- the tsvector won't match (stemmer normalizes "mango" → "mango", not "mangoo").
-- The trigram similarity() function catches these via GREATEST() per-token.
--
-- Already created in ensureAiTables.ts for products.name + description.
-- Adding scientific_name + blog_posts + ai_kb_entries here.

CREATE INDEX CONCURRENTLY IF NOT EXISTS products_scientific_name_trgm_idx
  ON products USING gin (scientific_name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS blog_posts_title_trgm_idx
  ON blog_posts USING gin (title gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS blog_posts_content_trgm_idx
  ON blog_posts USING gin (content gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_kb_entries_title_trgm_idx
  ON ai_kb_entries USING gin (title gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_kb_entries_content_trgm_idx
  ON ai_kb_entries USING gin (content gin_trgm_ops);
