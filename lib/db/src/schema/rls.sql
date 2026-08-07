-- ─── Row-Level Security (RLS) on seller-scoped tables ────────────────────
--
-- Defense-in-depth: the API layer (requireSeller middleware) already
-- enforces seller isolation, but RLS adds a DB-level safety net so a bug
-- in the API layer (e.g. a missing WHERE clause) can't leak another
-- seller's data.
--
-- These policies use `current_setting('app.current_seller_id', true)` —
-- the API layer sets this per-request via `SET LOCAL app.current_seller_id
-- = <id>` inside a transaction. If the setting is missing (direct DB
-- access, or a route that doesn't set it), the policy allows NO rows
-- (fail-closed).
--
-- Tables with RLS enabled:
--   - seller_listings
--   - seller_payment_configs
--   - seller_courier_configs
--   - seller_payout_accounts
--   - seller_subscriptions
--   - payouts (seller can see their own payouts)

-- ─── Enable RLS ───────────────────────────────────────────────────────────

ALTER TABLE seller_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_payment_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_courier_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_payout_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;

-- ─── Policies ─────────────────────────────────────────────────────────────
-- Each table gets:
--   1. A SELECT policy: seller can see their own rows
--   2. An INSERT/UPDATE policy: seller can only write their own rows
--   3. An admin bypass: admins (role = 'admin' in app.current_role) see all

-- seller_listings
CREATE POLICY seller_listings_select ON seller_listings
  FOR SELECT USING (
    current_setting('app.current_role', true) = 'admin'
    OR seller_id = NULLIF(current_setting('app.current_seller_id', true), '')::int
  );

CREATE POLICY seller_listings_modify ON seller_listings
  FOR ALL USING (
    current_setting('app.current_role', true) = 'admin'
    OR seller_id = NULLIF(current_setting('app.current_seller_id', true), '')::int
  );

-- seller_payment_configs
CREATE POLICY seller_payment_configs_select ON seller_payment_configs
  FOR SELECT USING (
    current_setting('app.current_role', true) = 'admin'
    OR seller_id = NULLIF(current_setting('app.current_seller_id', true), '')::int
  );

CREATE POLICY seller_payment_configs_modify ON seller_payment_configs
  FOR ALL USING (
    current_setting('app.current_role', true) = 'admin'
    OR seller_id = NULLIF(current_setting('app.current_seller_id', true), '')::int
  );

-- seller_courier_configs
CREATE POLICY seller_courier_configs_select ON seller_courier_configs
  FOR SELECT USING (
    current_setting('app.current_role', true) = 'admin'
    OR seller_id = NULLIF(current_setting('app.current_seller_id', true), '')::int
  );

CREATE POLICY seller_courier_configs_modify ON seller_courier_configs
  FOR ALL USING (
    current_setting('app.current_role', true) = 'admin'
    OR seller_id = NULLIF(current_setting('app.current_seller_id', true), '')::int
  );

-- seller_payout_accounts
CREATE POLICY seller_payout_accounts_select ON seller_payout_accounts
  FOR SELECT USING (
    current_setting('app.current_role', true) = 'admin'
    OR seller_id = NULLIF(current_setting('app.current_seller_id', true), '')::int
  );

CREATE POLICY seller_payout_accounts_modify ON seller_payout_accounts
  FOR ALL USING (
    current_setting('app.current_role', true) = 'admin'
    OR seller_id = NULLIF(current_setting('app.current_seller_id', true), '')::int
  );

-- seller_subscriptions
CREATE POLICY seller_subscriptions_select ON seller_subscriptions
  FOR SELECT USING (
    current_setting('app.current_role', true) = 'admin'
    OR seller_id = NULLIF(current_setting('app.current_seller_id', true), '')::int
  );

CREATE POLICY seller_subscriptions_modify ON seller_subscriptions
  FOR ALL USING (
    current_setting('app.current_role', true) = 'admin'
    OR seller_id = NULLIF(current_setting('app.current_seller_id', true), '')::int
  );

-- payouts
CREATE POLICY payouts_select ON payouts
  FOR SELECT USING (
    current_setting('app.current_role', true) = 'admin'
    OR seller_id = NULLIF(current_setting('app.current_seller_id', true), '')::int
  );

-- ─── Note on app.current_role and app.current_seller_id ───────────────────
-- The API layer must set these via SET LOCAL inside a transaction:
--
--   await db.transaction(async (tx) => {
--     await tx.execute(sql`SET LOCAL app.current_role = ${req.dbUser.role}`);
--     if (req.dbSeller) {
--       await tx.execute(sql`SET LOCAL app.current_seller_id = ${req.dbSeller.id}`);
--     }
--     // ... query ...
--   });
--
-- If not set, current_setting(..., true) returns NULL, and the policy's
-- WHERE clause evaluates to NULL = 'admin' OR seller_id = NULL::int →
-- NULL OR NULL → NULL → false → no rows returned (fail-closed).
