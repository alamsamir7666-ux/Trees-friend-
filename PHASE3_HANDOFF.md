# Phase 3 Handoff — Cart/Checkout Migration (Part 3 of 4)

## What this covers
Part 3 only: cart/checkout migration to support marketplace seller-listing
purchases alongside the existing admin-direct variant purchases. Parts 1
(payment/courier config CRUD), 2 (payment-method enforcement), and 4
(courier booking/webhooks, seller order management) are separate sessions,
not started here.

## Verified before writing any code (do not re-trust the Phase 2 handoff blindly)
The Phase 2 handoff claimed Phase 3 was entirely unstarted. That was wrong.
Before touching anything, I independently confirmed by reading code (not
docs) that these already existed and worked: `seller_payment_configs`,
`seller_courier_configs`, `seller_subscriptions`, `order_shipments` schemas;
seller signup/doc-upload routes; a fully wired hourly subscription
enforcement job (7-day reminder, hourly expiry check, idempotent
hide/restore via `hiddenReason`). None of this was touched in Part 3 and it
should still be intact.

## What was built

**Schema (`lib/db/src/schema`)**
- `cart_items`: added `sellerListingId` (nullable FK). A cart line is
  EITHER a variant line (`variantId` set) OR a seller-listing line
  (`sellerListingId` set) — enforced at the route layer, not the DB.
  `productId` stays NOT NULL and populated for both kinds.
- `orders`: `items[]` (`OrderItem`) is now a discriminated union — variant
  lines vs. seller-listing lines (which also carry `sellerId`).
  `orders.sellerId` is null for admin-direct orders, set for marketplace
  orders. A single order's `items[]` is always homogeneous (all
  admin-direct, or all one seller) because checkout splits before insert.

**Backend (`artifacts/api-server/src/routes`)**
- `cart.ts`: rewritten. `buildCart` fetches and merges both line kinds.
  `POST /cart/items` requires exactly one of `variantId`/`sellerListingId`.
  **Breaking change**: `PUT`/`DELETE /cart/items/:variantId` is now
  `/cart/items/:id`, addressed by the cart_items row's own primary key
  (a seller-listing line has no variantId, so the old scheme couldn't
  address it). Every caller was updated to match.
- `orders.ts`: rewritten. `POST /orders` groups the cart by seller and
  creates one order per group (admin-direct lines form their own
  `sellerId: null` group). **Response shape changed**: `POST /orders` now
  always returns `Order[]`, never a single `Order` — even a single-seller
  cart returns a one-element array, so no caller needs to branch on
  whether checkout split.
  - Coupon and loyalty-point discounts are NOT pro-rated across split
    orders. Per standard marketplace practice, the full discount applies
    to whichever resulting order has the largest subtotal; other orders
    get none. This was an explicit decision (confirmed with the user), not
    a default I picked silently.
  - Payment method is now selectable **per seller group**
    (`sellerPaymentMethods`, keyed by sellerId as a string, `"null"` for
    admin-direct), not one global choice — a seller only accepts the
    payment methods their listings allow.
  - Guest checkout (`POST /orders/guest`) remains admin-direct-only by
    design. A guest has no account to attach a seller-scoped order to.
  - Stock decrement: seller-listing lines decrement
    `seller_listings.stock` and `.availableQuantity` together; variant
    lines decrement `productVariantsTable.stock` exactly as before.

**Nagad removed platform-wide** (explicit user instruction mid-session,
not scoped to just this phase's new code): removed from `CheckoutPage.tsx`,
`PreOrderCheckoutPage.tsx` (now bKash-only, selector removed since a
1-option choice is noise), admin settings display copy, OpenAPI spec,
and the `orders.ts` sender-number validation. Left untouched:
`NAGAD_ICON` constant (unused but harmless), and the historical-display
branches in `OrdersPage.tsx`/`PreOrderDetailPage.tsx` that render
`order.paymentMethod === "nagad"` for **existing** orders placed before
this change — those need to keep displaying correctly, this isn't a data
migration.

**API spec / codegen (`lib/api-spec`, generated clients)**
- `openapi.yaml` updated: `Cart`/`CartItem`/`AddToCartBody` support both
  line kinds; `/cart/items/{variantId}` → `/cart/items/{id}`; `Order`/
  `OrderLineItem`/`CreateOrderBody` updated for seller-scoped orders and
  per-seller payment methods; `POST /orders` response is `Order[]`.
- Codegen re-run cleanly after every spec change (`pnpm run codegen` in
  `lib/api-spec`), which also re-runs `typecheck:libs` as part of the
  script — confirmed passing each time, not just on the final pass.

**Frontend (`artifacts/tree-friend/src`)**
- `CartPage.tsx`: renders both line kinds, groups display by seller (an
  admin-direct group renders without a seller header, so a 100%
  admin-direct cart looks unchanged from pre-Phase-3).
- `SellerListingsSection.tsx`: "Add to Bag" wired for real. Requires
  sign-in — guest checkout can't support seller-listing lines (see
  above), so gating happens at add-to-cart time, not silently deferred to
  a checkout-time failure after the guest has filled out a shipping form.
- `CheckoutPage.tsx`: seller-grouped order summary; per-seller payment
  method selector (only shown when the cart actually spans multiple
  sellers — single-seller/admin-direct carts keep the original simple
  single-selector UI); redirect logic updated for the array response.

## Verification performed (same discipline as Phase 2, re-run independently)
- `pnpm install --frozen-lockfile` — clean.
- `pnpm run typecheck` (full workspace, all packages) — clean.
- `npx tsc --build --force` on libs (forced, bypassing incremental cache)
  after schema changes — clean.
- Frontend build (`vite build`) — succeeds, `page-checkout` chunk present.
- Backend build (`node build.mjs`) — succeeds.
- Backend boot test — fails ONLY on missing `DATABASE_URL`, same as
  Phase 2's baseline. No other startup errors.

**Not verified — no database was available in this environment**: actual
query execution, the unique constraints on `cart_items`
(`cart_user_product_variant_unique` / `cart_user_seller_listing_unique`),
or an end-to-end checkout flow against real data. `drizzle-kit push` was
not run. First thing to do against a real database: push schema, then
manually exercise add-to-cart (both kinds), multi-seller checkout split,
and confirm stock decrements land on the right table.

## Open items / things I did not resolve
1. **Single sending-number field across a multi-seller checkout.** If
   different sellers in one checkout both end up on `bkash`, the buyer
   enters one sending number that's used for every resulting order's
   `senderNumber` field. This is a real simplification, not a considered
   design — if a buyer needs to send from different numbers to different
   sellers' bKash accounts, this doesn't support that. Flagged, not fixed;
   revisit if it matters before Part 1/2 build payment verification on
   top of it.
2. **`productVariantsTable` is not deprecated** and was intentionally left
   untouched. It's still load-bearing for wishlist, flash sales,
   pre-orders, stock alerts, search, bulk import, and blog embeds — none
   of which were in scope. Migrating those is a separate, larger,
   unscoped effort if it's ever wanted.
3. Payment/courier config **routes** (not just schemas) don't exist yet —
   confirmed absent, not just unenforced. That's Part 1.
