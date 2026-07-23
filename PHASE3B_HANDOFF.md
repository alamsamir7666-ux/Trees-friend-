# Phase 3b Handoff — Frontend Detail Pages

Completes the marketplace migration's buyer-facing frontend: the
product detail page's admin-variant buy box is gone, seller listing
cards are now the real purchase surface, a new per-listing detail page
exists, pre-order is variant-scoped, `ProductCard` no longer shows a
dead-code price, and the sitewide flash sale banner is gone.

## What changed, file by file

### Backend

**`artifacts/api-server/src/routes/sellerListings.ts`** — added
`GET /seller-listings/:id`, a buyer-facing route returning one listing's
full detail (nested variants + seller info), publicly, gated the same way
as the existing list route (public visibility + approved + seller active).
No existing route served this: `GET /seller-listings/mine` is
seller-auth-scoped to the caller's own listings, and
`GET /products/:productId/seller-listings` returns a *list* of cards, not
one listing's full detail by id. Unlike the list route, this one does
**not** drop a listing for having zero in-stock variants — a listing
detail page should be able to show a sold-out listing (each variant
individually marked unavailable), not 404 the whole thing.

### API contract (`lib/api-spec/openapi.yaml`) + generated code

- Fixed `AddToCartBody`: added `sellerListingVariantId: number | null`,
  and rewrote the description to match what `cart.ts`'s real handler
  does — exactly one of `variantId`/`sellerListingVariantId` required,
  and `sellerListingId` (if sent) is **silently ignored** for line
  creation; the route derives it from the variant's own FK. The old
  description ("specify variantId or sellerListingId") was simply wrong
  about which field the backend actually reads.
- Added `GET /seller-listings/{id}` path under the *existing*
  `/seller-listings/{id}` path block (see gotcha below), wired to the new
  route above, reusing the existing `SellerListingCard` schema since the
  response shape is identical to the list route's per-item shape.
- Regenerated `lib/api-client-react/src/generated/*` and
  `lib/api-zod/src/generated/api.ts` via `pnpm run codegen` in
  `lib/api-spec` — clean, `typecheck:libs` passed.
- `CreatePreOrderBody` doesn't exist in the spec at all, and never did —
  `PreOrderCheckoutPage.tsx` calls `/pre-orders` via a raw `fetch`, not a
  generated hook. Nothing to regenerate there; Part 4 below is a manual
  body-literal fix.

**Codegen gotcha worth flagging:** my first attempt at the new path added
`/seller-listings/{id}:` as a **new top-level YAML key**, not realizing
that path already existed (for `PUT`/`DELETE`). That's a duplicate mapping
key — valid-ish YAML (the second occurrence silently wins in a plain
parse) but not valid OpenAPI, and it made orval fail with an opaque
*"Failed to resolve input: Please provide a valid string value or pass a
loader to process the input"* with no line number. Took a few rounds of
bisecting against a pristine copy of the spec to isolate. Fixed by adding
my `get:` method under the existing path block instead. If you ever see
that exact orval error again, check for duplicate path keys first.

### Part 1 — `ProductDetailPage.tsx`

Removed entirely: the `VariantSelector`/`ProductVariant`-driven buy box
(price display, variant picker, stock-level pill, quantity stepper,
Add to Bag / Pre-Order Now / Out of Stock buttons), `handleAddToCart`,
`useAddToCart`/`useGuestCart` usage, the `selectedVariant`/`qty`/
`justAdded` state, and the stock-alert bottom sheet (`showStockSheet`,
the `useEffect` that opened it, `StockAlertButton`, the `createPortal`
block). Kept: images/gallery, description, key benefits, care guide, best
for, trust badges, reviews, Q&A, related products, recently viewed — none
of it referenced the removed state. The wishlist heart button survives,
moved next to the rating row since it no longer has a buy box to sit next
to. Fixed the SEO `priceAmount` fallback from `product.startingPrice` to
`product.listingMinPrice`.

