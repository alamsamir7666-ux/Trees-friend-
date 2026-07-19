# Phase 6 Handoff — Payment/Courier Config Verification + Payment Settings Frontend (Part 6)

## What this covers
Closes the two biggest gaps `PHASE5_HANDOFF.md` flagged: (1) a
verification flow for `seller_payment_configs` / `seller_courier_configs`
(admin-review toggle, not live bKash/Pathao/Steadfast API checks), and (2)
`PaymentSettingsForm.tsx` + seller-dashboard wiring, so a seller can
actually reach `POST /seller-payment-configs` from the UI. Both of Phase
5's optional stretch items (cart/listing response exposing verified-config
status; a cascade/reconciliation pass on config delete) were **not**
built — flagged as still open below, per the task brief's instruction to
ask before spending effort there rather than build silently.

## Verified, not assumed (re-run at the start of this session, before any code)
- `pnpm install --frozen-lockfile` — clean.
- Cleared all `.tsbuildinfo` files; confirmed no stale `dist/` existed
  under `lib/*` before rebuilding (same caching issue the task brief
  warned about) — `pnpm run typecheck:libs` from scratch: clean.
- `pnpm run typecheck` (full workspace, all 4 packages) — clean.
- Real `vite build` in `artifacts/tree-friend` — succeeds. `page-checkout`
  at 21.78kB and `SellerDashboardPage` at 30.60kB **matched
  `PHASE5_HANDOFF.md`'s claimed sizes exactly**, confirming Phase 5's
  frontend claims before touching anything.
- Real `node build.mjs` in `artifacts/api-server` — succeeds; boot-tested
  with no env vars, failed **only** on missing `DATABASE_URL`.
- Spot-checked every specific claim in `PHASE5_HANDOFF.md`, by reading the
  actual files, not trusting the doc:
  - `routes/sellerPaymentConfigs.ts` exists, registered in
    `routes/index.ts` — confirmed.
  - `CourierSettingsForm.tsx` exists at
    `src/components/seller/CourierSettingsForm.tsx`; no
    `PaymentSettingsForm.tsx` existed anywhere in `src` — confirmed via
    `find`, not grep-guessing. The route genuinely was unreachable from
    the UI, only a stale comment in `SellerListingForm.tsx` referenced
    "Payment Settings, coming in a later phase."
  - `hasVerifiedPaymentConfig()` in `sellerListings.ts` and the inline
    check in `orders.ts` both gate on `isVerified === true` specifically
    (not row existence) — confirmed by reading both files directly.
  - `sellerPaymentConfigsTable.isVerified` and
    `sellerCourierConfigsTable.isVerified` were confirmed to never be set
    `true` anywhere in the pre-Phase-6 codebase (grepped both route files
    end to end) — the "permanently false" claim was accurate.
- Read plan doc §7/§8 again for the verification-method ambiguity the
  task brief asked about: genuinely unspecified which mechanism
  (live-credential check vs. admin toggle) was intended. Found the
  closest precedent in the plan doc itself — §4 lists "Business
  Verification (manual admin review of uploaded docs — not automated
  KYC)" as a phase-1 dashboard item, and §9 says "No automated
  KYC/business verification — manual admin review only" as an explicit
  non-goal for anything adjacent. That's a strong, plan-doc-internal
  precedent for the admin-review-toggle interpretation, not just "no
  sandbox credentials exist so default to the easier option." Proceeded
  with the admin-toggle direction on that basis rather than stopping to
  ask — the ambiguity was resolvable from the plan doc itself, not a
  coin-flip.

## What was built

### 1. Verification flow — admin-review toggle (plan §7/§8 ambiguity, resolved above)
**`routes/adminSellers.ts`** (extended, not a new file — this is where
`approveSeller`/`rejectSeller`/`suspendSeller` already lived, same
"admin acts on something a seller submitted" pattern):
- `GET /admin/seller-payment-configs?verified=<bool>` — masked list,
  defaults to unverified (the actual review queue).
