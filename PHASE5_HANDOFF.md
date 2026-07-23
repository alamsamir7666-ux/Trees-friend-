# Phase 5 Handoff — Admin Status Cleanup + Seller Listing Detail Page Fixes

Three independent parts, done sequentially as instructed. Part A and Part B
are complete and verified (typecheck + hand-traced runtime logic). Part C's
fallback-image fix is complete; the layout-bug fix is **not applied** —
diagnosed as far as source-only inspection allows, root cause not found,
explicitly left for a human with render access. Details below, including
where this phase deviated from the prompt (a process note the prompt itself
requires — see PROJECT_HANDOFF.md's process for gap-flagging).

## Process note: no PROJECT_HANDOFF.md was available this phase

The prompt names `PROJECT_HANDOFF.md` as required reading, attached
alongside the prompt. It was not actually present in the uploaded files in
either round of this phase. Rather than block on it, the repo owner
answered the two questions that actually depended on it directly, in their
own words, over chat:

1. Whether a whole-product pre-order flag (independent of any seller
   variant) has a legitimate business meaning post-Phase-2: **no** — every
   product is sold through sellers, there is no admin-fulfilled inventory
   path at all, so option (b) below was chosen on that basis, not on
   inherited language from the prompt.
2. Confirmation that the buyer-badge / notify-trigger tradeoffs proposed in
   the prompt were reasonable to act on.

Where this handoff says "per the settled model," it means "per the repo
owner's direct answer in this conversation," not "per a file I read." That
distinction matters and is being stated plainly rather than glossed over.

Two other prompt claims were independently re-verified rather than trusted
as given, and one of them was wrong:

- The prompt asserted sellers have no post-creation UI to flip a variant's
  `isPreOrder` flag, and framed that as an open question to check. Traced
  `SellerListingForm.tsx`'s edit path (`editing` prop → `useUpdateSellerListing`
  → PUT `/seller-listings/:id`) end to end: sellers **do** have this, via
  the same form used for both create and edit, submitting `isPreOrder` for
  any variant with an existing `id`. This is corrected below (see Part B).
- Mid-Part-C, I proposed a routing-mismatch theory (`listings` vs
  `seller-listings` path segments) as the layout bug's cause. It was wrong
  — the actual link (`SellerListingsSection.tsx:208`) and the registered
  route (`App.tsx:368`) both use `/listings/`, consistently. Retracted
  after checking; see Part C.

---

## Part A — `.inStock` display bugs

### What was broken

`ProductsTab.tsx`'s Stock column and `DashboardTab.tsx`'s "N low stock"
stat both read `Product.inStock`, which is permanently `false` for every
product created after Phase 2 (admin no longer writes
`productVariantsTable`). Confirmed by reading `toProduct()` in
`products.ts`: `inStock`/`totalStock`/`startingPrice`/`variants` are all
still admin-`productVariantsTable`-derived by explicit design (doc comment
present, not accidental), separate from the newer marketplace fields.

### Repo-wide grep (as instructed, not assuming the prompt's file list was complete)

```
$ grep -rn "\.inStock\b" . --include="*.ts" --include="*.tsx" | grep -v node_modules
./artifacts/tree-friend/src/components/admin/tabs/DashboardTab.tsx:117
./artifacts/tree-friend/src/components/admin/tabs/ProductsTab.tsx:116
./artifacts/tree-friend/src/components/admin/tabs/ProductsTab.tsx:117
./artifacts/tree-friend/src/components/blog/BlogProductCarousel.tsx:15

$ grep -rn "\.totalStock\b" . --include="*.ts" --include="*.tsx" | grep -v node_modules
(no results)
```

`BlogProductCarousel.tsx` was pre-flagged in the prompt as a traced false
alarm (its `LinkedProduct.inStock` comes from `blogPosts.ts`'s
`resolveLinkedProducts()`, a deliberately separate marketplace-derived
field with the same name — not the deprecated `Product.inStock`). Left
alone per the prompt's instruction not to re-flag without re-tracing;
spot-checked that the function still exists and still has its Phase 2 doc
comment, did not re-derive the whole thing from scratch.

`.totalStock` has zero hits anywhere in the repo — the prompt's hedge
about it was unnecessary but harmless.

### Fix

Both files now derive stock from `listingCount` (Phase 2 marketplace stat,
already computed server-side) instead of the frozen `inStock`, matching
the pattern the Price column two rows up in `ProductsTab.tsx` already used
correctly.

