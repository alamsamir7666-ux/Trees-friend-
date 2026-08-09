-- ─── Migration 0003: Missing indexes + CHECK constraints + trigger fix ────────
--
-- This migration addresses the highest-priority database issues from the
-- engineering audit:
--
--   1. Missing indexes on hot FK columns (returns, productVariants, categories, etc.)
--   2. Missing CHECK constraints on status columns (orders, sellers, payouts, etc.)
--   3. Stale comment + missing updated_at trigger for blog_posts
--
-- ─── Safety ──────────────────────────────────────────────────────────────────
--
-- Every statement in this migration is SAFE to run on a live production
-- database with active traffic:
--
--   • CREATE INDEX CONCURRENTLY — builds the index without locking the table
--     for writes. Takes longer than a regular CREATE INDEX, but doesn't
--     block INSERT/UPDATE/DELETE. Safe on Supabase/PG 14+.
--
--   • ALTER TABLE ... ADD CONSTRAINT ... NOT VALID — adds the CHECK
--     constraint WITHOUT checking existing rows (fast, no table rewrite).
--     The constraint is enforced on all FUTURE writes; existing rows that
--     violate it are left alone (there shouldn't be any, but NOT VALID
--     means we don't fail if there are).
--
--   • The trigger statements are CREATE OR REPLACE + DROP IF EXISTS + CREATE
--     — fully idempotent.
--
-- ─── IMPORTANT: Cannot run inside a transaction ──────────────────────────────
--
-- CREATE INDEX CONCURRENTLY and ALTER TABLE ... NOT VALID cannot run inside
-- a transaction block. The apply script (scripts/apply-migration-0003.mjs)
-- runs each statement separately with autocommit.
--
-- ─── Drizzle schema sync ─────────────────────────────────────────────────────
--
-- The Drizzle schema files (lib/db/src/schema/*.ts) have been updated to
-- include the same indexes declared here. This prevents `drizzle-kit push`
-- from dropping them on the next schema push.
-- ────────────────────────────────────────────────────────────────────────────


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 1: Missing Indexes (CREATE INDEX CONCURRENTLY)
-- ════════════════════════════════════════════════════════════════════════════

-- ─── product_variants.product_id ────────────────────────────────────────────
-- Critical for product detail pages: routes/products.ts:185 does
-- WHERE productId IN (...) on every product list/detail call.
-- Same path used by routes/cart.ts and routes/orders.ts.
CREATE INDEX CONCURRENTLY IF NOT EXISTS product_variants_product_id_idx
  ON product_variants(product_id);

-- ─── categories.parent_id ───────────────────────────────────────────────────
-- Used by /seller-listings/shop-all (routes/sellerListings.ts:388) to build
-- the category tree via allCats.filter(c => c.parentId == null) and
-- childrenOf(pid). Seq-scans without this index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS categories_parent_id_idx
  ON categories(parent_id);

-- ─── returns.order_id, returns.user_id ──────────────────────────────────────
-- The entire returns table had ZERO indexes before this migration.
-- "Returns for this order" and "my returns" both seq-scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS returns_order_id_idx
  ON returns(order_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS returns_user_id_idx
  ON returns(user_id);

-- ─── gift_card_transactions.gift_card_id ────────────────────────────────────
-- Gift card history lookup seq-scans without this index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS gift_card_transactions_gift_card_id_idx
  ON gift_card_transactions(gift_card_id);

-- ─── subscriptions.user_id, subscriptions.next_order_date ───────────────────
-- NOTE: These indexes already exist in lib/db/src/schema/migration.sql
-- (lines 32-33) but were NEVER added to the Drizzle schema
-- (lib/db/src/schema/subscriptions.ts). A `drizzle-kit push` would silently
-- drop them. This migration creates them in the DB (idempotent — IF NOT
-- EXISTS); the Drizzle schema has been updated to declare them too.
CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriptions_user_id_idx
  ON subscriptions(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriptions_next_order_date_idx
  ON subscriptions(next_order_date);

-- ─── seller_subscriptions.seller_id, seller_subscriptions.year ──────────────
-- Admin per-seller subscription view seq-scans without this composite index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS seller_subscriptions_seller_id_year_idx
  ON seller_subscriptions(seller_id, year);

-- ─── pre_orders.user_id ─────────────────────────────────────────────────────
-- "My pre-orders" query (routes/preOrders.ts: GET /pre-orders/my) seq-scans
-- without this index. The product_id index already exists.
CREATE INDEX CONCURRENTLY IF NOT EXISTS pre_orders_user_id_idx
  ON pre_orders(user_id);

-- ─── loyalty_transactions.order_id ──────────────────────────────────────────
-- "Earned from order X" lookup seq-scans without this index.
-- The (user_id, created_at) composite already exists.
CREATE INDEX CONCURRENTLY IF NOT EXISTS loyalty_transactions_order_id_idx
  ON loyalty_transactions(order_id);

-- ─── addresses: partial unique on (user_id) WHERE is_default = true ─────────
-- Prevents multiple default addresses per user. Without this, a race or bug
-- can leave two rows with is_default=true for the same user.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS addresses_one_default_per_user
  ON addresses(user_id) WHERE is_default = true;

-- ─── gift_cards.purchased_by_user_id ────────────────────────────────────────
-- "My gift cards" query (routes/giftCards.ts: GET /gift-cards/my) seq-scans
-- without this index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS gift_cards_purchased_by_user_id_idx
  ON gift_cards(purchased_by_user_id);

-- ─── coupons.seller_id ──────────────────────────────────────────────────────
-- Seller-scoped coupon validation (lib/coupons.ts: validateCoupon) filters
-- WHERE seller_id = ? to check if a coupon applies to the cart's seller.
-- (Already declared in the Drizzle schema as idx_coupons_seller_id —
-- IF NOT EXISTS makes this a no-op if it was already created by drizzle-kit push.)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_coupons_seller_id
  ON coupons(seller_id);


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 2: CHECK Constraints (NOT VALID — safe, no table rewrite)
-- ════════════════════════════════════════════════════════════════════════════
--
-- These prevent typos like "pendng" or "succes" from being inserted. The
-- NOT VALID clause means existing rows are NOT checked — only future
-- INSERT/UPDATE are enforced. This is safe for a live database (no table
-- rewrite, no long lock).
--
-- To validate existing rows later (without locking for writes):
--   ALTER TABLE ... VALIDATE CONSTRAINT ...;
-- ────────────────────────────────────────────────────────────────────────────

-- ─── orders.order_status ────────────────────────────────────────────────────
ALTER TABLE orders
  ADD CONSTRAINT orders_order_status_check
  CHECK (order_status IN ('pending','confirmed','processing','shipped','delivered','cancelled','return_completed'))
  NOT VALID;

-- ─── orders.payment_status ──────────────────────────────────────────────────
ALTER TABLE orders
  ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('pending','paid','failed','payment_pending','pending_verification'))
  NOT VALID;

-- ─── sellers.status ──────────────────────────────────────────────────────────
ALTER TABLE sellers
  ADD CONSTRAINT sellers_status_check
  CHECK (status IN ('pending_verification','active','suspended','vacation'))
  NOT VALID;

-- ─── sellers.subscription_status ─────────────────────────────────────────────
ALTER TABLE sellers
  ADD CONSTRAINT sellers_subscription_status_check
  CHECK (subscription_status IN ('trial','active','expired'))
  NOT VALID;

-- ─── sellers.verification_request_status ─────────────────────────────────────
ALTER TABLE sellers
  ADD CONSTRAINT sellers_verification_request_status_check
  CHECK (verification_request_status IN ('none','requested','approved','rejected'))
  NOT VALID;

-- ─── payouts.status ──────────────────────────────────────────────────────────
ALTER TABLE payouts
  ADD CONSTRAINT payouts_status_check
  CHECK (status IN ('pending','success','failed'))
  NOT VALID;

-- ─── order_shipments.status ──────────────────────────────────────────────────
ALTER TABLE order_shipments
  ADD CONSTRAINT order_shipments_status_check
  CHECK (status IN ('pending','picked_up','in_transit','delivered','returned','failed'))
  NOT VALID;

-- ─── users.role ──────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('user','admin'))
  NOT VALID;

-- ─── subscriptions.status ────────────────────────────────────────────────────
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('active','paused','cancelled'))
  NOT VALID;

-- ─── subscriptions.frequency ─────────────────────────────────────────────────
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_frequency_check
  CHECK (frequency IN ('weekly','biweekly','monthly'))
  NOT VALID;

-- ─── pre_orders.status ───────────────────────────────────────────────────────
ALTER TABLE pre_orders
  ADD CONSTRAINT pre_orders_status_check
  CHECK (status IN ('pending','confirmed','arrived_in_bd','shipped','delivered','cancelled'))
  NOT VALID;

-- ─── pre_orders.payment_status ──────────────────────────────────────────────
ALTER TABLE pre_orders
  ADD CONSTRAINT pre_orders_payment_status_check
  CHECK (payment_status IN ('pending','pending_verification','paid','failed'))
  NOT VALID;

-- ─── seller_subscriptions.status ─────────────────────────────────────────────
ALTER TABLE seller_subscriptions
  ADD CONSTRAINT seller_subscriptions_status_check
  CHECK (status IN ('paid','overdue'))
  NOT VALID;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 3: Fix stale updated_at trigger for blog_posts
-- ════════════════════════════════════════════════════════════════════════════
--
-- The updated_at_triggers.sql file has a stale comment on line 123:
--   "-- blog_posts (no updated_at column in current schema — skip)"
--
-- But blogPosts.ts:16 clearly has:
--   updatedAt: timestamp("updated_at").notNull().defaultNow()
--
-- So the trigger was never created, and blog_posts.updated_at never
-- auto-updates on UPDATE. This fixes that.
-- ────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS update_blog_posts_updated_at ON blog_posts;
CREATE TRIGGER update_blog_posts_updated_at BEFORE UPDATE ON blog_posts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 4: Post-migration verification queries
-- ════════════════════════════════════════════════════════════════════════════
--
-- Run these manually to verify the migration applied correctly:
--
--   SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
--     AND indexname IN (
--       'product_variants_product_id_idx',
--       'categories_parent_id_idx',
--       'returns_order_id_idx',
--       'returns_user_id_idx',
--       'gift_card_transactions_gift_card_id_idx',
--       'subscriptions_user_id_idx',
--       'subscriptions_next_order_date_idx',
--       'seller_subscriptions_seller_id_year_idx',
--       'pre_orders_user_id_idx',
--       'loyalty_transactions_order_id_idx',
--       'addresses_one_default_per_user',
--       'gift_cards_purchased_by_user_id_idx',
--       'coupons_seller_id_idx'
--     );
--
--   SELECT conname FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace;
-- ────────────────────────────────────────────────────────────────────────────
