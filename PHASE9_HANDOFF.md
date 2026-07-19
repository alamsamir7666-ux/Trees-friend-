# Phase 9 Handoff — Payment-Config Money-Safety (B1), Reconciliation (B2), Courier Constraint Fix (C)

## What this covers
Three bundled pieces of work, done in order: (B1) expose live
`seller.hasVerifiedPaymentConfig` on the cart response so checkout can't
offer bKash for a seller whose config has drifted out of verified state;
(B2) reconcile `seller_listings.paymentMethod` back to `"cod"` at the two
call sites that remove/revoke a seller's payment-config verification; (C)
fix the `seller_courier_configs.sellerId` unique-constraint gap Phase 8
found and confirmed. All three were verified against a real, provisioned
Postgres instance, not structurally only.

## Verified, not assumed (re-run at the start of this session, before any code)
- `pnpm install --frozen-lockfile` — clean. No stale `.tsbuildinfo` files
  existed in the zip.
- `pnpm run typecheck` (full workspace, all 4 packages) — clean from a cold
  start.
- Real `vite build` in `artifacts/tree-friend` — succeeds.
  `SellerDashboardPage` = **44.18 kB** (gzip 9.96 kB) — matches Phase 8's
  reported number exactly (this file was untouched this session, so an
  exact match is expected, not just plausible).
- Real `node build.mjs` in `artifacts/api-server` — succeeds. `dist/index.mjs`
  = **11.8 MB**, matching Phase 8's reported size exactly at the *start* of
  this session (before any code changes).
- Boot test with no env vars — fails **only** on missing `DATABASE_URL`, as
  every prior phase reported.
- Spot-checked directly in schema source (not just trusting Phase 8's
  handoff) that `seller_payment_configs.sellerId` had `.unique()` and
  `seller_courier_configs.sellerId` did not, before any change was made.
  Confirmed the same asymmetry live via `\d` against a real database.
- Provisioned real Postgres in this session's own container (a fresh
  container does not persist Phase 8's instance — reproduced from scratch
  using Phase 8's own copy-pasteable commands, which worked verbatim: same
  `archive.ubuntu.com` install, same `deb.nodesource.com` 403 that isn't
  needed, same `pg_ctlcluster 16 main start` approach). Pushed the schema
  (`pnpm run push` in `lib/db`) — 36 tables, no errors, no interactive
  conflict prompts.
- Ran Phase 8's `verify-seller-marketplace.ts` **twice, before touching any
  code** — **17 passed, 0 failed**, both times, including the courier-config
  gap finding (`seller_courier_configs: DB allows a 2nd row for the same
  seller`). This confirms this session started from the same real, tested
  baseline Phase 8 left, not just a plausible-looking transcript.

## What was built

### Part B1 — `seller.hasVerifiedPaymentConfig` on the cart response
**Backend** (`artifacts/api-server/src/routes/cart.ts`): `buildCart()` now
runs a third query in the existing `Promise.all` alongside
`variantLines`/`listingLines` — well, actually a batched follow-up query
run right after that `Promise.all` resolves (not inside it, since it needs
`listingLines`'s seller IDs first) — that fetches
`sellerPaymentConfigsTable` rows for the distinct `sellerId`s present in
the cart's listing lines, via `inArray` (no N+1, one query regardless of
how many seller-listing lines are in the cart). Each seller-listing line's
`seller` object now carries `hasVerifiedPaymentConfig: boolean`, true only
if a row exists AND `isVerified === true` — the exact same rule
`hasVerifiedPaymentConfig()` in `sellerListings.ts` uses (that function
itself was not touched or exported; this is a parallel, verbatim-matching
reimplementation in `cart.ts`, same convention Phase 8's own script already
used for the identical reason).

**OpenAPI**: `lib/api-spec/openapi.yaml`'s `CartItemSeller` schema gained
`hasVerifiedPaymentConfig: boolean` (required). Ran `pnpm run codegen` in
`lib/api-spec` — regenerated `lib/api-client-react/src/generated/api.schemas.ts`
and `lib/api-zod/src/generated/api.ts` cleanly, then confirmed by direct
`grep` that the regenerated `CartItemSeller` type actually contains the new
field before touching the frontend (not assumed from codegen "succeeding").

