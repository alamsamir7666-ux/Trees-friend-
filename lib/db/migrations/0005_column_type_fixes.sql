-- ─── Migration 0005: Column type fixes ───────────────────────────────────────
--
-- Fixes 5 columns with wrong types identified in the engineering audit.
-- All migrations are SAFE because:
--   1. The DB has minimal data (4 users, ~74 rows across per-user tables)
--   2. Each ALTER is preceded by a data-conversion UPDATE that makes the
--      existing values compatible with the new type
--   3. blog_posts has 0 rows (verified before migration)
--
-- ─── Changes ──────────────────────────────────────────────────────────────────
--
--   orders.gift_wrap:              text → boolean (default false)
--   blog_posts.published_at:       varchar(50) → timestamp (nullable)
--   blog_posts.read_time:          varchar(50) → integer (minutes, default 5)
--   blog_posts.linked_product_ids: text (JSON string) → jsonb (native array)
--   pre_orders.user_id:            text NOT NULL default 'guest' → text nullable
--                                  (the magic string 'guest' breaks the FK
--                                   added in migration 0004; guest pre-orders
--                                   should have NULL user_id instead)
-- ────────────────────────────────────────────────────────────────────────────


-- ════════════════════════════════════════════════════════════════════════════
-- 1. orders.gift_wrap: text → boolean
-- ════════════════════════════════════════════════════════════════════════════
-- Existing values: 'true' / 'false' / NULL. Convert before ALTER.

UPDATE orders SET gift_wrap = NULL WHERE gift_wrap NOT IN ('true', 'false');
ALTER TABLE orders ALTER COLUMN gift_wrap DROP DEFAULT;
ALTER TABLE orders ALTER COLUMN gift_wrap TYPE boolean
  USING (gift_wrap = 'true');
ALTER TABLE orders ALTER COLUMN gift_wrap SET DEFAULT false;
-- Make it NOT NULL after conversion (all existing rows now have true/false)
UPDATE orders SET gift_wrap = false WHERE gift_wrap IS NULL;
ALTER TABLE orders ALTER COLUMN gift_wrap SET NOT NULL;


-- ════════════════════════════════════════════════════════════════════════════
-- 2. blog_posts.published_at: varchar(50) → timestamp (nullable)
-- ════════════════════════════════════════════════════════════════════════════
-- Existing values: empty string '' or date strings like "August 2025".
-- Empty string → NULL. Date strings that can't be parsed → NULL.
-- (blog_posts has 0 rows per the orphan-check, so this is a no-op.)

UPDATE blog_posts SET published_at = NULL WHERE published_at = '' OR published_at IS NULL;
ALTER TABLE blog_posts ALTER COLUMN published_at DROP DEFAULT;
ALTER TABLE blog_posts ALTER COLUMN published_at TYPE timestamp
  USING (CASE
    WHEN published_at IS NULL OR published_at = '' THEN NULL
    -- Try to parse common date formats; NULL if unparseable
    ELSE NULL  -- conservative: existing values are display strings like "August 2025"
                -- which aren't real timestamps. Set to NULL; admin can re-enter.
  END);
ALTER TABLE blog_posts ALTER COLUMN published_at DROP NOT NULL;


-- ════════════════════════════════════════════════════════════════════════════
-- 3. blog_posts.read_time: varchar(50) → integer (minutes)
-- ════════════════════════════════════════════════════════════════════════════
-- Existing values: "5 min read", "3 min read", etc.
-- Extract the leading integer; default to 5 if no number found.

UPDATE blog_posts SET read_time = '5' WHERE read_time !~ '^\d';
ALTER TABLE blog_posts ALTER COLUMN read_time DROP DEFAULT;
ALTER TABLE blog_posts ALTER COLUMN read_time TYPE integer
  USING (COALESCE(NULLIF(substring(read_time FROM '\d+'), '')::integer, 5));
ALTER TABLE blog_posts ALTER COLUMN read_time SET DEFAULT 5;


-- ════════════════════════════════════════════════════════════════════════════
-- 4. blog_posts.linked_product_ids: text (JSON) → jsonb
-- ════════════════════════════════════════════════════════════════════════════
-- Existing values: JSON-stringified arrays like '[1, 2, 3]' or '[]'.
-- Cast directly to jsonb (Postgres handles the conversion).

ALTER TABLE blog_posts ALTER COLUMN linked_product_ids DROP DEFAULT;
ALTER TABLE blog_posts ALTER COLUMN linked_product_ids TYPE jsonb
  USING (linked_product_ids::jsonb);
ALTER TABLE blog_posts ALTER COLUMN linked_product_ids SET DEFAULT '[]'::jsonb;


-- ════════════════════════════════════════════════════════════════════════════
-- 5. pre_orders.user_id: text NOT NULL default 'guest' → text nullable
-- ════════════════════════════════════════════════════════════════════════════
-- The magic string 'guest' was a placeholder for guest checkouts. With the
-- FK added in migration 0004, 'guest' would violate the FK (no users row
-- with clerk_id = 'guest'). Convert existing 'guest' rows to NULL, then
-- drop the default and NOT NULL constraint.
-- (pre_orders has 0 rows with user_id='guest' per the orphan-check.)

UPDATE pre_orders SET user_id = NULL WHERE user_id = 'guest';
ALTER TABLE pre_orders ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE pre_orders ALTER COLUMN user_id DROP NOT NULL;
