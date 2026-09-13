-- ─── Migration 0017: Add checkout_session_id to orders ───────────────────────
--
-- Links ALL sibling orders from a single checkout, regardless of payment
-- method. This enables the new checkout flow where a cart with mixed
-- payment methods (COD + Advance) splits into one order per
-- (seller × payment method) combo, but all sibling orders are linked via
-- checkout_session_id so the buyer can see them together in one UI.
--
-- Context: previously, `payment_session_id` linked only bKash orders (for
-- bKash charge grouping). COD orders had no link to their sibling orders
-- at all. The new `checkout_session_id` links ALL sibling orders (both
-- COD and bKash) from the same checkout, enabling:
--   1. A "Checkout Complete" page showing all orders from one checkout.
--   2. A "Sibling orders" section on OrderDetailPage.
--   3. Independent placement of COD vs Advance orders (if buyer abandons
--      one, the other stays placed and the abandoned items stay in cart).
--
-- Design:
--   * TEXT (not uuid) — stores a crypto.randomUUID() string. Using TEXT
--     avoids Postgres uuid type quirks and keeps it consistent with
--     tracking_id (also TEXT).
--   * NULLABLE — legacy orders created before this migration get NULL.
--     New orders always get a value (generated in the POST /orders handler).
--   * Indexed (not unique) — multiple orders share the same session id;
--     the index speeds up `WHERE checkout_session_id = ?` lookups.
--
-- ─── Safety ──────────────────────────────────────────────────────────────────
--   * Idempotent (IF NOT EXISTS on every ADD COLUMN / CREATE INDEX).
--   * Non-breaking — column is nullable, existing queries are unaffected.
--   * No data migration — legacy orders keep NULL, which the frontend
--     handles gracefully (no "sibling orders" section shown).
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_session_id text;

CREATE INDEX IF NOT EXISTS orders_checkout_session_id_idx
  ON orders (checkout_session_id);
