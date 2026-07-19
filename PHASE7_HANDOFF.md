# Phase 7 Handoff — Courier Verification Enforcement + Seller Dashboard Phase-1 Gaps (Part 7)

## What this covers
Two things: (A) closed the courier-booking verification gap Phase 6
flagged (`isVerified` on `seller_courier_configs` was checked by nothing);
(B) built the remaining plan §4 phase-1 seller dashboard items —
Business Profile (merged with Store Settings), Vacation Mode, and the
seller-facing Business Verification doc upload. Manage Discounts (item 4)
was confirmed already satisfied by the existing per-listing
`discountPrice` field — no new page built for it.

## Verified, not assumed (re-run at the start of this session, before any code)
- `pnpm install --frozen-lockfile` — clean.
- Checked for stale `.tsbuildinfo` files per the task brief's warning —
  **none existed in this zip.** The warning didn't apply this session;
  noting the mismatch rather than silently treating it as confirmed.
- `pnpm run typecheck` (full workspace, all 4 packages) — clean from a
  cold start.
- Real `vite build` in `artifacts/tree-friend` — succeeds.
  `SellerDashboardPage` was **35.00 kB** (gzip 8.41 kB) before this
  session's changes — noted as the baseline for the delta below.
- Real `node build.mjs` in `artifacts/api-server` — succeeds. Boot-tested
  with no env vars: fails **only** on missing `DATABASE_URL`, as expected.
- Confirmed `PaymentSettingsForm.tsx` and `CourierSettingsForm.tsx` are
  genuinely imported and rendered as real `TabsContent` in
  `SellerDashboardPage.tsx` (not just present as files) — read the file
  directly.
- Confirmed, by grep, that `routes/sellerOrders.ts` has **zero**
  references to `seller_courier_configs` or `isVerified`. This matched
  the task brief's claim, but the brief pointed at the wrong file — the
  actual "Book Courier" action lives in **`routes/orderShipments.ts`**,
  not `sellerOrders.ts` (which only has manual status-update logic).
  Flagging the file-location error rather than silently working around
  it, since it means whoever wrote the brief was working from a stale
  mental map of the route split.
- Read `middlewares/auth.ts`'s `requireSeller` in full before deciding
  how vacation mode should stay reachable. Confirmed directly: it 403s
  anything but `status === "active"`, which would include a seller's own
  attempt to turn vacation back off if left unchanged.
- Read the `sellers` schema directly (`lib/db/src/schema/sellers.ts`)
  rather than guessing the field list for Business Profile:
  `businessName, nurseryName, ownerName, nidOrTradeLicenseUrl,
  contactPhone, contactEmail, location, description, nurseryImages`.
  Confirmed no field is left over once Business Profile covers all of
  these — Store Settings has no distinct content and was folded in
  rather than built as a separate, empty-ish section.
- Confirmed `products/:productId/seller-listings` in
  `sellerListings.ts` already filters `sellers.status = "active"` —
  read the query directly rather than trusting the task brief's "may
  already work" phrasing. Vacation-mode buyer-side exclusion needed
  zero backend changes as a result.
- Confirmed `POST /sellers/upload-verification-doc` exists, is
  functional (Cloudinary-backed), and is called by **nothing** in the
  frontend — `BecomeSellerPage.tsx`'s own comment explicitly deferred
  this to "the dashboard once §4's Business Verification tab is built."
  Also confirmed there was **no route at all** to write
  `nidOrTradeLicenseUrl` or any other seller field back to the `sellers`
  table — this was a bigger gap than "wire up an existing form"; a new
  backend endpoint was required.
- Confirmed `SellerListingForm.tsx` already has a working Discount Price
  field wired to `seller_listings.discountPrice` — read the file
  directly, did not build a redundant Manage Discounts page.
- Read `PUT /admin/seller-courier-configs/:id/verify` in
  `adminSellers.ts` before deciding whether enforcing `isVerified` on
  courier booking was safe to do. It exists, is fully wired, and is the
  courier-config mirror of the payment-config admin-verify route — so
  enforcing `isVerified` on booking does **not** create a dead end
  (every courier config can eventually be verified by an admin, same as
  payment configs already work). The comment in `orderShipments.ts`
  arguing against enforcement (because it would be "permanently
  impossible") was stale — it predated the admin toggle's own comment,
  which said explicitly this was deferred and expected to be closed in a
  later session. This session is that closure.

## What was built

### Part A — Courier-booking verification enforcement
**`routes/orderShipments.ts`** (`POST /seller/orders/:orderId/book-courier`):
- Added a check mirroring `hasVerifiedPaymentConfig()`'s exact shape from
  `sellerListings.ts`: if a `seller_courier_configs` row exists but
  `isVerified !== true`, the booking now 400s with a message pointing the
  seller at manual status updates, same pattern as the existing
  no-config-at-all case.
- Updated the route's own doc comment (previously argued against this
  exact enforcement) and the admin verify-route's comment in
  `adminSellers.ts` (previously said "nothing gates on isVerified") —
  both were stale after this change and are now accurate.
