-- ─── updated_at auto-update trigger ──────────────────────────────────────
--
-- FIX: every table declares `updatedAt: timestamp("updated_at").defaultNow()`
-- but `defaultNow()` only fires on INSERT. Drizzle does not auto-update
-- `updatedAt` on UPDATE — there's no trigger, and no app-level convention
-- is enforced. In practice, `updatedAt === createdAt` for the lifetime of
-- most rows.
--
-- This migration creates a single trigger function that sets `updated_at`
-- to NOW() on every UPDATE, and attaches it to every table that has an
-- `updated_at` column.
--
-- The function is idempotent (CREATE OR REPLACE) and uses `COALESCE` to
-- avoid updating the column if the UPDATE statement already set it
-- explicitly (rare, but allows override).

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  -- Only set updated_at if it wasn't explicitly set in the UPDATE
  NEW.updated_at = COALESCE(NEW.updated_at, NOW());
  RETURN NEW;
END;
$$ language 'plpgsql';

-- ─── Attach trigger to every table with an updated_at column ─────────────
-- Each DROP IF IF EXISTS + CREATE TRIGGER is idempotent.

-- users
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- sellers
DROP TRIGGER IF EXISTS update_sellers_updated_at ON sellers;
CREATE TRIGGER update_sellers_updated_at BEFORE UPDATE ON sellers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- products
DROP TRIGGER IF EXISTS update_products_updated_at ON products;
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- product_variants
DROP TRIGGER IF EXISTS update_product_variants_updated_at ON product_variants;
CREATE TRIGGER update_product_variants_updated_at BEFORE UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- orders
DROP TRIGGER IF EXISTS update_orders_updated_at ON orders;
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- cart_items
DROP TRIGGER IF EXISTS update_cart_items_updated_at ON cart_items;
CREATE TRIGGER update_cart_items_updated_at BEFORE UPDATE ON cart_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- addresses
DROP TRIGGER IF EXISTS update_addresses_updated_at ON addresses;
CREATE TRIGGER update_addresses_updated_at BEFORE UPDATE ON addresses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- categories
DROP TRIGGER IF EXISTS update_categories_updated_at ON categories;
CREATE TRIGGER update_categories_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- coupons
DROP TRIGGER IF EXISTS update_coupons_updated_at ON coupons;
CREATE TRIGGER update_coupons_updated_at BEFORE UPDATE ON coupons
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- returns
DROP TRIGGER IF EXISTS update_returns_updated_at ON returns;
CREATE TRIGGER update_returns_updated_at BEFORE UPDATE ON returns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- reviews (no updated_at column — skip)

-- seller_listings
DROP TRIGGER IF EXISTS update_seller_listings_updated_at ON seller_listings;
CREATE TRIGGER update_seller_listings_updated_at BEFORE UPDATE ON seller_listings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- seller_listing_variants
DROP TRIGGER IF EXISTS update_seller_listing_variants_updated_at ON seller_listing_variants;
CREATE TRIGGER update_seller_listing_variants_updated_at BEFORE UPDATE ON seller_listing_variants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- seller_payment_configs
DROP TRIGGER IF EXISTS update_seller_payment_configs_updated_at ON seller_payment_configs;
CREATE TRIGGER update_seller_payment_configs_updated_at BEFORE UPDATE ON seller_payment_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- seller_courier_configs (no updated_at column — skip)

-- seller_payout_accounts
DROP TRIGGER IF EXISTS update_seller_payout_accounts_updated_at ON seller_payout_accounts;
CREATE TRIGGER update_seller_payout_accounts_updated_at BEFORE UPDATE ON seller_payout_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- seller_subscriptions
DROP TRIGGER IF EXISTS update_seller_subscriptions_updated_at ON seller_subscriptions;
CREATE TRIGGER update_seller_subscriptions_updated_at BEFORE UPDATE ON seller_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- platform_payment_config
DROP TRIGGER IF EXISTS update_platform_payment_config_updated_at ON platform_payment_config;
CREATE TRIGGER update_platform_payment_config_updated_at BEFORE UPDATE ON platform_payment_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- conversations
DROP TRIGGER IF EXISTS update_conversations_updated_at ON conversations;
CREATE TRIGGER update_conversations_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- gift_cards
DROP TRIGGER IF EXISTS update_gift_cards_updated_at ON gift_cards;
CREATE TRIGGER update_gift_cards_updated_at BEFORE UPDATE ON gift_cards
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- blog_posts (no updated_at column in current schema — skip)

-- pre_orders
DROP TRIGGER IF EXISTS update_pre_orders_updated_at ON pre_orders;
CREATE TRIGGER update_pre_orders_updated_at BEFORE UPDATE ON pre_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- subscriptions
DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- monthly_records (no updated_at column — skip)

-- abandoned_carts
DROP TRIGGER IF EXISTS update_abandoned_carts_updated_at ON abandoned_carts;
CREATE TRIGGER update_abandoned_carts_updated_at BEFORE UPDATE ON abandoned_carts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- order_shipments
DROP TRIGGER IF EXISTS update_order_shipments_updated_at ON order_shipments;
CREATE TRIGGER update_order_shipments_updated_at BEFORE UPDATE ON order_shipments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