**Frontend** (`artifacts/tree-friend/src/pages/CheckoutPage.tsx`):
`allowedMethodsForListingPaymentMethod(pm: string)` became
`allowedMethodsForListingPaymentMethod(pm: string, hasVerifiedPaymentConfig: boolean)`.
Behavior: `"cod"` listings unaffected; `"advance"` listings now return `[]`
(not `["bkash"]`) when the seller's config isn't verified — meaning neither
button is enabled for that seller group, which is intentional: an
`"advance"`-only listing from an unverified seller has no valid payment
method left, and the UI already handles an empty `allowed` set by disabling
every button (pre-existing `disabled={!allowed.includes(method)}` logic,
untouched). `"both"` listings drop to `["cod"]` when unverified. The single
call site (line ~489 after this session's edits) was updated to pass
`ci.seller?.hasVerifiedPaymentConfig ?? false`. No other call sites existed
(confirmed by grep before editing). No visual/styling changes — same
buttons, same disabled-state class logic, this is a logic-only change to
which buttons are enabled, per the task brief's instruction.

**Verification**: typecheck and build both clean (api-server, tree-friend).
`page-checkout` JS chunk grew from 21.78 kB to 21.84 kB gzip (8.07→8.10 kB)
— consistent with a small logic addition, not a redesign.
`SellerDashboardPage`'s untouched 44.18 kB confirms no unrelated drift.
Extended `scripts/src/verify-seller-marketplace.ts` with a new **§6**
section that reimplements `cart.ts`'s exact batched query (same convention
as the script's existing `hasVerifiedPaymentConfig`/
`groupBySellerAndAllocateDiscount` reimplementations, for the same
reason — the query is inline in a route file, not an exported function) and
confirms against real rows: seller1 (verified config) reads `true`,
seller2 (no config row at all) reads `false`.

### Part B2 — Reconciliation on payment-config delete/unverify
Both call sites now run the same single, non-destructive UPDATE after the
delete/unverify:
```sql
UPDATE seller_listings SET payment_method = 'cod'
WHERE seller_id = :id AND payment_method != 'cod'
```
- `artifacts/api-server/src/routes/sellerPaymentConfigs.ts`'s
  `DELETE /seller-payment-configs/mine` — runs it after the config row is
  deleted, scoped to `req.dbSeller!.id`.
- `artifacts/api-server/src/routes/adminSellers.ts`'s
  `PUT /admin/seller-payment-configs/:id/unverify` — runs it after the
  `isVerified: false` update, scoped to `existing.sellerId` (the looked-up
  config row's seller, not the config's own `id`).

**Tradeoff considered and accepted, not silently decided**: a listing that
was `"both"` (COD + advance) loses that combined state and becomes plain
`"cod"` — there's no way in the current schema (a single text enum column,
not two independent booleans) to represent "advance disabled but the
seller's intent to also offer advance is remembered." A seller who
re-verifies later must manually re-set `"both"`/`"advance"` on any listing
where they want it back; it does not auto-restore. This was judged
low-stakes (a seller re-entering a payment-method choice, not losing data
they can't easily re-enter) and consistent with Part B1 already making
checkout money-safe regardless of what a listing displays — this
reconciliation is about keeping the listing's *displayed* state honest, not
about enforcing checkout correctness (that's already covered independently
by B1). No batch-size/locking concern: each call site is scoped to one
seller's listings via a single UPDATE statement, no per-row loop.

**Verification**: typecheck clean. Extended the verify script with a new
**§7** section: creates a verified config for seller1 (already existed from
earlier in the script) and flips `listing1` to `"advance"`, confirms that
state, then reimplements the DELETE route's body (delete + reconciliation
UPDATE) directly against the real database, and confirms
`listing1.paymentMethod` is actually `"cod"` **in the database** afterward
— not just in a hypothetical response payload — plus confirms the config
row is actually gone.

### Part C — `seller_courier_configs.sellerId` unique constraint
Added `.unique()` to `lib/db/src/schema/sellerCourierConfigs.ts`'s
`sellerId` column, mirroring `sellerPaymentConfigs.ts` exactly (same
`.notNull().unique().references(...)` chain). Updated the file's doc
comment to note the fix and its provenance (Phase 8 found the gap, Part C
of this session closed it).