- Fixed one line of now-false UI copy in `CourierSettingsForm.tsx` that
  told sellers an unverified config would "confirm credentials on your
  first booking attempt" — that's no longer true; it now 400s instead.
  This is a copy fix caused directly by the Part A change, not a
  restyle — the visual shape of the component is untouched.
- Small, isolated, as instructed — no other courier-booking logic
  touched.

### Part B — Seller dashboard phase-1 gaps

**1–2. Business Profile (merged with Store Settings)**
- New OpenAPI paths: `PATCH /sellers/me` (partial profile update) and
  `PUT /sellers/me/status` (vacation toggle) in `lib/api-spec/openapi.yaml`,
  plus `UpdateSellerProfileBody` / `UpdateSellerStatusBody` schemas.
  Regenerated `api-client-react` and `api-zod` via `pnpm run codegen`
  before writing backend routes, so client and server types stay in sync.
- New backend routes in `routes/sellers.ts`:
  - `PATCH /sellers/me` — partial update of business/nursery profile
    fields. Every field optional; `status`/`subscriptionStatus`/trial
    dates are never accepted from the request body, same
    server-derived-only rule as `POST /sellers`.
  - `PUT /sellers/me/status` — accepts only `"active"` or `"vacation"`,
    and only transitions between those two; rejects any other current
    status (a `pending_verification` or `suspended` seller cannot use
    this route to self-activate).
- New middleware in `middlewares/auth.ts`: **`requireSellerAccount`**,
  deliberately separate from `requireSeller`. It attaches `req.dbSeller`
  for any status (not just `active`), so profile edits and the vacation
  toggle stay reachable from every non-deleted seller state — including
  while on vacation, which is the entire point of the toggle being
  reachable at all. `requireSeller` itself was **not** weakened; it's
  still active-only and still guards all listings/orders/payment/courier
  writes exactly as before.
- New frontend component: `src/components/seller/BusinessProfileForm.tsx`.
  Mirrors `PaymentSettingsForm.tsx`/`CourierSettingsForm.tsx`'s card
  shape, loading skeleton, and toast-on-success/error pattern, and
  `SellerListingForm.tsx`'s image-upload gallery UI (reused verbatim for
  nursery photos and the verification doc). New tab ("Business Profile")
  added to `SellerDashboardPage.tsx`.

**3. Vacation Mode**
- The toggle itself lives in `BusinessProfileForm.tsx`, using the new
  `PUT /sellers/me/status` route and a `Switch` component (existing in
  the UI kit at `components/ui/switch.tsx` but not previously used
  anywhere in seller/admin dashboards — no established toggle pattern to
  mirror, so it was used as the semantically correct primitive, styled to
  the existing card/label conventions).
- **`SellerDashboardPage.tsx` gate logic was restructured** — this was
  the actual hard part the task brief was pointing at. Previously:
  `if (!seller || seller.status !== "active")` bounced anything non-active
  entirely to a "dashboard unavailable" screen, which would have made the
  vacation toggle itself unreachable once a seller used it. Now:
  `status === "vacation"` is allowed through to the dashboard, but
  Listings/Orders/Payment Settings/Courier Settings tabs are disabled
  (`TabsTrigger disabled={onVacation}`) and the default tab becomes
  Business Profile, with an amber notice banner explaining why the other
  tabs are paused. `pending_verification` and `suspended` still bounce to
  the unavailable screen, unchanged.
- No backend change needed for buyer-side exclusion — verified above that
  `products/:productId/seller-listings` already filters
  `sellers.status = "active"`, so a `"vacation"` seller's listings stop
  appearing there automatically, with zero code changes.

**4. Manage Discounts**
- Confirmed already satisfied. `seller_listings.discountPrice` and
  `SellerListingForm.tsx`'s Discount Price field cover the plan's
  "per-listing discount_price only, no coupon system" requirement
  exactly. No new page built.

