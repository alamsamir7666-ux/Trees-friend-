# Phase 4 Handoff — Courier Booking + Webhooks + Seller Order Management (Part 4 of 4)

## What this covers
Part 4 only: booking Pathao/Steadfast shipments from the seller dashboard,
receiving courier status webhooks, and seller-facing order management
(list/filter own orders, advance/cancel order status). Parts 1
(payment/courier config CRUD) and 2 (payment-method enforcement) were
never built in prior sessions — confirmed by reading code, not trusting the
Phase 3 handoff's claim blindly (it turned out to be correct this time, but
see below for what that meant for scope here).

## Scope decision made with the user before writing code
`seller_courier_configs`/`seller_payment_configs` had a schema-comment
requirement ("encrypt at rest") that no utility in the codebase implemented
— confirmed by grep, not assumed. Booking a courier requires decrypting
real credentials, so this gap became unavoidable in Part 4. Asked the user
directly rather than picking silently:
- **Encryption**: build a real AES-256-GCM utility now (not a stub, not
  skipped). Done — see `lib/credentialEncryption.ts` below.
- **Pathao/Steadfast API calls**: real HTTP integration against their
  actual documented merchant APIs, not a stub. Done, but **untested against
  live credentials** — this environment has none. Same disclosure standard
  Phase 3 used for its own untested DB queries: the request/response shapes
  match what's publicly documented, but the first real booking against a
  real seller's real Pathao/Steadfast account is the actual test.

## What was built

