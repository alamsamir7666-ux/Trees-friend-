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

-- ─── Phase 6: pre_orders gets seller_listing_variant_id ────────────────────
-- Fixes the over-notification gap logged in PHASE5_HANDOFF.md:
-- notifyPreOrderCustomers() could only ever scope to "everyone with a
-- pending pre-order on this product," not "everyone who pre-ordered this
-- specific variant," because pre_orders had no column to key on besides
-- product_id. POST /pre-orders already received sellerListingVariantId in
-- its request body for validation but discarded it before insert -- this
-- column lets the route persist it instead.
--
-- Nullable, no FK constraint -- matching product_id's existing convention
-- on this same table (a plain id, not a references() FK), since pre_orders
-- is a denormalized/historical record (see product_name/product_image
-- snapshot columns) that shouldn't cascade or break if the referenced
-- seller_listing_variants row is later edited or deleted. Existing rows
-- created before this migration get NULL here; routes/preOrders.ts's
-- notifyPreOrderCustomers() falls back to the old, broader product-wide
-- notify condition for any row where this is null.
ALTER TABLE pre_orders
  ADD COLUMN IF NOT EXISTS seller_listing_variant_id INTEGER;

-- ─── Wishlist: split "product variety" vs "seller listing" wishlist rows ──
-- Previously wishlist only ever had product_id -- SellerListingDetailPage's
-- heart button wishlisted the PRODUCT (wrong: it saved the seller's
-- nurseryName as the display name but there was no way to actually save
-- "this seller's listing" as a distinct thing). This adds an optional
-- seller_listing_variant_id so a row is either:
--   - a product-variety wishlist row (seller_listing_variant_id IS NULL)
--   - a seller-listing wishlist row (seller_listing_variant_id set,
--     product_id also still set since a listing always belongs to a
--     product -- kept for read/grouping convenience, same denormalization
--     pattern cart_items/reviews/pre_orders already use on this column)

ALTER TABLE wishlist
  ADD COLUMN IF NOT EXISTS seller_listing_variant_id INTEGER
    REFERENCES seller_listing_variants(id) ON DELETE CASCADE;

-- The old table-wide unique(user_id, product_id) constraint would also
-- cover seller-listing rows (they carry product_id too) and wrongly block
-- wishlisting a product AND a seller listing of that same product, or two
-- different sellers' listings of that same product, as separate rows.
-- Replaced with two PARTIAL unique indexes, one per row-kind.
ALTER TABLE wishlist
  DROP CONSTRAINT IF EXISTS wishlist_user_product_unique;

CREATE UNIQUE INDEX IF NOT EXISTS wishlist_user_product_variety_unique
  ON wishlist (user_id, product_id)
  WHERE seller_listing_variant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS wishlist_user_seller_listing_variant_unique
  ON wishlist (user_id, seller_listing_variant_id)
  WHERE seller_listing_variant_id IS NOT NULL;

-- ─── Seller-listing Reviews & Q&A ──────────────────────────────────────────
-- reviews table already had seller_listing_id/seller_listing_variant_id
-- columns from an earlier phase (see reviews.ts doc comment) but no route
-- ever read/wrote them -- product_qa never had listing-scoped columns at
-- all. This adds those to product_qa so a buyer can ask a seller a
-- question about that seller's specific listing, answered by the seller
-- who owns it (or an admin), separately from product-level Q&A.

ALTER TABLE product_qa
  ADD COLUMN IF NOT EXISTS seller_listing_id INTEGER
    REFERENCES seller_listings(id) ON DELETE CASCADE;

ALTER TABLE product_qa
  ADD COLUMN IF NOT EXISTS seller_id INTEGER
    REFERENCES sellers(id) ON DELETE CASCADE;