**Confirmed `listingCount` actually reaches `AdminContext`** (the prompt
asked this be checked, not assumed) by tracing the full path:
`AdminPage.tsx`'s `useListProducts` hook → `GET /products` in
`products.ts` → `fetchMarketplaceStatsFor(ids)` → `toProduct(..., marketplaceMap.get(p.id))`
→ serialized as `listingCount` on every product in the response. No admin-
specific route bypasses this; it's the same `GET /products` used
elsewhere. `AdminProduct`'s TS interface doesn't type `listingCount`
explicitly, but it doesn't need to — it has `[key: string]: unknown`, and
the runtime value is genuinely present, verified by reading the server
code, not assumed from the type.

**Files changed:**
- `artifacts/tree-friend/src/components/admin/tabs/ProductsTab.tsx` — Stock
  column now reads `(p as any).listingCount ?? 0`.
- `artifacts/tree-friend/src/components/admin/tabs/DashboardTab.tsx` — "low
  stock" count now filters on `listingCount === 0` instead of `!inStock`.

### Open item found, not fixed (out of scope, flagged per process)

`DashboardTab.tsx`'s "Products" stat mixes a paginated client-side array
(`products`/`allProducts`, only the currently-loaded page) with a
server-side `total` (`productsData?.total`) for different halves of the
same stat card — the count uses `total`, the "N low stock" fraction uses
the paginated array. This was already true before this phase and is
unrelated to the `.inStock` bug; not touched, per the prompt's explicit
instruction not to fold unrelated fixes into this phase.

---

## Part B — Admin no longer controls Product Status

### Decision made, and why

Per the repo owner's direct answer (see process note above): every
product in Tree Friend is sold through sellers; there is no
admin-fulfilled inventory path post-Phase-2. A product with zero seller
listings isn't "pre-order," it's a product nobody sells yet — a real,
different state, already representable via `listingCount === 0`.

**Chosen: option (b)** — remove `productStatus`-driven admin control
entirely; migrate the pre-order notify trigger to fire off
`sellerListingVariantsTable.isPreOrder` transitions instead of the
admin-set product field.

### What changed

**`ProductModal.tsx`** — the "Product Status" dropdown is gone (UI, form
init state, and PATCH submit payload). Admin has zero UI control over
stock/pre-order status now.

**`products.ts`** (PATCH `/products/:id`) — no longer writes
`productStatus` from request body. The old notify trigger
(`productStatus: "in_stock"` transition from `"pre_order"` firing
`notifyPreOrderCustomers`) is deleted outright, along with the now-dead
`beforeProduct` query that only existed to support it. The column itself
is left in the DB schema (out of scope to migrate/drop this phase; nothing
this phase does depends on dropping it, and it's a separate, larger
migration question).

**`sellerListings.ts`** (PUT `/seller-listings/:id`) — new trigger added
inside the existing variant-update loop. Fires `notifyPreOrderCustomers`
once per request (not once per variant — a boolean flag set inside the
loop, checked once after) when any updated variant transitions **out of**
"pending pre-order" (`isPreOrder: true` AND `availableQuantity: 0`) —
either by `isPreOrder` flipping to `false`, or by `availableQuantity`
becoming `> 0`. Uses `existingVariants` (already fetched pre-mutation
earlier in the same handler) as the before-state, so no extra query was
needed.

**`preOrders.ts`** — the Phase 2 doc comment flagging this exact
inconsistency (present since Phase 2, cited in the prompt) is updated to
mark it resolved and point at the new trigger location, with the known
imprecision below documented in the same comment.

**`ProductsTab.tsx`** — the Pre-Order badge, previously
`p.productStatus === "pre_order"` (an admin-set flag, now meaningless),
now reads a new `listingHasPreOrder` field: true if *any* qualifying
seller listing has a variant with `isPreOrder: true`.

**`CategoriesTab.tsx`** — same problem in miniature: a raw `{p.productStatus}`
dump in a "Status" column. Replaced with the same
`listingHasPreOrder`/`listingCount`-derived signal used in `ProductsTab.tsx`,
for consistency.

**`products.ts`**'s `MarketplaceStats`/`fetchMarketplaceStatsFor`/`toProduct()`
— extended with a new `listingHasPreOrder: boolean` field to support the
badge fix above (this field didn't exist before this phase; needed for the
badge to have anything real to read). The underlying query's `WHERE`
clause was widened from `availableQuantity > 0` alone to
`availableQuantity > 0 OR isPreOrder = true` (a pre-order variant is
typically AT zero stock — that's the point of pre-order — so it would
never have appeared under the original condition). `listingCount`/
`listingMinPrice`/`listingMaxPrice` deliberately keep their original
meaning: they're computed only over the subset of these now-wider rows
that still pass the original `availableQuantity > 0` check (filtered in
JS, not SQL), so this widening does not silently change "Available From N
Sellers" or price-range semantics for any existing caller.

