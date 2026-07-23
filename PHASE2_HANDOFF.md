# Phase 2 Handoff: Backend Routes for the Listing/Variant Split

This document covers the work done to migrate the backend from
`sellerListingsTable` carrying price/stock/form directly (the pre-Phase-2
flat shape) to `sellerListingsTable` (listing-level fields only) +
`sellerListingVariantsTable` (price/stock/form/etc, one listing can have
several), per Phase 1's schema split.

**Verification status:** `pnpm run typecheck` passes clean across all 4
workspace packages (`api-server`, `tree-friend`, `mockup-sandbox`,
`scripts`). `api-server` and `tree-friend` (the two real deliverables)
build clean individually with `PORT` set. `mockup-sandbox`'s build fails
on missing `PORT`/`BASE_PATH` env vars it requires by design (see its own
`vite.config.ts`) -- confirmed environmental, not caused by anything in
this phase, and that package isn't in scope. No live database was
available in this environment, so nothing here was exercised against real
data; typecheck/build is the extent of verification possible.

---

## 1. The two decisions

### Decision 1: cart_items uniqueness

Added `sellerListingVariantId` to `cartItemsTable`. Uniqueness moved from
`(userId, sellerListingId)` to `(userId, sellerListingVariantId)`.
`sellerListingId` is **kept**, denormalized from the variant's own FK.

