# Phase 1 Handoff — Seller Marketplace

Phase 1 (plan doc §4/§5: sellers table + signup/become-a-seller flow +
admin verification approval UI) is complete and verified as of this zip.

## Verified, not just written
From a clean `pnpm install --frozen-lockfile`:
- `pnpm run typecheck` passes across all 9 workspace packages (strict mode).
- `artifacts/tree-friend`: real `vite build` succeeds (not just typecheck).
- `artifacts/api-server`: real `node build.mjs` (esbuild) succeeds, and the
  built `dist/index.mjs` boots correctly up to the point of connecting to
  `DATABASE_URL` (fails there only because this sandbox has no live
  Postgres/Cloudinary/Clerk configured — that's an infra limit of the build
  environment, not a code defect).
- NOT verified: no live database was available to test actual signup →
  approval → status-change flows end-to-end, or to run
  `pnpm run push` in `lib/db`. Do that first in the next session, against a
  real (ideally staging, not prod) `DATABASE_URL`, before assuming the SQL
  Drizzle generates is 100% friction-free — schema code compiling is not
  the same guarantee as a migration applying cleanly.

## What's built
- Schema: `sellers`, `sellerListings`, `sellerSubscriptions`,
  `sellerPaymentConfigs`, `sellerCourierConfigs`, `listingAttributeOptions`,
  `orderShipments` (lib/db/src/schema/). `orders` and `reviews` migrated
  per plan doc §2/§3b (nullable `sellerId` added to orders; reviews'
  unique constraint moved from `(productId, userId)` to
  `(sellerListingId, userId)`).
- Seller-facing: `POST /sellers` (apply), `GET /sellers/me` (status),
  `POST /sellers/upload-verification-doc` (doc/photo upload, NOT in the
  OpenAPI spec — see note below). Frontend: `/become-seller` page, entry
  point/status badge in `ProfilePage.tsx`.
- Admin: `GET /admin/sellers`, `PUT /admin/sellers/:id/approve|reject|suspend`,
  each audit-logged via the existing `logAudit` helper. Frontend: `Sellers`
  tab in the admin dashboard (`SellersTab.tsx`), status-filtered queue.
- Subscription enforcement (this is phase-3-adjacent per §3/§7, built
  early because it was asked for directly): hourly job
  (`jobs/sellerSubscriptionJob.ts`, wired into `index.ts`'s scheduler —
  unlike `lowStockJob.ts`/`runAbandonedCartJob`, which exist but are
  NEVER CALLED anywhere; that's a pre-existing gap in the codebase, not
  something this session introduced, but worth fixing if those features
  matter) sends a reminder 7 days before `trialEndsAt`/
  `subscriptionExpiresAt`, and hides (`visibility: hidden`,
  `hiddenReason: subscription_expired`) a seller's listings immediately on
  expiry, no grace period, per explicit instruction from the project owner.
  Admin `POST /admin/seller-subscriptions/:sellerId/mark-paid` reverses
  this and is audit-logged with a free-text evidence note.

## Known gaps — deliberately not resolved, need a decision, not silent code
1. **Document upload isn't wired into the `/become-seller` form.** The
   endpoint works; the UI doesn't call it. An applicant can currently
   submit with no `nidOrTradeLicenseUrl`/`nurseryImages`, which lands in
   `pending_verification` same as one with documents. Decide: require
   documents at signup, or keep allowing submit-then-upload-later.
2. **Rejecting an application deletes the `sellers` row** rather than
   setting a `rejected` status (the status enum has no such value —
   adding one is a one-line schema change if you want a permanent
   rejected-applicant record beyond the audit log).
3. **`/sellers/upload-verification-doc` is intentionally NOT in
   `openapi.yaml`.** Including a `multipart/form-data` + `format: binary`
   path there broke the shared `orval` codegen (`zod.instanceof(File)`
   fails to compile in the Node/tsc context used for `lib/api-zod`). This
   codebase's existing convention for file uploads
   (`/products/upload-image`, `/assets/upload`) is the same: hand-called
   via raw `fetch`+`FormData`, never through the generated client. Don't
   re-add multipart endpoints to the spec without solving that codegen
   issue first.
4. **Seller dashboard doesn't exist as a page yet.** `BecomeSellerPage.tsx`
   and the `ProfilePage.tsx` badge both reference it in copy/links
   (`/become-seller` → "go to your seller dashboard") ahead of it being
   built. That's Phase 2/3 territory per §4's own remaining list (Upload
   Listing, Manage Inventory, Manage Orders, Store Settings, Vacation
   Mode, Payment/Courier Settings).

## Explicitly NOT started
Phase 2 per plan doc §10.2: `listing_attribute_options` seed data per
category, `seller_listings` CRUD with server-side dropdown enforcement
(plan doc §3a — height/pot_size/age/root_type must validate against
`listing_attribute_options` server-side, not just client dropdowns), and
the buyer-facing variety-detail-page seller-cards UI (plan doc §6).

Schema for `listing_attribute_options` and `seller_listings` already
exists (built ahead, alongside phase 1's tables) — Phase 2 is routes +
seed data + frontend, not new schema, unless something in review changes
that.
