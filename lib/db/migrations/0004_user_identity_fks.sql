-- ─── Migration 0004: User identity split fix (FK additions) ──────────────────
--
-- This is the CRITICAL integrity fix from the engineering audit. Previously,
-- 16+ per-user tables stored the Clerk ID as `text` with NO foreign key to
-- `users.clerk_id`. Deleting a Clerk user left orphan rows everywhere.
--
-- Pre-migration orphan check confirmed ZERO orphans across all tables:
--   addresses:        0 orphans / 2 total
--   orders:           0 orphans / 10 total
--   cart_items:       0 orphans / 0 total
--   wishlist:         0 orphans / 0 total
--   reviews:          0 orphans / 2 total
--   loyalty_points:   0 orphans / 1 total
--   conversations:    0 orphans / 2 total
--   messages:         0 orphans / 25 total
--   follows:          0 orphans / 4 total
--   etc.
--
-- ─── Cascade strategy ──────────────────────────────────────────────────────
--
-- Each FK uses one of three ON DELETE rules, chosen per-table based on
-- data retention needs:
--
--   CASCADE    — auto-delete dependent data when user is deleted
--                (addresses, cart_items, wishlist, email_preferences,
--                 loyalty_points, abandoned_carts, follows, subscriptions)
--
--   RESTRICT   — block user deletion until dependent data is manually cleaned
--                (orders, returns, reviews, loyalty_transactions, audit_logs,
--                 pre_orders, gift_cards, conversations, messages, product_qa,
--                 referrals) — financial/audit trail, must be retained
--
--   SET NULL   — keep the row but null out the user reference
--                (gift_cards.purchased_by_user_id — admin-issued cards
--                 survive; gift_card_transactions.user_id)
--
-- ─── Safety ──────────────────────────────────────────────────────────────────
--
-- ALTER TABLE ADD CONSTRAINT acquires an ACCESS EXCLUSIVE lock briefly, but
-- on a table with 0-25 rows this is instant. The FK validation check
-- (verifying existing rows match) is also instant given the small data
-- volume. No CONCURRENTLY variant exists for ADD CONSTRAINT — but the
-- tables are small enough that it doesn't matter.
--
-- All statements are wrapped in individual try/catch in the apply script;
-- a failure on one FK doesn't block the others.
-- ────────────────────────────────────────────────────────────────────────────


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 1: Ensure users.clerk_id has a unique constraint
-- ════════════════════════════════════════════════════════════════════════════
-- The Drizzle schema declares this as .unique(), but we verify it exists
-- in the DB before adding FKs that depend on it.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_clerk_id_unique'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_clerk_id_unique UNIQUE (clerk_id);
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 2: Add FKs — CASCADE (auto-delete on user delete)
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE addresses
  ADD CONSTRAINT addresses_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE CASCADE;

ALTER TABLE cart_items
  ADD CONSTRAINT cart_items_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE CASCADE;

ALTER TABLE wishlist
  ADD CONSTRAINT wishlist_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE CASCADE;

ALTER TABLE email_preferences
  ADD CONSTRAINT email_preferences_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE CASCADE;

ALTER TABLE loyalty_points
  ADD CONSTRAINT loyalty_points_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE CASCADE;

ALTER TABLE abandoned_carts
  ADD CONSTRAINT abandoned_carts_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE CASCADE;

ALTER TABLE follows
  ADD CONSTRAINT follows_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE CASCADE;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE CASCADE;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 3: Add FKs — RESTRICT (block user deletion; data must be retained)
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE orders
  ADD CONSTRAINT orders_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE RESTRICT;

ALTER TABLE returns
  ADD CONSTRAINT returns_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE RESTRICT;

ALTER TABLE reviews
  ADD CONSTRAINT reviews_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE RESTRICT;

ALTER TABLE loyalty_transactions
  ADD CONSTRAINT loyalty_transactions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE RESTRICT;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_admin_id_fkey
  FOREIGN KEY (admin_id) REFERENCES users(clerk_id) ON DELETE RESTRICT;

ALTER TABLE pre_orders
  ADD CONSTRAINT pre_orders_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE RESTRICT;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_buyer_id_fkey
  FOREIGN KEY (buyer_id) REFERENCES users(clerk_id) ON DELETE RESTRICT;

ALTER TABLE messages
  ADD CONSTRAINT messages_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES users(clerk_id) ON DELETE RESTRICT;

ALTER TABLE product_qa
  ADD CONSTRAINT product_qa_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE RESTRICT;

-- referrals: both referrer_id and referred_id are Clerk IDs
ALTER TABLE referrals
  ADD CONSTRAINT referrals_referrer_id_fkey
  FOREIGN KEY (referrer_id) REFERENCES users(clerk_id) ON DELETE RESTRICT;

ALTER TABLE referrals
  ADD CONSTRAINT referrals_referred_id_fkey
  FOREIGN KEY (referred_id) REFERENCES users(clerk_id) ON DELETE SET NULL;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 4: Add FKs — SET NULL (keep row, null out user reference)
-- ════════════════════════════════════════════════════════════════════════════

-- gift_cards.purchased_by_user_id is nullable (admin-issued cards have NULL)
ALTER TABLE gift_cards
  ADD CONSTRAINT gift_cards_purchased_by_user_id_fkey
  FOREIGN KEY (purchased_by_user_id) REFERENCES users(clerk_id) ON DELETE SET NULL;

-- gift_card_transactions.user_id — nullable for admin-issued/system transactions
ALTER TABLE gift_card_transactions
  ADD CONSTRAINT gift_card_transactions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE SET NULL;