**Why keep `sellerListingId` at all** (rather than drop it and always join
through the variant): every existing read path that groups/joins cart
lines by seller (`buildCart`'s seller grouping in `cart.ts`, the
seller-group resolution in `orders.ts`, any admin "cart contents by
seller" view) does so via `sellerListingId` directly. Forcing all of those
through an extra join on the variant table just to recover the listing/
seller would touch more call sites for no benefit -- this mirrors the
convention the table already used for `productId` (also denormalized,
also kept for the same reason).

**Why a buyer CAN now have two cart lines against the same listing:** the
whole point of the Phase 1 split was letting one listing offer several
variants (e.g. "Sapling" and "Grafted" from the same seller). If cart
uniqueness had stayed at the listing level, a buyer physically could not
add both variants to their cart -- the second insert would collide with
the first. Moving uniqueness to the variant is not a nice-to-have, it's
required for the variant split to be usable at all.

### Decision 2: reviews uniqueness

Added `sellerListingVariantId` to `reviewsTable`. Uniqueness moved from
`(sellerListingId, userId)` to `(sellerListingVariantId, userId)`.
`sellerListingId` is **kept**, same denormalization rationale as above
(buyer-facing seller-card rating aggregation in `sellerListings.ts` and
`products.ts` groups by `sellerListingId` directly).

**Why per-variant, not per-listing:** a Sapling and a Grafted tree from
the same seller are different purchase/quality experiences -- different
growth stage, different handling, different survivability odds.
Collapsing their reviews into one per-seller bucket loses real signal a
buyer would want (e.g. "the Grafted trees from this seller are great, but
avoid their Saplings"). Since a review is meant to attach to something the
buyer actually purchased, and purchases are now variant-keyed (a
`sellerListingVariantId`, via the order's line items), the natural join
key for "did this buyer buy this" is the variant, not the listing.

Both changes are in `lib/db/src/schema/cart.ts`, `lib/db/src/schema/
reviews.ts`, and appended (append-only, matching the file's existing
convention) to `lib/db/src/schema/migration.sql`.

---

## 2. Files changed

| File | What changed |
|---|---|
| `lib/db/src/schema/cart.ts` | Added `sellerListingVariantId`, moved unique constraint |
| `lib/db/src/schema/reviews.ts` | Added `sellerListingVariantId`, moved unique constraint |
| `lib/db/src/schema/migration.sql` | Appended ALTER TABLE statements for both (append-only) |
| `artifacts/api-server/src/routes/sellerListings.ts` | Full rewrite: two-table CRUD, per-variant attribute validation, nested response shape, buyer-facing sort/filter now variant-aware, payment-method enforcement wired in |
| `artifacts/api-server/src/routes/cart.ts` | Full rewrite: third cart-line type via `sellerListingVariantId`, stock checks against the variant, delivery charge surfaced-not-summed |
| `artifacts/api-server/src/routes/orders.ts` | Listing-line resolution now reads from the variant; stock decrement moved to the variant table |
| `artifacts/api-server/src/routes/preOrders.ts` | Rewritten to require `sellerListingVariantId`, checks the variant's `isPreOrder` flag |
| `artifacts/api-server/src/routes/products.ts` | Added `listingMinPrice`/`listingMaxPrice`/`listingCount`, added full seller-listing data to product detail, removed variant creation from POST/PUT, removed variant copying from duplicate |
| `artifacts/api-server/src/routes/search.ts` | Autocomplete price now falls back to marketplace data when no admin variant exists |
| `artifacts/api-server/src/routes/wishlist.ts` | Same marketplace fallback for price/stock |
| `artifacts/api-server/src/routes/blogPosts.ts` | Same marketplace fallback for linked-product price/stock |
| `artifacts/api-server/src/routes/flashSales.ts` | **Deleted** -- see §4 |
| `artifacts/api-server/src/routes/index.ts` | Removed flash sales import/registration |
| `artifacts/api-server/src/routes/variants.ts` | POST/PUT/DELETE disabled (410) -- see §3 |
| `artifacts/api-server/src/routes/bulkImport.ts` | Stopped writing `productVariantsTable` rows -- see §3 |
| `scripts/src/verify-seller-marketplace.ts` | Fixed to create listing + variant (was still using pre-Phase-1 flat shape, didn't even typecheck against Phase 1's own schema before this) |

---

## 3. Fixes made beyond the explicit file list

The prompt's core rule -- "admin will no longer create any variant/price
data at all, not in `productVariantsTable`, not anywhere" -- was being
violated by three routes not in the explicit files-to-change list. Leaving
them as-is would have meant the whole migration had a side door. Flagging
each clearly since they're outside what was asked for:

1. **`POST /products/:id/duplicate`** (in `products.ts`) was copying the
   original product's `productVariantsTable` rows onto the duplicate.
   Fixed inline while rewriting `products.ts` -- a duplicated product now
   starts with zero variants, same as any newly-created product.

2. **`artifacts/api-server/src/routes/variants.ts`** is a standalone admin
   CRUD router (`POST`/`PUT`/`DELETE /products/:productId/variants`) that
   let admin freely create/edit/delete `productVariantsTable` rows,
   completely independent of what `products.ts` enforces. Grepped the
   frontend (`ProductModal.tsx`, the only admin UI referencing
   "variants") and confirmed it never calls these three endpoints
   directly -- it goes through `POST`/`PUT /products`'s own (now-ignored)
   `variants` field instead. Disabled the three write routes (return
   `410 Gone` with an explanatory message) rather than deleting the file
   outright, since `GET /products/:productId/variants` is still
   legitimately used to read legacy admin variants for the guest-checkout
   path.

3. **`artifacts/api-server/src/routes/bulkImport.ts`** (CSV bulk import)
   was inserting one `productVariantsTable` row per CSV row alongside
   product creation. This one is **only partially fixed**: I stopped the
   write (product creation/merge-by-name still works, `variantsCreated`
   correctly stays `0`, the response message was corrected to say so
   honestly instead of silently reporting variants that were never
   created), but I did **not** redesign the feature. Unlike the two above,
   this is a genuinely separate feature whose CSV format is built around
   "one row = one variant" -- fixing it properly requires a real product
   decision this phase doesn't make: does bulk import become
   products-only (drop the variant columns from the CSV format), or does
   it get taught to create `seller_listings` + `seller_listing_variants`
   against some seller (and if so, which seller -- admin isn't a seller)?
   Flagged in-code at the deletion site; needs a deliberate answer next
   phase, not a mechanical patch.

---

## 4. Flash sales: deleted, not adapted

`flashSales.ts` was entirely `productVariantsTable`-based (products
tagged `homepageTag = "flash"` with at least one variant with a
`discountPrice` set), with no seller/marketplace ownership concept at
all. Two reasons this doesn't get adapted:

- **It would silently break.** Admin no longer creates
  `productVariantsTable` rows as of this phase, so `GET /flash-sales`
  would return `[]` forever for any product created going forward, with
  no error to signal that -- a quiet dead feature is worse than a removed
  one.
- **The concept doesn't map cleanly onto a marketplace.** A discount is
  now a per-seller-listing-variant decision
  (`sellerListingVariantsTable.discountPrice`). "Site-wide flash sale"
  has no obvious single owner when N different sellers can each
  independently discount their own listings -- whose discount counts as
  "the flash sale"? That's a product decision, not something to guess at
  while doing a mechanical schema migration.

Deleted the route file and its registration in `index.ts`. On the
frontend side (not touched, Phase 3's job, flagged here for visibility):
`FlashSaleBanner.tsx` is a static countdown banner with no API call, so
it's unaffected. `FlashSaleSection.tsx` does call `GET /api/flash-sales`,
but it turned out to already be dead code -- grepped the whole frontend
and it isn't imported anywhere, so this removal breaks nothing currently
rendered.

---

## 5. `startingPrice`: not overloaded, but given fallbacks where the field is genuinely blind

The plan called for **not** overloading `startingPrice`'s existing
meaning ("the admin-set price") when adding marketplace data. In
`products.ts`'s `toProduct()`, that's exactly what happened:
`startingPrice`/`totalStock`/`inStock`/`variants` are untouched
(admin-`productVariantsTable`-derived, will read as `null`/`0`/`false`/
`[]` for every product created after this phase, since nothing writes
there anymore) and three new, clearly-separate fields were added instead:
`listingMinPrice`, `listingMaxPrice`, `listingCount` (marketplace-derived,
qualifying-variant-based).

But three *other* endpoints -- `search.ts` (autocomplete), `wishlist.ts`,
`blogPosts.ts` (related products) -- each have their own, narrower
`startingPrice`/`inStock` fields that exist purely as "the price/stock to
show in this UI surface," with no admin-vs-marketplace distinction
visible to the consuming component at all. Left as pure
`productVariantsTable`-only, every one of these would show blank
price/"out of stock" for every product created after this phase,
regardless of what sellers are actually offering -- a real regression a
buyer would notice immediately (autocomplete, wishlist, and blog "related
products" all silently losing prices). For these three specifically, the
field now falls back to the cheapest qualifying marketplace listing when
no admin variant price exists (admin price wins if legacy data is
present, for backward compat). This is a different judgment from
`toProduct()`'s, not an inconsistency with it: `toProduct()`'s consumer
(the product detail/list page) has separate, clearly-labeled fields for
each source and can show both distinctly; these three consumers only have
room for one number and no way to label its source, so "best available
price, whichever source has one" is the right behavior for them,
documented inline at each fallback site.

Full `startingPrice`/`flashSale`/`productVariantsTable`-write grep sweep
was run against the final state of the repo; see git history / diff for
the complete list this table summarizes.

---

## 6. Delivery charge: visible to the buyer, not collected by the platform

Per the plan, a marketplace listing variant's `deliveryCharge` is real
courier-fee data the buyer pays directly to the seller's courier account
-- it is **not** collected by the platform at checkout. This is enforced
structurally in `orders.ts`, not just by convention: `ResolvedLine` has
two separate delivery-charge-shaped fields for a reason --

- `orderItem.deliveryCharge` -- the real value from the variant, always
  populated, shown to the buyer on the order.
- `ResolvedLine.deliveryCharge` (the one that actually gets summed into
  `groupDeliveryFee` -> `groupTotal`, the platform-collected total) --
  hard-coded to `0` for marketplace lines.

Keeping these as two structurally distinct fields (rather than one field
with a "don't sum this one" comment) means a future edit that looks like
it's deduplicating "redundant" fields can't accidentally start charging
the courier fee through the platform.

**Known frontend gap, not fixed (out of scope, flagged for Phase 3):**
`OrderDetailPage.tsx` derives its displayed "Delivery" line by
back-solving `totalAmount - subtotal + discount`, rather than reading
`orderItem.deliveryCharge` directly. Since marketplace delivery charges
are deliberately excluded from `totalAmount`, this derived value will
correctly show `0`/"Free" for pure-marketplace orders -- which is safe
(it won't show a false platform-collected number), but it also means the
buyer never sees the real courier fee they owe on that page, even though
it's sitting right there in the order's own item data. Worth a follow-up
to read `deliveryCharge` per line directly instead of back-solving.

---

## 7. Worked example: price_asc sort with a partially-sold-out listing

`GET /products/:productId/seller-listings?sort=price_asc`

Setup:
- **Listing A** (Fatima's Nursery): Variant A1 "Sapling" — price 300,
  `availableQuantity: 0` (sold out). Variant A2 "Grafted" — price 900,
  discountPrice 800, `availableQuantity: 5`.
- **Listing B** (Karim's Garden): Variant B1 "Seed" — price 150,
  `availableQuantity: 20`.

**Step 1 — qualifying-variant filter** (`availableQuantity > 0`):
Listing A's qualifying variants = `[A2]` (A1 dropped). Listing B's =
`[B1]`. Both listings have ≥1 qualifying variant, so both stay in the
response. (If A2 were *also* sold out, Listing A would be dropped
entirely — not shown with an empty variant list.)

**Step 2 — cheapest qualifying price per card** (discountPrice if set,
else price, computed only across qualifying variants): Listing A → `800`
(A1's 300 is excluded even though it's numerically lower — it's not
purchasable). Listing B → `150`.

**Step 3 — sort ascending:** `[Listing B (150), Listing A (800)]`.

Karim's Garden appears first. This is correct: the only thing a buyer can
actually buy from Fatima right now is the 800-taka Grafted tree. If the
sold-out 300-taka Sapling had been allowed to represent Listing A, it
would have wrongly jumped ahead of Karim's genuinely-cheaper, genuinely-
available B1 — advertising a price nobody can actually pay. Both listings
are still returned with *all* their variants nested (A1 included, marked
`availableQuantity: 0`) — only the sort key ignores non-qualifying
variants.

---

## 8. Other flagged gaps (not fixed, out of scope)

- **`artifacts/api-server/src/routes/reviews.ts`** is entirely
  product-level (no `sellerListingId`/`sellerListingVariantId` awareness
  at all) -- it never picked up the marketplace model even before this
  phase, let alone the variant split. Not in the files-to-change list;
  left untouched, but the new `reviewsTable.sellerListingVariantId`
  column and its uniqueness constraint (§1, Decision 2) are currently
  unused by any route. A future phase needs to wire this route up to
  actually verify purchase-via-`sellerListingVariantId` before accepting
  a review, using the new column.
- **`preOrders.ts`'s `notifyPreOrderCustomers`** is still keyed by admin
  `productId` + `productStatus` flip (`products.ts` calls it when
  `productStatus` goes `pre_order` -> `in_stock`). This is now
  inconsistent with pre-order creation itself, which is fully
  variant-based and has nothing to do with `productsTable.productStatus`.
  Left as-is (changing its trigger condition is a product decision, not a
  mechanical update) -- flagged in-code and here.