**New: `lib/credentialEncryption.ts`**
AES-256-GCM encrypt/decrypt for credential columns. Reads
`CREDENTIAL_ENCRYPTION_KEY` from env (base64, 32 bytes — generate with
`openssl rand -base64 32`), lazily (throws on first use, not at import
time, so the process still boots without it — same pattern as
`middlewares/mobileJwt.ts`'s `MOBILE_JWT_SECRET`). **You must set this env
var in Render before deploying**, or every courier-config save/read will
500. Losing this key makes all previously-encrypted rows undecryptable —
back it up like a database password.

**New: `lib/courierAdapters/` (types.ts, pathao.ts, steadfast.ts, index.ts)**
Shared `CourierAdapter` interface (`bookShipment`,
`normalizeWebhookStatus`, `extractTrackingId`) so `orderShipments.ts` and
`courierWebhooks.ts` don't care which provider they're talking to.
- **Pathao**: real OAuth (`/aladdin/api/v1/issue-token`) + create-order
  (`/aladdin/api/v1/orders`), built from Pathao's publicly documented
  merchant API. **Known unresolved gap, flagged in the adapter's own doc
  comment, not silently worked around**: Pathao's create-order endpoint
  wants `recipient_city`/`zone`/`area` as numeric IDs resolved through
  their own lookup endpoints, not free-text city names — this adapter
  sends the city as text into the field Pathao's shape allows for it, but
  a real integration needs a location-picker UI backed by Pathao's
  city/zone/area-list endpoints. Not built here.
- **Steadfast**: real create-order call (`portal.packzy.com/api/v1`),
  simpler static Api-Key/Secret-Key auth, no OAuth.
- **Credential shape mismatch, flagged not hidden**: `seller_courier_configs`
  has 2 credential columns (`apiKey`/`apiSecret`), but Pathao's OAuth needs
  4 (client_id, client_secret, username, password). The convention used
  here — `apiSecret` packed as `"clientSecret|username|password"` — lives
  in exactly two places (`pathao.ts` and `sellerCourierConfigs.ts`) so it
  can't silently drift. A future Part 1 session giving the schema dedicated
  Pathao columns would let this go away.
- **No webhook signature verification.** Neither courier's docs I found
  while building this describe an official webhook-signing secret.
  Flagged as a real gap, not fabricated — if either courier exposes a
  signing key in a real seller's dashboard, add HMAC verification in
  `courierWebhooks.ts` before trusting payloads in production.

**New: `routes/sellerCourierConfigs.ts`** (genuinely Part 1 scope, built
here out of necessity — Part 4 has nothing to book against otherwise, so
kept intentionally minimal: create/replace, get-masked, delete. Does NOT
build the equivalent `seller_payment_configs` route, since courier booking
doesn't need it.) Every response masks credentials
(`••••••••WXYZ` style) — decrypted plaintext never leaves the server.
`isVerified` is never set true by this route (no live-credential check
exists); Pathao/Steadfast's own API is the real verification, surfaced as
a booking error if the credentials are bad.

**New: `routes/orderShipments.ts`**
- `POST /seller/orders/:orderId/book-courier` — the "Book Courier" action.
  400s with a clear message if no courier config exists (falls back to
  manual). 502s with the courier's own error message if the booking call
  itself fails (bad credentials, malformed address, etc.) — not swallowed.
- `PUT /seller/orders/:orderId/shipment-status` — manual status dropdown,
  usable whether or not a courier config exists.
- `GET /seller/orders/:orderId/shipment` and `GET /orders/:orderId/shipment`
  (buyer-facing) — buyer tracking reads only `order_shipments`, never calls
  Pathao/Steadfast directly, per the plan doc's explicit instruction.
- Weight estimate for Pathao is a flat 1kg/unit fallback — `orders.items[]`
  has no real per-item weight field. Flagged in code, not guessed silently.

**New: `routes/courierWebhooks.ts`**
`POST /webhooks/courier/pathao`, `POST /webhooks/courier/steadfast`. Not in
`openapi.yaml` — external webhook receivers aren't part of the typed
client, same precedent as the existing `/sms-webhook`. Looks up the
shipment purely by `courierTrackingId` (the courier doesn't know our
seller_id), normalizes status through the adapter, and — when the
normalized status maps to `shipped`/`delivered` — also updates the parent
order's own `orderStatus` and emails the buyer via the existing
`sendOrderStatusUpdate`. Unrecognized status payloads are still stored
(`rawWebhookPayload`) for debugging but don't overwrite a known status.

**New: `routes/sellerOrders.ts`**
- `GET /seller/orders` (optional `?orderStatus=` filter), `GET
  /seller/orders/:id`, `PUT /seller/orders/:id/status`. Separate file from
  `orders.ts` deliberately — `orders.ts` is Part 3 scope this session
  shouldn't reshape; `orders.sellerId` already existed from Part 3, just
  unused by any seller-facing route until now.
- No forward-only state machine on seller status updates (unlike the
  buyer's cancel-only-if-pending rule) — a seller correcting their own
  mistake is legitimate, not something to gate behind logic that doesn't
  exist elsewhere in this codebase.
- Not paginated, matching every other list route in this codebase (buyer's
  own `GET /orders` isn't paginated either).

**Frontend (`artifacts/tree-friend/src`)**
- `components/seller/SellerOrdersTab.tsx` — order list, status dropdown,
  cancel-with-reason flow, Book Courier button (only shown when a courier
  config exists), shipment-status dropdown (always available, for manual
  fallback). Reuses `OrdersPage.tsx`'s exact status color palette so
  sellers and buyers see the same color language for order status.
- `components/seller/CourierSettingsForm.tsx` — connect/disconnect a
  Pathao or Steadfast account. Pathao's form has 4 fields (Client ID/
  Secret, Pathao username/password) + Store ID; Steadfast has 2 (Api Key/
  Secret Key). Packs Pathao's extra fields into `apiSecret` per the
  documented convention before sending.
- `pages/SellerDashboardPage.tsx` — restructured into three tabs
  (Listings / Orders / Courier Settings) using the existing `tabs.tsx`
  shadcn component already in the codebase. Existing listings behavior is
  unchanged, just moved under a tab.

**OpenAPI (`lib/api-spec/openapi.yaml`)** — added `sellerOrders` tag, 9 new
paths, 7 new component schemas (`SellerCourierConfig`,
`CreateSellerCourierConfigBody`, `OrderShipment`, `UpdateShipmentStatusBody`,
`SellerOrder`, `UpdateSellerOrderStatusBody`). Codegen run; generated hooks
(`useListSellerOrders`, `useBookCourierForOrder`,
`useUpdateShipmentStatus`, etc.) confirmed present and typed correctly.

## Verified, not assumed
- Full workspace `pnpm run typecheck` passes clean across all 4 packages
  (api-server, tree-friend, mockup-sandbox, scripts) — zero errors,
  including the new files.
- `api-server`'s own `tsc --noEmit` — zero errors on a from-scratch build
  (libs rebuilt first to clear stale build-order artifacts).
- `api-server`'s esbuild bundle succeeds; boot-tested with no env vars —
  fails **only** on missing `DATABASE_URL`, same baseline Phase 3
  documented. `CREDENTIAL_ENCRYPTION_KEY` is correctly lazy and did not
  block boot.
- `tree-friend`'s `vite build` succeeds; `SellerDashboardPage` chunk builds
  at 30.6kB with the new tabs/orders/courier-settings code included.
- Codegen (`orval`) ran clean against the updated spec; all new hooks
  generated and typecheck.
- **Not verified**: no database was available in this environment (same
  constraint Phase 3 hit), so no route was exercised against real Postgres,
  and no Pathao/Steadfast booking call was exercised against live
  credentials. Both are structurally verified (types, build, bundle) but
  not runtime-tested.

## What's still not built (out of Part 4's stated scope, not forgotten)
- `seller_payment_configs` CRUD route (still genuinely Part 1/2 scope —
  courier booking didn't need it, so it wasn't built alongside
  `sellerCourierConfigs.ts`).
- Payment-method enforcement at checkout (Part 2).
- Pathao city/zone/area ID resolution UI (flagged above, in
  `pathao.ts`'s doc comment).
- Webhook signature verification (flagged above — no documented secret to
  verify against, from what was checked).
- Store Settings, Vacation Mode, and Manage Discounts on the seller
  dashboard — mentioned in the plan doc's §4 list but never in any part's
  scope so far.