**5. Business Verification (seller-facing doc upload)**
- Closed. `BusinessProfileForm.tsx` now calls the existing
  `POST /sellers/upload-verification-doc` endpoint (raw `fetch` with
  Clerk bearer token, same pattern `SellerListingForm.tsx` already uses
  for listing images — this endpoint is intentionally **not** in the
  OpenAPI spec, matching the existing convention that no file-upload
  route in this codebase goes through the generated client) and writes
  the returned URL via the new `PATCH /sellers/me` route.
- The upload UI shows different messaging depending on seller status:
  a "pending review, upload helps verification go faster" note while
  `pending_verification`, a neutral "document on file" note once
  `active` and a doc exists.
- Confirmed (by reading, not assuming) that `SellersTab.tsx` (admin side)
  already conditionally renders a link to `nidOrTradeLicenseUrl` when
  present — so the full loop (seller uploads → seller PATCHes profile →
  admin sees the link) closes end-to-end at the code level with no admin
  UI changes needed.

## Verification of this session's own work
- `pnpm run typecheck` (full workspace) — clean, run twice: once after
  the middleware change, again after all frontend changes.
- Real `vite build` — succeeds. `SellerDashboardPage` grew from
  **35.00 kB → 44.18 kB** raw (gzip 8.41 kB → 9.96 kB), plus a new
  separate lazy-loaded `switch-*.js` chunk at 0.87 kB. That delta is
  consistent with what was added (one ~300-line form component with
  upload handling) — not bloated, not suspiciously small.
- Real `node build.mjs` — succeeds, `dist/index.mjs` stayed at 11.8 MB
  (no unexpected size change from a handful of new route handlers, which
  is expected).
- Boot test — fails only on `DATABASE_URL`, same as the pre-session
  baseline.
- **Two bugs introduced and caught during this session, disclosed rather
  than smoothed over:**
  1. A `str_replace` on `middlewares/auth.ts` initially dropped
     `requireSeller`'s function-signature line entirely (an old_str
     boundary mismatch). Caught immediately on the next `view`, before
     typecheck was run against it, and fixed. Final file was verified by
     full re-view, not just diffed.
  2. `export default router;` in `routes/sellers.ts` was initially placed
     *before* the two new route registrations instead of after. This
     doesn't actually break Express at runtime (the module fully
     evaluates top-to-bottom before the export is consumed by importers),
     but it was misleading to read and got moved to the true end of the
     file for clarity, confirmed with a final grep for a single
     `export default` occurrence.
- Did **not** live-test the actual upload flow (Cloudinary round-trip,
  DB writes) — no `DATABASE_URL` or Cloudinary credentials exist in this
  sandbox. Typecheck/build passing confirms the code is well-typed and
  structurally wired; it does not confirm the Cloudinary upload itself
  succeeds against real credentials. Flagging this distinction rather
  than claiming full confirmation.

## Explicitly out of scope (per task brief §"What NOT to build")
- Customer Chat, Analytics/Reports, Withdraw Earnings, Manage Coupons —
  untouched.
- Live bKash/Pathao/Steadfast credential verification — untouched; the
  admin-toggle mechanism from Phase 6 is still the only verification
  path, now actually enforced for courier (Part A) same as payment
  already was.
- Cart/checkout-side gaps (verified-status exposure at checkout,
  delete/unverify cascade) — untouched, out of this session's
  dashboard-focused scope per the brief.

## Flagged for a future session (not built, per the brief's own request to flag rather than build silently)
- No live-credential check exists for courier or payment providers.
  Enforcement (Part A) only checks the admin-review flag, same
  "manual review, not automated KYC" convention as Phase 6 established
  for payments — consistent, but still worth naming as a real gap if
  live verification is ever wanted.
- `Switch` component now has its first real usage in this codebase
  (vacation toggle). If future dashboard work wants more boolean toggles
  (e.g. a listing-level "featured" flag), this is now the established
  pattern to reuse rather than reinventing a button-based toggle.
- The disabled/other tabs in `SellerDashboardPage.tsx` during vacation
  mode are gated purely by `TabsTrigger disabled`, which is a UI-layer
  restriction only — the backend already independently blocks writes to
  those routes via `requireSeller`'s existing active-only check, so
  there's no security gap here, but it's worth knowing the two layers
  are separate rather than the frontend disable being the only thing
  stopping a vacationing seller from, say, creating a listing via a
  direct API call.