-- ─── Seller Store Page: Follows ────────────────────────────────────────────
-- New table backing the "Follow" button on the buyer-facing Seller Store
-- Page (GET /sellers/:id). Stores userId as the Clerk id (text), same
-- convention as wishlist.user_id, rather than users.id -- every route
-- already has req.userId/req.dbUser.clerkId on hand, so this matches how
-- wishlist/reviews/cart already key rows to a buyer.
CREATE TABLE IF NOT EXISTS follows (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  seller_id INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS follows_user_seller_unique
  ON follows (user_id, seller_id);

-- ─── Admin-Custodial bKash Payments, Part 1: Schema ────────────────────────
-- New payments design (see PART1_HANDOFF.md): platform holds ONE bKash
-- merchant account, buyers pay into it, sellers register a plain payout
-- number instead of merchant API credentials, platform disburses via B2C
-- after delivery (Part 3, not built yet). Old seller_payment_configs table
-- is left in place, untouched, still functional -- not migrated off yet.
-- Applied via `drizzle-kit push` against schema/index.ts, not by running
-- this file directly -- included here only for the same narrative-log
-- continuity this file has followed for every prior phase.

CREATE TABLE IF NOT EXISTS platform_payment_config (
  id SERIAL PRIMARY KEY,
  singleton TEXT NOT NULL UNIQUE DEFAULT 'singleton',
  provider TEXT NOT NULL DEFAULT 'bkash',
  merchant_app_key TEXT NOT NULL,
  merchant_app_secret TEXT NOT NULL,
  merchant_username TEXT NOT NULL,
  merchant_password TEXT NOT NULL,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seller_payout_accounts (
  id SERIAL PRIMARY KEY,
  seller_id INTEGER NOT NULL UNIQUE REFERENCES sellers(id) ON DELETE CASCADE,
  bkash_number TEXT NOT NULL,
  account_holder_name TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- No unique constraint on order_id -- a payout is a discrete attempt, not
-- a continuously-updated status; retries are expected to add new rows.
-- See payouts.ts's doc comment for the full reasoning (this differs from
-- order_shipments.order_id's UNIQUE, deliberately).
CREATE TABLE IF NOT EXISTS payouts (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  seller_id INTEGER NOT NULL REFERENCES sellers(id),
  amount NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  bkash_transaction_id TEXT,
  failure_reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- ─── Admin-Custodial bKash Payments, Part 4: Admin note/adjust columns ─────
-- (see PART4_HANDOFF.md). Purely manual bookkeeping for the project's
-- explicit "case-by-case, never automated" returns-after-payout decision --
-- no code anywhere reads these to compute a balance or trigger a real
-- money movement. Applied via `drizzle-kit push`, same as every table
-- above; included here only for narrative-log continuity.
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS admin_note TEXT;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS clawback_noted_amount NUMERIC(10,2);

-- ─── Buyer-Seller Messaging ────────────────────────────────────────────────
-- Marketplace messaging system: one conversation per buyer-seller pair,
-- messages within each conversation. Follows the same user_id convention
-- as follows/wishlist/cart (Clerk text ID, not users.id integer).

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  buyer_id TEXT NOT NULL,
  seller_id INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  seller_listing_id INTEGER,
  last_message_at TIMESTAMP NOT NULL DEFAULT NOW(),
  buyer_archived BOOLEAN NOT NULL DEFAULT FALSE,
  seller_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One conversation per buyer-seller pair
CREATE UNIQUE INDEX IF NOT EXISTS conversations_buyer_seller_unique
  ON conversations (buyer_id, seller_id);

-- Efficient "my conversations sorted by latest" query
CREATE INDEX IF NOT EXISTS conversations_buyer_last_msg_idx
  ON conversations (buyer_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_seller_last_msg_idx
  ON conversations (seller_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  image_url TEXT,
  read_by_buyer BOOLEAN NOT NULL DEFAULT FALSE,
  read_by_seller BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Efficient "messages for a conversation" query
CREATE INDEX IF NOT EXISTS messages_conversation_id_idx
  ON messages (conversation_id, created_at);

-- migrations/add_chat_attachments.sql
-- Add file attachment support to messages: images, files, video, audio.
-- Backward compatible — imageUrl stays for old clients, fileUrl is canonical.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS file_url TEXT,
  ADD COLUMN IF NOT EXISTS file_name TEXT,
  ADD COLUMN IF NOT EXISTS file_size BIGINT,
  ADD COLUMN IF NOT EXISTS file_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS attachment_type TEXT;

-- Backfill attachment_type for existing image messages so the new UI
-- renders them as inline images instead of text bubbles.
UPDATE messages
  SET attachment_type = 'image',
      file_url = image_url
  WHERE message_type = 'image'
    AND image_url IS NOT NULL
    AND attachment_type IS NULL;

-- Index for sorting/pagination by conversation
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
  ON messages (conversation_id, created_at DESC);

-- ─── Presence tracking (online/offline/last seen) ─────────────────────────
-- Adds last_seen_at to the users table so the chat can show "Online" or
-- "last seen at <time>" next to each participant's name. The frontend
-- sends a heartbeat to POST /api/presence/heartbeat every 30 seconds
-- while the user is active; the server treats last_seen_at within the
-- last 60 seconds as "online". Idempotent (IF NOT EXISTS) so it's safe
-- to run on every startup.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP;

-- Index for efficient "who is online" queries (e.g. admin dashboards,
-- future "online sellers" filter). Without this, any query filtering
-- on last_seen_at would scan the entire users table.
CREATE INDEX IF NOT EXISTS idx_users_last_seen_at
  ON users (last_seen_at DESC);

-- ─── Message edit + delete tracking ──────────────────────────────────────
-- Adds three columns to messages:
--   edited_at   : timestamp of the most recent edit (null = never edited)
--   is_deleted  : soft-delete flag (true after the sender deletes the msg)
--   deleted_at  : timestamp of deletion (null if not deleted)
--
-- Soft-delete matches WhatsApp/Telegram semantics: a deleted message stays
-- in the thread as a tombstone ("This message was deleted") so the
-- conversation's read-receipt sequence and timestamps stay intact. We
-- never hard-delete chat messages.
--
-- Idempotent (IF NOT EXISTS) so it's safe to run on every startup.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