- `PUT /admin/seller-payment-configs/:id/verify` — the **only** place
  `seller_payment_configs.isVerified` is ever set `true`. 400s if already
  verified, 404 if the config doesn't exist. Audit-logged via the
  existing `logAudit()` helper (`sellerPaymentConfig.verified` action,
  before/after `isVerified` + `sellerId`).
- `PUT /admin/seller-payment-configs/:id/unverify` — revokes, same
  guard/audit pattern. Does not touch `seller_listings` (same "no
  cascade" behavior as the `DELETE` route, see gap below).
- The same three-route shape for `seller_courier_configs`
  (`GET /admin/seller-courier-configs`, `.../verify`, `.../unverify`).
  Courier verification exists for symmetry and because the task brief's
  item 1 named both tables, but **nothing currently reads
  `seller_courier_configs.isVerified`** to gate any behavior — courier
  booking (`routes/sellerOrders.ts`'s "Book Courier" action) was Part 4
  scope and untouched here. Flagging this explicitly: courier
  verification today only changes what the seller dashboard displays,
  not what a seller can do, unlike payment verification which gates real
  functionality end to end.
- All six new routes use the existing `requireAdmin` middleware, same
  guard pattern as `approveSeller`/`suspendSeller`.
- No live bKash/Pathao/Steadfast API call anywhere in these routes. An
  admin is expected to confirm the credentials work by some means outside
  the system (e.g. a manual test transaction) before clicking Verify —
  documented in the route's doc comment so a future session doesn't
  mistake the button for an automated check.

**`openapi.yaml`**: 6 new paths (65 total, up from 59), reusing the
existing `SellerPaymentConfig`/`SellerCourierConfig` response schemas (no
new schemas needed — verify/unverify return the same masked shape the
seller-facing GET already returns). Validated as parseable YAML before
running codegen.

**Codegen (`orval`)** ran clean against the updated spec — confirmed this
works fully offline (no network calls, reads only the local
`openapi.yaml`), so this session had no external-network blocker. New
hooks confirmed generated and typed correctly:
`useListAdminSellerPaymentConfigs`, `useVerifySellerPaymentConfig`,
`useUnverifySellerPaymentConfig`, `useListAdminSellerCourierConfigs`,
`useVerifySellerCourierConfig`, `useUnverifySellerCourierConfig`.

**Admin UI** — added to `SellersTab.tsx` (extended, not a new tab file,
per the task brief's "existing SellersTab.tsx or a new tab" wording — a
new top-level admin nav entry felt like heavier scope than a review
queue warranted, especially since it's the same "review something a
seller submitted" shape as the seller-status queue already in that
file). New `PendingConfigVerification` sub-component rendered below the
existing seller list:
- Payment/Courier toggle, Pending/Verified toggle (mirrors the existing
  `STATUS_TABS` `Tabs`/`TabsList` pattern already in the file).
- Each row shows masked credentials + seller ID; a "Verify" button
  (pending view only) with a `confirm()` guard reminding the admin this
  isn't an automated check.
- Not built: linking a config row back to the seller's business
  name/contact info (the admin list endpoints return raw config rows,
  keyed only by `sellerId`, not a joined seller name). An admin currently
  has to cross-reference "Seller #N" against the seller list above by ID.
  Flagged as a real but minor UX gap, not fixed here — would need either
  a join in the admin list route or a second lookup call per row on the
  frontend, judged unnecessary scope for this session's stated priority
  (get verification working at all, not polish the admin UX around it).

### 2. Payment Settings frontend (task item 2)
**`src/components/seller/PaymentSettingsForm.tsx`** (new) — read
`CourierSettingsForm.tsx` directly before writing anything, per the task
brief's instruction not to guess the shape. Mirrors it exactly: same
loading-skeleton / empty-state / connected-state structure, same
delete-confirm pattern, same `invalidate()`-on-success convention. Differs
only where the underlying schema differs — bKash's 4 required fields
(`merchantAppKey`/`merchantAppSecret`/`merchantUsername`/
`merchantPassword`, all required together, no provider branch) vs.
courier's provider-conditional 2-4 field shape.

Connected-state card explicitly surfaces verification status per the task
brief's requirement ("saving credentials does not immediately unlock
advance payment... surface whatever verification-status/pending-state you
build"):
- `isVerified === true` → green "Verified — your listings can offer
  advance/bKash payment."
- `isVerified === false` → amber "Saved, pending verification — an admin
  reviews new payment accounts before advance/bKash payment unlocks. Your
  listings stay COD-only until then."

**`src/pages/SellerDashboardPage.tsx`** — added a "Payment Settings" tab
(new `TabsTrigger`/`TabsContent` pair, between "Orders" and "Courier
Settings"), imported and rendered `PaymentSettingsForm`. Updated the
file's top doc comment, which previously explicitly listed "Payment
Settings (seller_payment_configs)" under "still NOT built here" — that
was accurate before this session and is now stale, corrected.

**`src/components/seller/SellerListingForm.tsx`** — fixed a stale UI
string found during the initial re-verification pass. It read *"Advance
payment requires a verified bKash merchant account (Payment Settings,
coming in a later phase). Selecting it now won't be enforced against a
real config yet."* Both halves were wrong as of Phase 5: enforcement
*was* already live server-side (`hasVerifiedPaymentConfig()`,
Phase 5), and Payment Settings is now built, not "a later phase." Updated
to accurately describe current behavior (admin verification required,
enforced server-side, will 400 if attempted without it).

## Verified, not assumed (this session's own work, before packaging)
- Cleared `.tsbuildinfo` again after all edits; full `pnpm run typecheck`
  from scratch — clean across all 4 packages.
- Real `vite build` — succeeds. `SellerDashboardPage` grew 30.60kB →
  35.00kB (new `PaymentSettingsForm` + tab, expected). `page-admin` grew
  170.20kB → 173.83kB (new verification section, expected).
  `page-checkout` unchanged at 21.78kB, correctly untouched since this
  session didn't touch checkout.
- Real `node build.mjs` — succeeds; boot-tested, fails only on
  `DATABASE_URL`, same baseline as every prior phase.
- `grep`-confirmed all six new admin routes
  (`/admin/seller-payment-configs`, `.../verify`, `.../unverify`, and the
  courier-config equivalents) are present in the compiled
  `dist/index.mjs` bundle, not just source.
- `grep`-confirmed the new frontend strings ("Connect your bKash Merchant
  account", "Saved, pending verification", "Payment & Courier
  Verification") are present in the built `SellerDashboardPage` and
  `page-admin` JS chunks, not just source.
- `openapi.yaml` validated as parseable YAML (65 paths, up from 59)
  before running codegen. Codegen ran clean; all 6 new hooks confirmed
  generated and typechecking correctly against both
  `PaymentSettingsForm.tsx`'s and `SellersTab.tsx`'s actual usage.
- **Structural round-trip check** (no live database in this
  environment, same constraint every prior phase hit, so this is a code
  trace, not a runtime test): traced
  save config → confirm isVerified false → admin marks verified → confirm
  listing write for advance/both now succeeds:
  1. `POST /seller-payment-configs` inserts with `isVerified: false`
     (hardcoded in `sellerPaymentConfigs.ts`, unconditionally on every
     insert — confirmed by reading the route).
  2. `GET /seller-payment-configs/mine` returns that row unmasked-shape
     (`isVerified: false`) — `PaymentSettingsForm.tsx`'s connected-state
     branch reads `config.isVerified` directly off this response, no
     transform in between.
  3. `PUT /admin/seller-payment-configs/:id/verify` updates the same row
     (`WHERE id = :id`, matched by the config's own `id`, not `sellerId`
     — confirmed the frontend has this `id` available from the list
     response) to `isVerified: true`.
  4. `hasVerifiedPaymentConfig(sellerId)` in `sellerListings.ts` queries
     by `sellerId` (not config `id`), `LIMIT 1`, checks
     `config?.isVerified === true` — since step 3 updated the seller's
     only config row (unique per seller, delete-then-insert pattern), this
     now returns `true` for that seller.
  5. `POST /seller-listings` / `PUT /seller-listings/:id` with
     `paymentMethod: "advance"` calls `hasVerifiedPaymentConfig` and, per
     step 4, now proceeds instead of 400ing.
  Every link in this chain was read directly in the actual route/component
  code, not assumed from either handoff doc. Not runtime-tested — no
  Postgres available in this environment, same as every prior phase.

## What's still not built / known gaps (flagged, not papered over)

1. **No cascade/reconciliation on delete or unverify** (Phase 5 gap #3,
   still open). Neither the seller-facing
   `DELETE /seller-payment-configs/mine` nor this session's new
   `PUT /admin/seller-payment-configs/:id/unverify` touch
   `seller_listings` at all. `routes/orders.ts`'s checkout-time re-check
   (Phase 5) still prevents a buyer from actually completing a bKash
   payment to an unverified seller, so this remains a display-only
   inconsistency, not a money-safety one — but a listing can still show
   "accepts advance payment" after an admin revokes verification, until
   the seller or an admin manually edits it. Not built this session
   either; the task brief listed this as optional/ask-first, and the
   session's required scope (verification flow + Payment Settings
   frontend) filled the available effort.
2. **No cart/listing-response exposure of verified-config status**
   (Phase 5 gap #4, still open). `CheckoutPage.tsx` still can't
   proactively grey out an unverified seller's bKash button — a buyer can
   still select it and get a rejected-submission error rather than a
   disabled control. Same reasoning as #1: task brief flagged this as
   optional/ask-first, not attempted.
3. **Courier verification has no functional effect yet** (new gap,
   introduced by this session's own scope, flagged rather than implied to
   be equivalent to payment verification). The admin can mark a courier
   config verified/unverified, and the seller dashboard's
   `CourierSettingsForm.tsx` already displays an "isVerified" notice (from
   Phase 4), but nothing in `routes/sellerOrders.ts`'s courier-booking
   flow actually checks `seller_courier_configs.isVerified` before
   allowing "Book Courier." Building that check was out of this session's
   scope (Part 4's courier booking logic wasn't touched), but leaving the
   admin toggle without a corresponding enforcement point is worth a
   future session's attention — right now verifying a courier config only
   changes a badge, not behavior, unlike payment verification.
4. **Admin config-review UI doesn't show the seller's business name**,
   only their numeric ID — cross-referencing against the seller list
   above requires the admin to remember or look up which ID belongs to
   which business. Flagged above under "What was built," repeated here
   since it's a real UX gap worth fixing before this ships to an actual
   admin user, just not blocking.
5. **`CourierSettingsForm.tsx`'s existing "Not verified yet" copy is
   itself slightly inaccurate** (found during this session's
   re-verification pass, not fixed — out of this session's stated scope
   of payment configs + verification routes, not courier UI copy). It
   reads *"your first 'Book Courier' attempt on an order will confirm
   these credentials work"* — per gap #3 above, no such live check exists
   anywhere in the courier-booking route. Flagging for a future courier
   session rather than silently leaving a misleading claim unflagged.

## Explicitly out of scope for this session (not touched)
- Store Settings, Vacation Mode, Manage Discounts UI, Pathao
  city/zone/area resolution, webhook signature verification — still out
  of scope per every prior handoff.
- Live bKash/Pathao/Steadfast credential verification against a real
  sandbox — deliberately not attempted, no sandbox credentials exist in
  this environment to build or test against; the admin-toggle flow above
  is the chosen substitute, not a stopgap pending a "real" version — the
  plan doc's own §9 treats "manual admin review" as the intended phase-1
  mechanism for the adjacent Business Verification flow, so this isn't
  presented as a downgrade.
- Cart/listing-response verified-status exposure and the delete/unverify
  cascade (Phase 5 gaps #3/#4) — task brief flagged both as
  optional/ask-first; neither was attempted, both re-flagged above rather
  than silently dropped.
- Courier-booking enforcement of `seller_courier_configs.isVerified` —
  new gap surfaced by this session's own admin-toggle work, flagged above,
  not built (Part 4 courier booking logic untouched).