**Pre-push check**: queried the live test database for existing duplicate
`seller_id` rows in `seller_courier_configs` before pushing — **zero**
found (the verify script's own cleanup at the end of each run removes its
test rows via cascade, so no leftover violating data existed). No
data-cleanup step was needed. Noting for the record in case this were a
real deployment: a production migration adding this constraint would need
to check for and resolve any existing duplicate-seller_id rows first,
exactly the same check this session ran, just potentially with a non-empty
result there.

**Pushed** via `pnpm run push` in `lib/db` against the real Postgres
instance — succeeded, no errors, no interactive prompts. Confirmed via
`\d seller_courier_configs` that `seller_courier_configs_seller_id_unique`
now exists as a real `UNIQUE CONSTRAINT`, matching
`seller_payment_configs_seller_id_unique`'s shape exactly.

**Script assertion updated, as instructed**: `verify-seller-marketplace.ts`'s
§4 previously asserted the courier-configs duplicate insert would
**succeed** (that was Phase 8's finding — the whole point was proving the
gap was real). After this fix, that assertion would now be testing the
wrong thing, so it was changed to assert the duplicate insert **fails**
with Postgres error `23505` — same `err.cause?.code === "23505"` unwrapping
pattern already established in this script for the payment-configs check
(DrizzleQueryError wraps the real driver error; `.message` is the query
text, not the Postgres error). A comment was added directly above the
changed assertion explaining explicitly that a previously-passing
assertion was flipped and why, per the task's request not to silently swap
this without a written note. Row-count assertion also updated: previously
expected 2 rows to confirm the gap; now expects 1 row (the rejected insert
should leave no trace) to confirm the guard holds.

## Full-session real-database verification results
Ran the extended `verify-seller-marketplace.ts` **twice** after all three
parts were complete — both times: **22 passed, 0 failed**.

Final run's full section list:
1. seller/category/product/listing creation — 6 checks (Phase 8, unchanged)
2. `hasVerifiedPaymentConfig()` real-query behavior — 2 checks (Phase 8, unchanged)
3. cart_items across two sellers → `groupBySellerAndAllocateDiscount` — 5 checks (Phase 8, unchanged)
4. DB-level uniqueness assumptions — 3 checks, **one assertion flipped this session** (courier config now correctly rejects duplicates; row count now expects 1, not 2)
5. reviews unique constraint — 1 check (Phase 8, unchanged)
6. **new this session**: `cart.ts` batched `hasVerifiedPaymentConfig` query — 2 checks
7. **new this session**: B2 reconciliation on payment-config delete — 3 checks

