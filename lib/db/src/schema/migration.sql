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