### Buyer-facing badge question

The prompt raised this as a real risk to check before deciding: whether
`ProductDetailPage.tsx` or elsewhere on the buyer side reads
`productStatus` for a pre-order badge that would break if reads stopped.

Checked directly:

```
$ grep -rln "productStatus" artifacts/tree-friend/src --include="*.tsx"
artifacts/tree-friend/src/components/admin/modals/ProductModal.tsx
artifacts/tree-friend/src/components/admin/tabs/ProductsTab.tsx
artifacts/tree-friend/src/components/admin/tabs/CategoriesTab.tsx
artifacts/tree-friend/src/contexts/AdminContext.tsx
```

All four reads are admin-side. `ProductDetailPage.tsx` has zero references
to `productStatus` — the hypothetical buyer-facing badge the prompt asked
me to check for does not exist in this codebase. That branch of the
decision tree in the prompt is moot; nothing was left "deliberately
reading a frozen value" on the buyer side because there was nothing there
to begin with.

### Known gap, deliberately not fixed — real over-notification risk

`preOrdersTable` has **no `sellerListingVariantId` column** — confirmed by
reading the schema (`lib/db/src/schema/preOrders.ts`) directly, not
assumed. The POST `/pre-orders` route receives `sellerListingVariantId` in
its body and uses it for validation/pricing at creation time, but never
persists it. This means `notifyPreOrderCustomers(productId, ...)` can only
ever be scoped to "everyone with a pending pre-order on this product," not
"everyone who pre-ordered this specific variant."

Consequence: a product sold by multiple sellers can over-notify — a
customer who pre-ordered seller A's variant can get notified when only
seller B's unrelated variant becomes available. This is a strict
improvement over the old trigger (which had zero relationship to real
pre-order state at all and could never fire correctly), but it is not
exact.

Fixing this precisely needs a schema change: add `sellerListingVariantId`
to `preOrdersTable`, thread it through from the POST body (which already
receives it and currently discards it). Out of scope for this phase —
tracked here as an open item for a future phase, not silently shipped.

### Verification: end-to-end trace of the new trigger (not just typecheck)

The prompt is explicit that a typecheck pass doesn't prove notification
logic is correct — this project has been bitten by exactly that class of
bug before. Hand-traced four cases against the actual code in
`sellerListings.ts`'s PUT handler:

1. **`isPreOrder` true → false, on a zero-stock variant** (customer
   pre-ordered; seller turns pre-order off): `before.isPreOrder && before.availableQuantity===0`
   is true; `nextIsPreOrder` resolves to `false`; `!nextIsPreOrder` is
   true → **fires.** ✓
2. **`availableQuantity`/`stock` 0 → >0, `isPreOrder` stays true**
   (classic restock-fulfills-preorder case): guard is true;
   `nextAvailableQuantity` resolves to the new value; `> 0` → **fires.** ✓
3. **Unrelated field edited (e.g. price) on a pending-pre-order variant,
   stock/isPreOrder untouched in the request**: guard is true, but neither
   `nextIsPreOrder` nor `nextAvailableQuantity` changes from their before-
   values (fallback logic correctly preserves them when the field wasn't
   in the payload) → **does not fire.** ✓ (no false positive)
