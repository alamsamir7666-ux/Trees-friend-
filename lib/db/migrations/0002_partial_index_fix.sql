-- Delta migration: replace composite index with partial index (gap #2 fix).
-- The old composite (homepage_tag, deleted_at) was created in 0001_supreme_zombie.sql.
-- This replaces it with a partial index scoped to non-deleted rows, which is
-- smaller and faster for the common buyer-facing query pattern.
--
-- Apply via psql or the custom Node.js script (NOT drizzle-kit migrate —
-- CONCURRENTLY can't run in a transaction).

DROP INDEX CONCURRENTLY IF EXISTS "products_homepage_tag_deleted_idx";
CREATE INDEX CONCURRENTLY "products_homepage_tag_active_idx"
  ON "products" USING btree ("homepage_tag")
  WHERE "deleted_at" IS NULL;
