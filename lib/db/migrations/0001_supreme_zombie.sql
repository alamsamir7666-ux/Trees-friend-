-- P0-2: indexes on 12 hot-path columns (engineering audit).
--
-- ⚠️ PRODUCTION APPLICATION NOTE:
-- This migration uses CREATE INDEX CONCURRENTLY, which:
--   1. Does NOT block writes (safe to run on a live production database)
--   2. CANNOT run inside a transaction
--   3. Takes longer than a regular CREATE INDEX (builds the index in two scans)
--
-- Therefore, do NOT apply this via `drizzle-kit migrate` (which wraps each
-- migration file in a transaction — CONCURRENTLY will fail with
-- "CREATE INDEX CONCURRENTLY cannot run inside a transaction block").
--
-- Instead, apply via:
--   - psql:  psql "$DATABASE_URL" -f migrations/0001_supreme_zombie.sql
--   - Or the custom Node.js apply script: scripts/apply_migration_0001.js
--     (which executes each statement individually, NOT in a transaction)
--
-- CONCURRENTLY also cannot be combined with CREATE INDEX IF NOT EXISTS in
-- the same statement (Postgres limitation). The apply script handles
-- idempotency by catching "already exists" errors.
--
-- If an index creation fails partway (e.g. a unique constraint violation
-- during CONCURRENTLY build), it leaves an INVALID index. Clean up with:
--   DROP INDEX CONCURRENTLY <index_name>;
-- then re-run the failed statement.
--
-- The unique constraint on monthly_records(year, month) uses a regular
-- ALTER TABLE (not CONCURRENTLY — constraints can't be added concurrently).
-- This takes a brief ACCESS EXCLUSIVE lock but is fast (validates uniqueness
-- in a single scan).

CREATE INDEX CONCURRENTLY "products_category_id_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "products_homepage_tag_active_idx" ON "products" USING btree ("homepage_tag") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "reviews_product_id_idx" ON "reviews" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "reviews_seller_listing_id_idx" ON "reviews" USING btree ("seller_listing_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "orders_user_id_created_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "orders_seller_id_created_idx" ON "orders" USING btree ("seller_id","created_at");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "cart_items_user_id_idx" ON "cart_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "addresses_user_id_idx" ON "addresses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "loyalty_transactions_user_id_created_idx" ON "loyalty_transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "stock_alerts_variant_id_idx" ON "stock_alerts" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "pre_orders_product_id_idx" ON "pre_orders" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "seller_listings_product_id_idx" ON "seller_listings" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "seller_listings_seller_id_idx" ON "seller_listings" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "seller_listings_visibility_approval_idx" ON "seller_listings" USING btree ("visibility","approval_status");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "seller_listing_variants_seller_listing_id_idx" ON "seller_listing_variants" USING btree ("seller_listing_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "payouts_order_id_idx" ON "payouts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "payouts_seller_id_created_idx" ON "payouts" USING btree ("seller_id","created_at");--> statement-breakpoint
ALTER TABLE "monthly_records" ADD CONSTRAINT "monthly_records_year_month_unique" UNIQUE("year","month");