4. **Variant wasn't in pending-pre-order state to begin with** (`isPreOrder:
   false`, or `isPreOrder: true` with existing stock): guard itself is
   false → **skipped entirely**, no false trigger on ordinary restocks of
   normal variants. ✓
5. **Brand-new variant created with `isPreOrder: true`**: goes through the
   `toCreate` branch, never touches this trigger logic at all — correct,
   since a newly created variant cannot have existing pending pre-orders
   against it.

All five match intended behavior. This was checked by reading the code
path, not by running the server (no live DB/WhatsApp/Twilio credentials
available in this environment) — so it is logic-level verified, not
integration-tested. That distinction is worth preserving in review.

---

## Part C — Seller Listing Detail Page

### 1. Fallback image — fixed, verified by source (no render needed)

The reported bug (`SellerListingDetailPage.tsx:56`, fallback URL
`images.unsplash.com/photo-1556228578-8c89e6adf883`, rendering as an
unrelated skincare product photo) was confirmed present exactly as
described.

Per the prompt's instruction to check for copy-paste elsewhere, grepped
the full repo:

```
$ grep -rn "images.unsplash.com" artifacts --include="*.tsx" --include="*.ts" | grep -v node_modules
```

The same broken photo ID (`photo-1556228578-8c89e6adf883`) was hardcoded
in **8 files**, not just the one named in the prompt:
`ProductCard.tsx`, `ProductDetailPage.tsx`, `WishlistPage.tsx`,
`SubscriptionsPage.tsx`, `CartPage.tsx` (×2 separate call sites),
`SellerListingDetailPage.tsx`, `OrderDetailPage.tsx`. (`InstagramFeed.tsx`
and `HomePage.tsx` use different, unrelated Unsplash photo IDs — not
touched, out of scope, not confirmed broken.)

**Fix chosen: option (b) from the prompt** — a proper "no image available"
placeholder UI instead of any external hotlink, rather than swapping in a
different Unsplash ID. Reasoning: any hardcoded external photo ID has the
exact same fragility that caused this bug (the prompt's own words: "the
underlying photo can change or be removed"); picking a new one just moves
the failure mode, it doesn't fix it. Also had no reliable way to source a
guaranteed-correct replacement photo URL from inside this environment
without repeating the same risk.

Added `artifacts/tree-friend/src/components/ui/NoImagePlaceholder.tsx` — a
small icon+text component (Sprout icon, "No image" label), with a
`compact` variant (icon only, no label) for small thumbnails (≤~48–64px)
where the label would be illegible. Applied at all 8 sites, replacing the
hardcoded fallback URL with conditional rendering (`img ? <img .../> :
<NoImagePlaceholder />`), since a placeholder component can't be assigned
to an `<img src>` the way a URL string could.

This fix needs no live render to trust — it's a hardcoded-string-into-
component swap, not a layout question, and the "no external dependency"
property is self-evidently true from reading the component.

### 2. Layout bug — **NOT FIXED.** Diagnosed from source only; root cause not found.

Marking this explicitly and plainly, per the process compromise agreed for
this phase: **this is not fixed, not confirmed, unverified-by-render.**

No render access was available in this environment (the app throws at
startup without a real `VITE_CLERK_PUBLISHABLE_KEY` — confirmed by reading
`App.tsx` directly — and there's no live database/API server to serve real
listing data either). The repo owner confirmed no staging URL or Clerk/API
credentials were available this round, and explicitly authorized
proceeding on source-only diagnosis with this fix marked as unverified
rather than waiting.

**What was checked, all from source, all ruled out as the cause:**

- **Component JSX/CSS itself**: read in full. Ordinary Tailwind
  (`grid grid-cols-1 md:grid-cols-2 gap-12`), no dynamic class
  construction (`` `grid-cols-${n}` `` or similar — the exact pattern the
  prompt warned would silently fail Tailwind's JIT scan), no typo'd class
  found.
- **Route registration vs. the actual link that reaches this page**: a
  routing-mismatch theory was raised mid-session (route registered as
  `/products/:productId/listings/:listingId` in `App.tsx`, prompt's bug
  report referenced `/seller-listings/:listingId`) and **was wrong** —
  checked and retracted. The real link
  (`SellerListingsSection.tsx:208`, `` `/products/${productId}/listings/${card.listing.id}` ``)
  and the registered route agree with each other exactly. No frontend
  file anywhere uses a `/seller-listings/` path segment for this page (the
  API endpoint is `/seller-listings/:id`, but that's a backend route, not
  a frontend page path — unrelated).
- **Top-level wrapper diff against `ProductDetailPage.tsx`** (confirmed
  correctly-rendering per earlier phases), as specifically requested:
  identical structure —
  `min-h-screen bg-background` → `container mx-auto px-4 py-8` →
  `PageBreadcrumb` → back button → `grid grid-cols-1 md:grid-cols-2 gap-12`.
  No difference found at the JSX/class level between the two files'
  outermost containers.
- **Shared layout wrapper**: there isn't one. `App.tsx` registers both
  routes as direct component renders with no intervening `<Layout>` or
  similar HOC, so a shared-wrapper bug (which would explain "only some
  pages break") isn't structurally possible here — ruled out, not just
  unchecked.
- **Loading and not-found states**: read both; neither has any layout
  logic that could produce a "broken narrow column" distinct from the
  loaded state's own grid.
- **The data-fetching hook** (`useGetSellerListing`, generated codegen):
  normal shape, `enabled: id !== null && id !== undefined` (not gated on
  truthiness, so a parse failure to `0` wouldn't silently hang it) —
  nothing anomalous.

**Conclusion**: every mechanism named in the prompt (missing Tailwind
generation, broken container/grid class, CSS import order, a shared
wrapper) was checked directly and none of them reproduce or explain the
reported symptom. The two files this bug report and its known-working
comparison point at are structurally identical at the source level. If the
bug is real (no reason to doubt it is — the report is specific and
detailed), its cause is something source-only inspection in this
environment cannot see: most likely a runtime data-shape issue (some field
on the real `SellerListingCard` response arriving in an unexpected shape
and affecting render in a way not visible from the component's own type
usage), a build/deploy-time artifact not present in this repo snapshot, or
a compiled-CSS-specific issue that only manifests post-build.

**Outstanding verification step, exact and specific**: load
`/products/:productId/seller-listings/:listingId` — using a real
product/listing pair — locally or on staging, and compare the rendered
result against the two reference screenshots attached to the original
prompt (card-style browse grid; full two-column detail page with gallery
left, buy box + specs right). Use devtools/computed styles on the broken
render, as the prompt originally specified, to see what's actually
happening to the grid at runtime — that inspection could not be done here
and is the next concrete step, not further source reading.

No speculative code change was applied for the layout issue. Applying an
unverified fix for a bug I could not actually reproduce or explain seemed
more likely to create false confidence than to help — better to hand back
an accurate "not found" than a guess dressed up as a fix.

---

## Verification

### `pnpm install` + `pnpm run typecheck`, clean state, full output

```
$ pnpm install
Progress: resolved 667, reused 0, downloaded 667, added 667, done
devDependencies:
+ prettier 3.8.3
+ typescript 5.9.3
Done in 47s

