# Phase 5 Handoff — Payment Config CRUD + Payment-Method Enforcement (Part 5)

## What this covers
Part 5 only: `seller_payment_configs` CRUD, server-side payment-method
enforcement at the listing and checkout layers, and a fix to the
multi-seller bKash sending-number bug flagged in `PHASE3_HANDOFF.md`.
Courier booking/webhooks/seller order management (Part 4) were not
touched. The seller-scoped checkout split (Part 3) was **not rebuilt** —
see the correction below, this was the most important finding of the
session before any code was written.

## Correction to Phase 4's handoff, verified before writing any code
The task brief for this session (inherited from `PHASE4_HANDOFF.md`'s "not
built" list) claimed the seller-scoped checkout split was still unbuilt:
*"checkout still doesn't key off sellerListingId at all."* That claim is
**wrong** — confirmed by reading the actual code, not trusting either
handoff doc:

- `routes/orders.ts`'s `POST /orders` already groups cart lines by
  `sellerId` via `groupBySellerAndAllocateDiscount`, creates one order per
  seller group (admin-direct lines form their own `sellerId: null` group),
  supports a `sellerPaymentMethods` map for per-seller-group payment
  method selection, and allocates coupon/loyalty discounts to the single
  largest group.
- `routes/cart.ts`'s `buildCart` already fetches and merges both line
  kinds (variant lines and seller-listing lines) with a `kind`
  discriminator and per-line `sellerId`/`seller` info.
- `CheckoutPage.tsx` already renders a seller-grouped order summary with a
  per-seller-group payment method selector.
- `PHASE3_HANDOFF.md` documents building exactly this, in detail, under
  "What was built." It even flags the exact sending-number bug this
  session was asked to fix (see below) — so Phase 3's own handoff was
  accurate; Phase 4's handoff was the one that got this wrong, apparently
  written without checking Part 3's actual output.

**Practical effect on this session's scope**: item 3 as originally briefed
("build seller-scoped checkout split") did not need building. What
*did* need building, and is genuinely this session's work, is enforcing
payment method validity within that already-correct split (see below) and
fixing the real, correctly-flagged sending-number bug.

If a future session's task brief again claims checkout splitting is
unbuilt, that claim should be re-verified against `orders.ts`/`cart.ts`
directly before doing anything, not trusted.

## What was built

### 1. `routes/sellerPaymentConfigs.ts` (new)
Mirrors `routes/sellerCourierConfigs.ts`'s shape exactly:
- `GET /seller-payment-configs/mine` — masked config, 404 if none (normal
  "COD-only" state, not an error).
- `POST /seller-payment-configs` — create/replace (delete-then-insert, one
  bKash config per seller, matching the schema's actual `unique(sellerId)`
  constraint). Requires all four bKash merchant credential fields
  (`merchantAppKey`, `merchantAppSecret`, `merchantUsername`,
  `merchantPassword`) — bKash's merchant API needs all of them together,
  there's no partial-credential state. `provider` defaults to `"bkash"`
  and is rejected if any other value is sent (the only provider this
  schema/plan support today).
- `DELETE /seller-payment-configs/mine` — removes the config; seller falls
  back to COD-only immediately (no cascading update to existing listings,
  see gap below).
- Every response masks credentials via `maskCredential` from
  `lib/credentialEncryption.ts` (Part 4's AES-256-GCM utility, reused
  as-is — no second encryption scheme was built). Decrypted plaintext
  never leaves the server.
- **`isVerified` is never set `true` by this route** — same convention as
  `sellerCourierConfigs.ts`. No live-credential check against bKash's
  actual merchant API exists. This matters a lot for item 2 below: saving
  credentials here does **not** immediately unlock advance payment.
  `isVerified` staying permanently `false` until some future verification
  step is the expected, correct state today, not a bug.

Registered in `routes/index.ts`. OpenAPI: new `sellerPaymentConfigs` tag,
3 new paths, 2 new schemas (`SellerPaymentConfig`,
`CreateSellerPaymentConfigBody`). Codegen re-run; `useGetMySellerPaymentConfig`,
`useCreateSellerPaymentConfig`, `useDeleteMySellerPaymentConfig` hooks
confirmed generated and typed correctly.

**Not built in this route**: any frontend Payment Settings form/tab. The
task scope was the CRUD routes; no `PaymentSettingsForm.tsx` or dashboard
tab wiring was requested or built. A seller can't actually reach these
endpoints from the UI yet — that's a real gap, not an oversight, see
below.

### 2. Payment-method enforcement (plan §7)
Closed in three places, since the same rule ("advance"/"both"/"bkash"
requires a **verified** `seller_payment_configs` row) applies at three
different points a seller/buyer could otherwise get around it:

**a. `routes/sellerListings.ts` — listing create/update (the piece
explicitly called out as this session's most important job).**
Added `hasVerifiedPaymentConfig(sellerId)` (checks for a row with
`isVerified = true` specifically, not just row existence) and wired it
into both `POST /seller-listings` and `PUT /seller-listings/:id`: setting
`paymentMethod` to `"advance"` or `"both"` now 400s with a clear message
if the seller has no verified config. `"cod"` is unaffected (always
allowed, matches plan §7's "otherwise COD-only by default"). On `PUT`,
only checked when `paymentMethod` is explicitly present in the request
body — a partial update that doesn't touch `paymentMethod` doesn't
re-trigger the check (the value was already valid when it was set).

**b. `routes/orders.ts` — checkout, re-checked independently.**
A marketplace seller group (`sellerId != null`) resolving to `"bkash"`
now requires that seller to have a verified `seller_payment_configs` row,
checked again at order-creation time — not just relied upon from
`sellerListingsTable.paymentMethod` at listing-write time. This closes a
real gap listing-level enforcement alone can't: a listing's
`paymentMethod` can drift out of sync with the seller's actual config
state after the fact (deleting a payment config doesn't cascade back to
touch existing listings — see 2c below), and re-checking at the moment a
bKash payment request would actually be generated is the point that
protects real money, not just the point that stops the listing from being
saved that way in the first place. The admin-direct group (`sellerId ===
null`) is exempt — `"bkash"` there is the platform's own long-standing
bKash flow, not a per-seller merchant account, so it was never gated by
`seller_payment_configs`.

**c. Known, explicitly-left-open gap: no cascading re-validation.**
If a seller's payment config is deleted or becomes unverified *after* a
listing was already set to `"advance"`/`"both"`, that listing is **not**
automatically reverted to `"cod"` or hidden. `routes/sellerPaymentConfigs.ts`'s
`DELETE` route doesn't touch `seller_listings` at all. In practice this is
mostly harmless because of 2b — a buyer still can't actually complete a
bKash payment to that seller at checkout, they'll get the "doesn't
currently accept bKash payment" error and have to switch to COD — but the
listing card itself may still *display* as accepting advance payment
until the seller or an admin manually edits it. Building a cascade
(either on-delete, or a background reconciliation job) was not attempted;
flagging it rather than silently declaring it fixed by 2b alone, since a
buyer-facing display inconsistency is still a real (if lower-severity)
issue.

### 3. Multi-seller bKash sending-number fix (plan §7 / `PHASE3_HANDOFF.md` gap)
Previously: a single `senderNumber` field/state (`bkashNumber` in
`CheckoutPage.tsx`) was reused as the sending number for **every** seller
group that resolved to `"bkash"`, even when different sellers have
separate bKash merchant accounts and the buyer would need to send from
different numbers to each.

**Backend (`routes/orders.ts`)**: added `sellerSenderNumbers`, a
per-seller-group override map keyed exactly like `sellerPaymentMethods`
(sellerId as a string, `"null"` for the admin-direct group). Each group's
sender number is now resolved independently:
`sellerSenderNumbers[key] ?? senderNumber` — the top-level `senderNumber`
remains the fallback/default, so existing single-seller/admin-direct
callers that only ever send `senderNumber` are unaffected. Validation
("please enter a sending number") now runs per group, not once globally.

**Frontend (`CheckoutPage.tsx`)**: added `sellerSenderNumber` state
(`Record<string, string>`) alongside the existing `sellerPaymentMethod`
map, with matching `senderNumberFor`/`setSenderNumberFor` helpers. The
multi-seller payment UI now renders a separate "bKash Sending Number"
input inside each seller's own card (replacing the single shared "Sending
Number" box that used to sit below all the seller cards). Submit
validation (`missingSenderNumberGroups`) now checks that every group
resolved to `"bkash"` has its own non-empty number, and reports which
specific seller(s) are missing one if not.

**OpenAPI**: `CreateOrderBody.sellerSenderNumbers` documented, codegen
re-run, `CreateOrderBodySellerSenderNumbers` type confirmed generated
(`{[key: string]: string | null}`) and used correctly by
`CheckoutPage.tsx`'s `createOrder.mutate` call.

## What's still not built / known gaps (flagged, not papered over)

1. **No Payment Settings frontend.** The CRUD routes exist and are
   registered/typed, but there is no `PaymentSettingsForm.tsx` or seller
   dashboard tab wiring them up (mirroring the `CourierSettingsForm.tsx` /
   "Courier Settings" tab Part 4 built). A seller cannot currently reach
   `POST /seller-payment-configs` from the UI at all. This was implicit in
   the task's item 1 wording ("build the routes") but is worth being
   explicit about: the feature is not usable end-to-end yet.
2. **No verification flow exists anywhere** for either payment or courier
   configs — `isVerified` is permanently `false` for every seller today,
   for both tables. This means, as of this session, **no seller can
   actually offer advance/bKash payment**, even after saving valid
   credentials, until some future session builds a verification step
   (live-credential check against bKash's merchant API, or a manual
   admin-review toggle — plan doc doesn't specify which). This is a
   correct enforcement of the plan's literal wording ("verified... row"),
   not a bug, but it does mean items 1+2 together currently make advance
   payment **more** locked down than before this session (previously any
   seller could claim advance payment with no config at all; now no
   seller can, until verification is built). Flagging this trade-off
   explicitly rather than assuming it's obviously fine.
3. **Listing/config drift on delete** (detailed in item 2c above) — no
   cascade from a deleted/unverified payment config back to existing
   listings' `paymentMethod` field. Checkout-time enforcement (2b) prevents
   real money loss, but the listing's own displayed state can still be
   stale until a seller or admin edits it.
4. **Frontend payment-method filtering is still client-side-only intel.**
   `CheckoutPage.tsx`'s `allowedMethodsForListingPaymentMethod` reads
   `listing.paymentMethod` to grey out disallowed buttons, but has no way
   to know whether the seller's config is actually *verified* (that
   information isn't exposed on the cart/listing response). Practically
   this means a buyer could still see "bKash" as a selectable button for a
   seller whose config isn't verified, click it, and only find out it's
   rejected when they submit — the backend check (2b) is authoritative and
   correct, but the UI experience for that specific case is a rejected
   submission with an error message, not a proactively disabled button.
   Not fixed here — would require exposing verified-config status on the
   cart/seller-listing response, which touches `cart.ts`'s response shape,
   judged out of this session's stated scope (payment config CRUD +
   enforcement, not a cart-response redesign).
5. **Single sending-number field across a multi-seller checkout** — this
   is now **fixed** (item 3 above), listed here only to explicitly close
   out the item `PHASE3_HANDOFF.md` originally flagged, not because it's
   still open.

## Verified, not assumed (re-run at the start of this session, before any code)
- `pnpm install --frozen-lockfile` — clean.
- Cleared all stale `.tsbuildinfo` files (the zip shipped them without
  matching `dist/` output — confirmed no `dist/` existed under `lib/*`
  before the rebuild) — then `pnpm run typecheck:libs` from scratch:
  clean, and `lib/{db,api-zod,api-client-react}/dist` now genuinely exist.
- `pnpm run typecheck` (full workspace, all 4 packages) — clean.
- Real `vite build` in `artifacts/tree-friend` — succeeds;
  `SellerDashboardPage` chunk at 30.6kB matched `PHASE4_HANDOFF.md`'s
  claimed size exactly, confirming Part 4's frontend claim.
- Real `node build.mjs` in `artifacts/api-server` — succeeds; boot-tested
  with no env vars, fails **only** on missing `DATABASE_URL`.
- Spot-checked all five files `PHASE4_HANDOFF.md` claimed existed
  (`lib/credentialEncryption.ts`, `lib/courierAdapters/*`,
  `routes/sellerCourierConfigs.ts`, `routes/orderShipments.ts`,
  `routes/courierWebhooks.ts`, `routes/sellerOrders.ts`) — all present
  with the content described.
- Read `routes/orders.ts`, `routes/cart.ts`, `CheckoutPage.tsx`, and
  `PHASE3_HANDOFF.md` directly to confirm/deny the "checkout split
  unbuilt" claim — found it false, documented above.

## Verified, not assumed (this session's own work, before packaging)
- Same discipline: cleared `.tsbuildinfo` again after all edits, full
  `pnpm run typecheck` from scratch — clean across all 4 packages
  (caught and fixed one real syntax error introduced mid-session by a
  clobbered doc comment during editing — not a false pass, an actual bug
  that would have failed CI, fixed before this handoff was written).
- Real `vite build` — succeeds; `page-checkout` chunk grew from 21.39kB
  to 21.78kB (expected, from the new per-seller sending-number UI).
- Real `node build.mjs` — succeeds; boot-tested, fails only on
  `DATABASE_URL`, same baseline.
- `grep`-confirmed the new `/seller-payment-configs` routes are present in
  the compiled `dist/index.mjs` bundle (not just source).
- `openapi.yaml` validated as parseable YAML (59 paths, up from 57) before
  running codegen. Codegen (`orval`) ran clean; new hooks
  (`useGetMySellerPaymentConfig`, `useCreateSellerPaymentConfig`,
  `useDeleteMySellerPaymentConfig`) and the updated
  `CreateOrderBodySellerSenderNumbers` type confirmed present and
  typechecking correctly against `CheckoutPage.tsx`'s actual usage.
- **Not verified — no database was available in this environment**, same
  constraint every prior phase hit: no route was exercised against real
  Postgres, so the actual `POST /seller-payment-configs` →
  `GET .../mine` → `DELETE .../mine` round trip, the listing-write
  rejection path, and the checkout-time rejection path are all
  structurally verified (types, build, bundle contents) but not
  runtime-tested. First thing to do against a real database: push schema
  (if not already applied for `seller_payment_configs`, which predates
  this session), then manually exercise: save a payment config → confirm
  `isVerified` is `false` and stays `false` → attempt to set a listing to
  `"advance"` → confirm 400 → manually flip `isVerified` to `true` in the
  DB (no verification UI exists yet) → confirm the same listing write now
  succeeds → add that listing to a cart alongside a second seller's
  COD-only listing → checkout → confirm two orders are created with
  independently-entered sending numbers.

## Explicitly out of scope for this session (not touched)
- The seller-scoped checkout split itself (Part 3) — already correct,
  confirmed above, not rebuilt.
- Courier booking, webhooks, seller order management (Part 4) — not
  touched.
- Store Settings, Vacation Mode, Manage Discounts UI, Pathao city/zone/area
  resolution, webhook signature verification — still out of scope, same
  as Part 4 left them.
- A verification flow for payment/courier configs (live-credential check
  or admin-review toggle) — not scoped for this session, flagged above as
  the reason advance payment is currently unreachable for every seller.
- Payment Settings frontend form/tab — flagged above as a real gap, not
  built.