Confirmed re-runnable (ran twice in direct succession, both clean, matching
the self-cleaning convention every prior phase's script has followed).

## Full-session structural re-verification (after all 3 parts)
- Deleted all `.tsbuildinfo` files and re-ran `pnpm run typecheck` — clean,
  all 4 packages, cold start.
- Re-ran `vite build` in `tree-friend` — succeeds.
  `SellerDashboardPage` still **44.18 kB** (untouched this session,
  confirms no unrelated drift). `page-checkout` chunk grew slightly
  (21.78 kB → 21.84 kB gzip) from the B1 logic addition, as expected.
- Re-ran `node build.mjs` in `api-server` — succeeds, `dist/index.mjs`
  still **11.8 MB**.
- Boot test with no env vars — still fails **only** on missing
  `DATABASE_URL`.

## File-diff confirmation (against the original Phase 8 zip)
Ran a full recursive diff (`node_modules`/`dist`/`.tsbuildinfo` excluded)
between the untouched original zip contents and this session's final
state. **Exactly 9 files differ, nothing else**:
- `artifacts/api-server/src/routes/adminSellers.ts` (B2)
- `artifacts/api-server/src/routes/cart.ts` (B1)
- `artifacts/api-server/src/routes/sellerPaymentConfigs.ts` (B2)
- `artifacts/tree-friend/src/pages/CheckoutPage.tsx` (B1)
- `lib/api-client-react/src/generated/api.schemas.ts` (B1, codegen output)
- `lib/api-spec/openapi.yaml` (B1)
- `lib/api-zod/src/generated/api.ts` (B1, codegen output)
- `lib/db/src/schema/sellerCourierConfigs.ts` (Part C)
- `scripts/src/verify-seller-marketplace.ts` (B1 §6, B2 §7, Part C §4 update)

Confirmed byte-for-byte untouched (explicit diff, not assumed):
`orderShipments.ts`, `sellerListings.ts`, `orders.ts`, `scripts/package.json`,
and everything under Store Settings / Customer Chat / Analytics / Withdraw
Earnings / Manage Coupons scope. No new files created or deleted anywhere
in the tree.

Confirmed by direct grep: neither `groupBySellerAndAllocateDiscount` nor
`hasVerifiedPaymentConfig` was exported from `orders.ts`/`sellerListings.ts`
— B1/B2 didn't need either function's real logic outside test code, so per
the brief's own instruction this was left as Phase 8 flagged it, not tidied
up as a side effect.

## What remains structurally-verified-only / explicitly out of scope
Unchanged from Phase 8's own list — this session didn't touch any of these:
- No HTTP-level testing (no Clerk test credentials or auth bypass exist in
  this sandbox).
- Cloudinary, live bKash/Pathao/Steadfast credential checks, courier/payment
  webhook adapters — untested, unchanged.
- Order-completion → review-eligibility end-to-end flow — not exercised.
- Store Settings, Customer Chat, Analytics/Reports, Manage Coupons — out of
  scope, untouched.
- `orderShipments.ts`'s courier-booking query still has no `.limit(1)` at
  its `seller_courier_configs` read (Phase 8's flag #2) — not touched this
  session, since Part C's brief was explicit that this was schema-only and
  nothing there needed to change now that the constraint prevents the
  underlying 2-row case going forward. Worth noting this is now a
  *residual* risk only (any row created before this constraint existed, if
  a real deployment had one, would still need a data-cleanup pass — see
  Part C's pre-push check above, which is why that check was run here).

## Flagged for a future session
1. **B2's "both" → "cod" tradeoff** (see Part B2 above) is a real, accepted
   data-loss-of-preference case, not a bug — but if this ever becomes
   surprising to sellers in practice, a future session could consider
   splitting `paymentMethod` into two independent booleans
   (`offersCod`/`offersAdvance`) so revoking a config only clears the
   advance flag rather than collapsing the whole field. Deliberately not
   done here — bigger schema change than this session's scope, and the
   brief's own guidance was to prefer the smaller fix unless a real problem
   surfaced.
2. **`orderShipments.ts`'s missing `.limit(1)`** (Phase 8 flag #2, still
   unaddressed) — now lower-risk than when flagged, since the unique
   constraint added in Part C prevents new 2-row cases, but any
   pre-existing violating data in a real deployment would still hit this.
3. **Export `groupBySellerAndAllocateDiscount`/`hasVerifiedPaymentConfig`**
   (Phase 8 flag #3, still unaddressed) — B1/B2 didn't need either
   function's real logic in application code, only in test code (where
   they're reimplemented verbatim, same as Phase 8's script already did),
   so this remains deferred to whenever a session actually touches
   `orders.ts` for other reasons.
4. **No HTTP-level integration testing exists yet** (Phase 8 flag #4,
   unchanged) — still the next real gap if Clerk test credentials or an
   auth bypass ever become available.

## Reproducing this session's results
```bash
# From a fresh container with the same network allowlist:
apt-get update && apt-get install -y postgresql postgresql-contrib
pg_ctlcluster 16 main start
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\""
su postgres -c "psql -c \"CREATE DATABASE treefriend;\""

pnpm install --frozen-lockfile
pnpm run typecheck

cd lib/db
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/treefriend" pnpm run push

cd ../../scripts
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/treefriend" pnpm run verify-seller-marketplace
# Expect: 22 passed, 0 failed

cd ../artifacts/tree-friend && pnpm run build
cd ../api-server && node build.mjs && node dist/index.mjs
# Expect: fails only on missing DATABASE_URL
```