**Stock-alert decision:** I removed the "Notify me when back in stock" UI
entirely rather than try to keep it. `stockAlerts.ts` is entirely keyed on
`productVariantsTable` (the dead/frozen admin variants table) — every
query in that route joins against it. Re-pointing stock alerts at
`sellerListingVariantsTable` instead is a real backend redesign (new
table or schema change, new matching logic for "which variant of which
listing"), not a mechanical fix, so it's out of scope for this phase. A
button that could never fire felt worse than no button; flagging this as
a real product decision for next phase or product review, not something
I'd consider fully resolved.

Pre-existing, not touched: `ImageZoom` is imported but never used in this
file (dead import, predates this phase). Left as-is since the image
gallery was explicitly out of scope.

### Part 2 — new variant picker + `SellerListingsSection.tsx`

Added `components/ui/SellerListingVariantPickerDialog.tsx` — a fresh,
small dialog for picking one `SellerListingVariant` from a single
listing. **Not** an adaptation of the admin `VariantPickerDialog`/
`VariantSelector` pair — both are tightly shaped around admin
`ProductVariant` (`variantType`, `name` fields) that `SellerListingVariant`
doesn't have, so reusing them would have meant either fighting their
assumptions or quietly reviving a path back to the admin-variant model.

Rewrote `SellerListingsSection.tsx`:
- Add to Bag now sends `sellerListingVariantId` (not the previous,
  silently-ignored `sellerListingId`).
- If a listing has exactly one qualifying variant (`availableQuantity >
  0`), Add to Bag proceeds directly — no picker, no added friction where
  there's no real choice.
- If a listing has multiple qualifying variants, Add to Bag opens the new
  picker dialog scoped to that one listing.
- Guests get a "Sign in to buy" state instead of a working button —
  guest checkout (`routes/orders.ts` `POST /orders/guest`) is
  admin-direct-only by design, so a guest adding a seller-listing item
  would only fail later at checkout; gating here makes the failure
  immediate and the reason legible.
- Added a "See details" link per card, to the new listing detail page
  (Part 3).
- The per-card headline price picks the cheapest *qualifying* variant
  (falling back to the cheapest variant overall if every variant on that
  listing happens to be sold out), mirroring the same rule
  `sort=price_asc` already uses server-side, so the card's price doesn't
  contradict the sort order it's displayed under.

### Part 3 — new `SellerListingDetailPage.tsx`

New page at `/products/:productId/listings/:listingId` (route added in
`App.tsx`, placed before the more general `/products/:id` route — not
strictly required, since wouter's default matcher won't match a route
with extra path segments against a shorter pattern, but kept for
readability). Shows what a seller card can't fit: every variant (not just
the cheapest), all listing images (not just the first), embedded video if
present, full description/offer text/certification, delivery/warranty/
return-policy terms, tags, and seller info with rating.

Each variant gets its own action, independently: **Add to Bag** if
`availableQuantity > 0`; **Pre-Order Now** if `isPreOrder` is true (a
variant can be simultaneously out of stock *and* pre-orderable — these
are independent flags on `sellerListingVariantsTable`, not mutually
exclusive states, confirmed by reading `preOrders.ts`); otherwise a
disabled "Out of Stock" button. This is the per-variant purchase surface
Part 4 needed pre-order to become variant-aware.

### Part 4 — `PreOrderCheckoutPage.tsx`

