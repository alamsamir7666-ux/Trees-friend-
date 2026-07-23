-- migrations/add_review_photos.sql
-- Run this against your PostgreSQL database to add photo support to reviews.
-- Also adds order_status_timeline to orders.

-- 1. Add photos column to reviews (array of Cloudinary URLs)
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS photos jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 2. Add order status timeline to orders
-- Each entry: { status: string, timestamp: ISO string, note?: string }
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS status_timeline jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 4. Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  frequency TEXT NOT NULL,
  items jsonb NOT NULL,
  shipping_address jsonb NOT NULL,
  total_amount NUMERIC(10,2) NOT NULL,
  discount_percent INTEGER NOT NULL DEFAULT 10,
  next_order_date TIMESTAMP NOT NULL,
  last_order_date TIMESTAMP,
  order_count INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cod',
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS subscriptions_next_order_date_idx ON subscriptions(next_order_date);

-- 5. Gift cards
CREATE TABLE IF NOT EXISTS gift_cards (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  initial_balance NUMERIC(10,2) NOT NULL,
  balance NUMERIC(10,2) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  purchased_by_user_id TEXT,
  recipient_email TEXT,
  recipient_name TEXT,
  message TEXT,
  expiry_date TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gift_card_transactions (
  id SERIAL PRIMARY KEY,
  gift_card_id INTEGER NOT NULL REFERENCES gift_cards(id),
  order_id TEXT,
  user_id TEXT,
  amount NUMERIC(10,2) NOT NULL,
  balance_after NUMERIC(10,2) NOT NULL,
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 6. Email preferences
CREATE TABLE IF NOT EXISTS email_preferences (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  order_updates BOOLEAN NOT NULL DEFAULT TRUE,
  promotions BOOLEAN NOT NULL DEFAULT TRUE,
  restock_alerts BOOLEAN NOT NULL DEFAULT TRUE,
  newsletter BOOLEAN NOT NULL DEFAULT TRUE,
  abandoned_cart BOOLEAN NOT NULL DEFAULT TRUE,
  loyalty_updates BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_points (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  points INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,
  order_id INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Add icon_image column to categories (uploaded icon, alternative to emoji)
ALTER TABLE categories ADD COLUMN IF NOT EXISTS icon_image TEXT;

-- Add gift wrap columns to orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS gift_wrap TEXT DEFAULT 'false';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS gift_message TEXT;
-- affiliate_cashouts table
CREATE TABLE IF NOT EXISTS affiliate_cashouts (
  id SERIAL PRIMARY KEY,
  affiliate_id INTEGER NOT NULL REFERENCES affiliates(id),
  amount NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);


-- seller_listing_variants table (one listing = many variants; price/stock/
-- form/etc. move here from seller_listings)
CREATE TABLE IF NOT EXISTS seller_listing_variants (
  id SERIAL PRIMARY KEY,
  seller_listing_id INTEGER NOT NULL REFERENCES seller_listings(id) ON DELETE CASCADE,
  form TEXT,
  root_type TEXT,
  pot_size TEXT,
  age TEXT,
  height TEXT,
  condition TEXT,
  price NUMERIC(10,2) NOT NULL,
  discount_price NUMERIC(10,2),
  stock INTEGER NOT NULL DEFAULT 0,
  available_quantity INTEGER NOT NULL DEFAULT 0,
  delivery_charge NUMERIC(10,2) NOT NULL DEFAULT '0',
  is_pre_order BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- seller_listings: form, root_type, pot_size, age, height, condition,
-- price, discount_price, stock, available_quantity moved to
-- seller_listing_variants above. NOT dropped from seller_listings yet --
-- existing rows' price/stock data has no backfill path to variants planned
-- yet. Actual column drops are a later phase once that migration path exists.
-- ALTER TABLE seller_listings DROP COLUMN form;
-- ALTER TABLE seller_listings DROP COLUMN root_type;
-- ALTER TABLE seller_listings DROP COLUMN pot_size;
-- ALTER TABLE seller_listings DROP COLUMN age;
-- ALTER TABLE seller_listings DROP COLUMN height;
-- ALTER TABLE seller_listings DROP COLUMN condition;
-- ALTER TABLE seller_listings DROP COLUMN price;
-- ALTER TABLE seller_listings DROP COLUMN discount_price;
-- ALTER TABLE seller_listings DROP COLUMN stock;
-- ALTER TABLE seller_listings DROP COLUMN available_quantity;

-- ─── Phase 2: backend routes/logic for the listing/variant split ──────────
-- Two decisions made this phase (see PHASE2_HANDOFF.md for full reasoning):
--   1. cart_items gets a seller_listing_variant_id column; uniqueness moves
--      from (user_id, seller_listing_id) to (user_id,
--      seller_listing_variant_id), so a buyer can add two different
--      variants of the SAME listing as separate cart lines.
--      seller_listing_id is KEPT (denormalized from the variant's own FK)
--      for read/grouping convenience -- same pattern product_id already
--      used on this table.
--   2. reviews gets the same seller_listing_variant_id column; uniqueness
--      moves from (seller_listing_id, user_id) to
--      (seller_listing_variant_id, user_id), so a buyer can separately
--      review each variant of a seller's listing they purchased.

-- 1. cart_items: add seller_listing_variant_id, move uniqueness
ALTER TABLE cart_items
  ADD COLUMN IF NOT EXISTS seller_listing_variant_id INTEGER
    REFERENCES seller_listing_variants(id) ON DELETE CASCADE;

ALTER TABLE cart_items
  DROP CONSTRAINT IF EXISTS cart_user_seller_listing_unique;

ALTER TABLE cart_items
  ADD CONSTRAINT cart_user_seller_listing_variant_unique
    UNIQUE (user_id, seller_listing_variant_id);

-- 2. reviews: add seller_listing_variant_id, move uniqueness
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS seller_listing_variant_id INTEGER
    REFERENCES seller_listing_variants(id) ON DELETE CASCADE;

ALTER TABLE reviews
  DROP CONSTRAINT IF EXISTS reviews_seller_listing_user_unique;

ALTER TABLE reviews
  ADD CONSTRAINT reviews_seller_listing_variant_user_unique
    UNIQUE (seller_listing_variant_id, user_id);