$ pnpm run typecheck
 WARN  Unsupported engine: wanted: {"node":"24.x"} (current: {"node":"v22.22.2","pnpm":"9.15.0"})

> workspace@0.0.0 typecheck /home/claude/repo/Trees-friend--main
> pnpm run typecheck:libs && pnpm -r --filter "./artifacts/**" --filter "./scripts" --if-present run typecheck

> workspace@0.0.0 typecheck:libs /home/claude/repo/Trees-friend--main
> tsc --build

Scope: 4 of 9 workspace projects
artifacts/api-server typecheck$ tsc -p tsconfig.json --noEmit
artifacts/mockup-sandbox typecheck$ tsc -p tsconfig.json --noEmit
artifacts/tree-friend typecheck$ tsc -p tsconfig.json --noEmit
scripts typecheck$ tsc -p tsconfig.json --noEmit
scripts typecheck: Done
artifacts/mockup-sandbox typecheck: Done
artifacts/api-server typecheck: Done
artifacts/tree-friend typecheck: Done
```

Run twice during this phase (after Part A, and again after all Parts A+B+C
edits) — clean both times, zero errors. The `node 24.x` engine warning is
pre-existing (sandbox has node 22.22.2) and unrelated to any change made
this phase.

### Manual/logical checks performed in lieu of a live environment

- Part A: traced `listingCount`'s full path from DB query to admin UI
  (see Part A section above) rather than trusting the type signature.
- Part B: hand-traced 5 transition cases through the new notify-trigger
  logic against the actual code (see Part B section above).
- Part C (fallback image): confirmed via grep that no remaining hardcoded
  references to the broken photo ID exist anywhere in the repo after the
  fix.
- Part C (layout): explicitly NOT verified. See above.

No live server, database, or browser was available in this environment
(no `VITE_CLERK_PUBLISHABLE_KEY`, no DB connection, no network access to
run a dev server against real data). Everything above marked "traced" or
"hand-traced" was done by reading the actual code paths that would execute
in production, not by assumption — but it is not a substitute for
integration testing, and that gap is real, not just a formality.

---

## Open items summary (all flagged above, collected here for visibility)

1. **Layout bug not fixed** — needs a human with render access. Highest
   priority open item from this phase.
2. **Pre-order notify over-scoping**: `preOrdersTable` has no
   `sellerListingVariantId` column, so the new (correct) trigger can still
   over-notify across sellers on the same product. Needs a schema change;
   out of scope this phase.
3. **`DashboardTab.tsx`'s paginated-array-vs-server-total stat
   inconsistency** — pre-existing, unrelated to this phase's bugs, not
   touched.
4. **`productsTable.productStatus` column still exists in the DB schema**
   — no longer written or meaningfully read by the frontend, but not
   dropped. A future phase should decide whether to migrate/remove it
   properly (data migration question, not a code question).