Now reads `sellerListingVariantId` from the URL (set by the new "Pre-Order
Now" link on `SellerListingDetailPage.tsx`) and includes it in the POST
body, alongside a client-side guard that shows "Please select an option
before pre-ordering" if it's missing — mirrors the server's own 400 for
the same condition, just surfaced before the round-trip. Confirmed via
`preOrders.ts` that the server derives the actual charged price and
delivery charge from the variant row itself, ignoring whatever the client
sends for `price=`/similar query params — those remain display-only for
the order summary panel, exactly as before. Did not touch the existing
Dhaka/non-Dhaka flat delivery-charge estimate shown in the UI; it was
already disconnected from any real per-listing `deliveryCharge` before
this phase, and reconciling that wasn't part of what Part 4 asked for.

### Part 5 — `ProductCard.tsx`

Removed the entire product-level Add to Bag / Pre-Order Now button and
its supporting state, admin-variant imports, and `VariantPickerDialog`
usage — a product card is a discovery surface now, not a purchase
surface; buying requires picking a seller (and often a variant of that
seller's listing), which this card doesn't know. Both actions are one
click away via the card's existing link to the product detail page's
seller cards / listing detail page. Price display now uses
`listingMinPrice`/`listingMaxPrice` (a range if they differ, a single
figure if they're equal), with a `listingCount > 1` "N sellers" badge, and
a plain "Not currently available" label when `listingCount === 0`.
Wishlist and compare-drawer buttons are unchanged — both are genuinely
product-level actions unaffected by which seller you'd buy from.

Also trimmed `ProductCardSkeleton.tsx`'s bottom skeleton line, which
mimicked a full-width button shape that no longer exists on the real
card.

### Part 6 — flash sale banner removed

Removed `<FlashSaleBanner>`, the `getTodayMidnight()` helper, the
module-level `FLASH_SALE_END` constant, and the now-unused import from
`App.tsx`. Grepped the whole frontend afterward for
`flashsale`/`flash-sale`/`flash_sale` (case-insensitive) — zero remaining
references in `App.tsx` (only self-references inside the two component
files themselves).

**Judgment call:** left `components/FlashSaleSection.tsx` and
`components/ui/FlashSaleBanner.tsx` in place, now fully orphaned (nothing
imports either). Deleting unreferenced files felt like a bigger, more
irreversible action than the prompt asked for ("remove the ... banner
from App.tsx"), and leaving them costs nothing — no bundler will pull in
code nothing imports. Flagging them here in case a future cleanup pass
wants to delete them outright.

## Known pre-existing issues found, deliberately NOT fixed

Per the prompt's explicit "do not touch" list (reviews, Q&A, wishlist
page, search, comparison, blog carousel — "none of these were asked to
change this phase"), I left the following alone even though I noticed
them while grep-sweeping for safety:

- `ProductComparison.tsx`, `SearchAutocomplete.tsx`,
  `BlogProductCarousel.tsx`, `ProductsPage.tsx` (price sort),
  `ComparePage.tsx`, `WishlistPage.tsx`, and admin `ProductsTab.tsx` all
  still read `product.startingPrice`, which still exists on the generated
  `Product` type (kept for backward compat) but is permanently `null`
  now. None of this breaks typecheck — `startingPrice` is still a real,
  typed field — so none of these files were "broken" by Part 0/5's
  changes in the sense the prompt was checking for. But it does mean
  price sort on `/products`, the comparison table's price column, search
  autocomplete's price line, and the blog carousel's price line are all
  silently showing nothing/wrong-order right now, sitewide, and have
  presumably been doing so since Phase 3a. Worth a dedicated pass.
- `ProductComparison.tsx`'s `ComparisonDrawer.handleAddToCart` and
  `WishlistPage.tsx`'s add-to-cart both still key off `product.variants`
  (the frozen admin `ProductVariant[]`, presumably always empty now),
  same as `WishlistPage.tsx`'s wishlist-to-cart flow already did before
  this phase — effectively dead code paths, not newly broken, not fixed.
- `components/auth/ProfileSync.tsx`'s guest-cart-to-real-cart sync on
  login calls `addToCart.mutate({ productId, quantity })` with no
  `variantId` at all — looks like a pre-existing gap (unrelated to this
  phase's changes), not something I introduced or was asked to fix.

## Verification performed

1. `pnpm install` — clean, from scratch.
2. `pnpm run codegen` inside `lib/api-spec` — clean; real output pasted
   above in the "API contract" section.
3. `rm` of all `.tsbuildinfo`/`dist`, then `pnpm run typecheck` at the
   root — clean across all 9 workspace projects (`api-server`,
   `mockup-sandbox`, `tree-friend`, `scripts`, plus the 5 libs via
   `typecheck:libs`). Ran this twice (once mid-work, once at the very
   end from a fully clean state) — both clean.
4. Grepped the whole frontend for `flashsale`/`flash-sale`/`flash_sale` —
   zero references outside the two now-orphaned component files.
5. Diffed the entire project tree against the pristine Phase 3a zip to
   produce the final change list above — confirmed exactly the files
   Parts 0–6 should have touched, nothing more.

## Suggested next steps

- Decide whether to delete the orphaned `FlashSaleBanner.tsx`/
  `FlashSaleSection.tsx`, or repurpose them for a real per-seller or
  per-listing promotion mechanism now that "one sitewide discount" isn't
  a coherent concept anymore.
- A dedicated pass on the `startingPrice` fallout listed above — probably
  its own small phase, since it touches five-plus files across search,
  comparison, blog, and sort, none of which this phase was scoped to
  redesign.
- Decide whether stock alerts should be rebuilt against
  `sellerListingVariantsTable` (real backend work: new matching logic for
  "notify me when *this specific seller's variant* restocks", possibly a
  new table) or retired as a concept in the marketplace model.
