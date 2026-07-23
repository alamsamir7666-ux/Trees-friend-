# Phase 6 Handoff

`pnpm install` + `pnpm run typecheck` run clean from a fresh state after every
change below (4/4 workspace projects: api-server, mockup-sandbox, tree-friend,
scripts -- all "Done", zero errors). Full output pasted at the end.

Part A remains **unresolved and source-only** -- no render access was
available this phase either. Parts B and C are done and verified (typecheck +
hand-traced runtime logic, consistent with this project's established
discipline for this file).

---

## Part A -- Render/verify the seller listing detail page

**Status: still not render-verified. Same blocker as Phase 5.**

Checked first, as instructed: no `.env` file exists anywhere in the repo, no
`VITE_CLERK_PUBLISHABLE_KEY` is set in this environment, there's no live
database connection, and this environment's network is restricted to package
registries (npm/pypi/github) -- no route to a staging URL even if one
existed. `App.tsx` throws at startup without the Clerk key (confirmed by
reading the source, not by trying to run it and failing). No render was
possible. Not fabricating a screenshot or claiming visual confirmation that
doesn't exist -- doing a deeper source-only pass instead, as the prompt
allowed.

### What this pass checked that Phase 5 didn't, all ruled out

- **Tailwind content-glob misconfiguration (the prompt's leading
  hypothesis).** Doesn't apply to this codebase. There is no
  `tailwind.config.js` anywhere in the repo -- this project uses Tailwind v4
  via the `@tailwindcss/vite` plugin with CSS-first configuration
  (`@import "tailwindcss"` in `index.css`, `@theme inline {...}` block).
  Tailwind v4 has no `content` array to misconfigure; that's a v3-only
  concept. Confirmed by reading `vite.config.ts`, `index.css`, and
  `package.json`'s `tailwindcss`/`@tailwindcss/vite` deps directly, not
  assumed from the plugin name.
- **Dynamically-constructed class strings**, in the page itself and every
  shared UI primitive it uses (`skeleton.tsx`, `badge.tsx`, `button.tsx`,
  `PageBreadcrumb.tsx`). Grepped for `` className={` `` in all of them. Found
  exactly one template literal, in the page's own thumbnail-selector button,
  and it only interpolates a ternary between two complete static class names
  (`border-primary` / `border-transparent`) -- both strings are fully present
  in source for Tailwind's JIT scanner to find; this is the standard safe
  pattern, not the failure mode the prompt warned about. The three shared
  primitives all use the `cva`/`cn()` convention (shadcn/ui style) with
  static, literal variant strings -- same reasoning applies.
- **A shared layout wrapper constraining width upstream of this page.**
  Ruled out structurally, not just unchecked: `App.tsx` registers both
  `/products/:productId/listings/:listingId` (this page) and `/products/:id`
  (`ProductDetailPage.tsx`, confirmed-working) as direct children of the same
  `AppLayout` component, with no intervening per-route wrapper. `AppLayout`
  itself is `<div className="min-h-[100dvh] flex flex-col">` -- no width
  constraint of any kind. A shared-wrapper bug that explains "only this page
  breaks" isn't structurally possible given this registration.
- **Route/link mismatch.** Re-confirmed Phase 5's finding rather than
  trusting it as given: grepped the full frontend source for `listings/${`
  and `seller-listings` again. Still exactly one call site constructing this
  URL (`SellerListingsSection.tsx:208`,
  `` `/products/${productId}/listings/${card.listing.id}` ``), and it still
  matches the registered route in `App.tsx` exactly. No stale/alternate link
  anywhere.
- **Top-level container JSX**, diffed again character-by-character against
  `ProductDetailPage.tsx`'s confirmed-working container. Identical structure
  at every level checked: `min-h-screen bg-background` -> `container
  mx-auto px-4 py-8` -> `PageBreadcrumb` -> `grid grid-cols-1 md:grid-cols-2
  gap-12`.
- **The data-fetching hook's shape.** `useGetSellerListing` is confirmed (via
  the generated codegen file, not assumed from its name) to be a standard
  `UseQueryResult<TData, TError>` wrapper -- nothing anomalous in its return
  shape that could produce a rendering difference.

### Conclusion

Every concrete hypothesis the prompt named (Tailwind purge/JIT, missing
content glob, dynamic class construction, a shared wrapper) has now been
checked directly against this codebase and ruled out at the source level --
not "didn't find time to check," actually checked and eliminated. The two
pages being compared (`SellerListingDetailPage.tsx` and
`ProductDetailPage.tsx`) are structurally identical at the source level in
every way source-reading can detect.

If the "broken narrow single column" symptom is still real, its cause is
something source-only inspection in this environment genuinely cannot see:
most plausibly a runtime data-shape issue (some field on the actual
`SellerListingCard` API response arriving in an unexpected shape that affects
render in a way not visible from the component's own TypeScript types), or a
build/deploy-specific artifact not present in this repo snapshot (e.g. a
stale compiled CSS bundle on whatever environment produced the original
screenshots). Both of these require a live render to distinguish from "no
bug at all, screenshots were stale" -- there is no more remaining
source-level lead to chase without one.

**Restating exactly what a human needs to do to close this out**, since it's
now been carried across two phases:

1. Get this app running somewhere with a real `VITE_CLERK_PUBLISHABLE_KEY`
   and a live database (locally, or a staging deploy).
2. Load `/products/:productId/listings/:listingId` for a real
   product/listing pair with at least one public, approved, active seller
   listing.
3. Open devtools, check whether the page reaches the main two-column return
   or falls into the `!card` / `isError` branch (see Part B below -- these
   are now visually distinct, which should make this check itself easier
   than it was in Phase 5).
4. If it reaches the main return but still looks broken, pull the actual
   computed styles on the grid container and compare against
   `ProductDetailPage.tsx`'s live computed styles on a real product page --
   that diff is the concrete next step this phase could not take.

---

## Part B -- Error handling for `useGetSellerListing`

**Status: done, verified by typecheck and by code inspection (not by
render -- no environment to trigger a real network failure in, same
blocker as Part A).**

### What changed

`SellerListingDetailPage.tsx` now destructures `error`, `isError`,
`refetch`, and `isRefetching` from `useGetSellerListing(...)`, not just
`data`/`isLoading`. A new `isError` branch was added, checked *before* the
existing `!card` branch, so a real fetch failure (network error, 500,
listing id malformed at the API level) no longer falls through to "Listing
not found."

The new branch:
- Uses the same `min-h-screen` / `container mx-auto` wrapper the loading,
  not-found, and main-success branches already use post-Phase-5 -- keeping
  all four return paths visually consistent.
- Shows a distinct icon (`AlertTriangle`, red) and copy ("Couldn't load this
  listing... Something went wrong on our end.") instead of "Listing not
  found," so the two states are now visually distinguishable, not just
  logically distinguishable in code.
- Includes a "Try again" button that calls `refetch()`, with a
  `isRefetching`-driven spinner/label swap, plus a secondary "Back to shop"
  link matching the not-found branch's existing fallback action.

Also added a `PackageX` icon to the pre-existing not-found branch (previously
text-only) so the two states read clearly differently at a glance, not just
via different copy.

### Retry pattern: checked for an existing convention first, found none

Before inventing a new retry UI, grepped for one: `TrackOrderPage.tsx` and
`CheckoutPage.tsx` are the only two files in the app that already destructure
`isError` from a query/mutation hook. Neither has a genuine, reusable
"distinct error state + retry" pattern -- `TrackOrderPage.tsx`'s `isError`
branch conflates fetch-error and not-found into one message ("Order not
found. Please check your tracking ID..."), which is the exact same bug this
Part is fixing, just in a different file and out of this phase's scope to
touch. `CheckoutPage.tsx`'s `isError` usage is a mutation-submit error
banner, not a query-fetch error state, and has no retry affordance. Also
grepped the whole app for any existing `refetch()` call site as a working
example to copy -- there is none; `App.tsx`'s one `useGetMe` hook doesn't use
it. So the retry button here is a new, minimal pattern (react-query's own
`refetch`, no new library or convention introduced), not copied from
somewhere -- flagging this plainly rather than implying a pattern was
followed that doesn't actually exist yet in this codebase.

### Verify

Full typecheck: clean (see bottom of this doc). Could not trigger a real
error case and confirm the branch fires instead of the not-found branch
end-to-end, for the same reason Part A couldn't render at all -- no live
network/API/DB in this environment. This is a real gap, not glossed over:
the branch's *logic* (checking `isError` before `!card`, both being
independently reachable states given `card` is `undefined` in both) was
verified by reading the code and the hook's generated type, not by
observing it fire.

---

## Part C -- Pre-order over-notification schema gap

**Status: done, verified by typecheck and by hand-traced transition logic
(see below). Not integration-tested against a live DB -- no DB connection
available in this environment, consistent with every prior phase's
constraint here.**

### What changed

**1. Schema (`lib/db/src/schema/preOrders.ts`):** added
`sellerListingVariantId: integer("seller_listing_variant_id")` to
`preOrdersTable`. Nullable, and deliberately **not** a `references()` foreign
key -- checked this against the table's own existing convention rather than
copying `reviews.ts`'s or `cart.ts`'s FK-with-cascade pattern for their
`sellerListingVariantId` columns. `preOrdersTable.productId` is already a
bare integer, not a live FK, because `pre_orders` rows are historical/
denormalized records (they snapshot `productName`/`productImage` at
creation time, same as an order line item would) rather than rows that
should cascade-delete or break if a seller later edits/deletes the
referenced variant. A pre-order is a customer commitment record; losing it
because a seller deleted a variant would be wrong. Matched that existing
convention for the new column instead of introducing a new one.

**2. Migration (`lib/db/src/schema/migration.sql`):** appended
`ALTER TABLE pre_orders ADD COLUMN IF NOT EXISTS seller_listing_variant_id
INTEGER;` at the end of the file, following the exact convention every prior
phase's migration used in this same file (append-only, `IF NOT EXISTS`,
doc-commented above the statement). No separate migration-tool/generator
exists in this repo (`lib/db/src/schema/migration.sql` is the only migration
artifact) -- confirmed by looking for one before assuming this file was the
right place.

**3. POST `/pre-orders` (`artifacts/api-server/src/routes/preOrders.ts`):**
the route already received `sellerListingVariantId` in the request body (and
already validated it -- rejects with 400 if missing, looks up the variant
row, checks `variant.isPreOrder`) but discarded it before the `insert()`
call. Found that exact line and stopped discarding it: the insert now
includes `sellerListingVariantId: Number(sellerListingVariantId)`.

**4. `notifyPreOrderCustomers` (`preOrders.ts`):** signature extended to
`(productId, productName, sellerListingVariantId?)`. When a variant id is
passed, the query scopes to `productId AND status=pending AND
(sellerListingVariantId = <id> OR sellerListingVariantId IS NULL)` --
precisely matching customers who pre-ordered *that* variant, while still
catching legacy (pre-migration, null) rows under the old, broader
product-wide rule. When no variant id is passed (signature is backward
compatible), behavior is unchanged from before this phase.

**5. Trigger call site (`sellerListings.ts`'s PUT handler):** previously
collapsed every transitioned variant in a single request into one boolean
(`shouldNotifyPreOrderCustomers`) and fired one product-wide notify call.
Replaced with `transitionedVariantIds: number[]`, collecting each variant id
that actually transitions out of pending-pre-order in this request, and
firing one `notifyPreOrderCustomers(product.id, product.name, variantId)`
call per transitioned id -- so a request that transitions two different
variants notifies each variant's pre-order customers separately and
correctly, rather than merging them into one imprecise product-wide blast.

### Verified, not assumed

- **The exact discard point.** Read the POST handler's `insert()` call
  directly rather than trusting the prior phase's description of where the
  field was being dropped -- confirmed it's destructured from `req.body` at
  the top of the handler and simply never referenced again before this
  phase's change.
- **Migration-tool convention.** Checked `lib/db/src/schema/` for a
  generator (Drizzle Kit config, Prisma migrations directory, etc.) before
  hand-writing SQL -- found none; `migration.sql` is genuinely the only
  artifact, confirmed by directory listing, not assumed from the file's
  presence alone.
- **FK/cascade convention choice.** Checked `cart.ts`, `reviews.ts` (which
  both FK-reference `sellerListingVariantsTable` with `onDelete: "cascade"`)
  against `orders.ts` (which stores product/variant identity as plain data,
  no live FK at all, because an order is a historical record) before
  choosing which pattern to follow for `preOrdersTable` -- chose the
  `orders.ts`/existing-`productId` pattern deliberately, not by default.
- **Full typecheck**, clean, from a truly fresh state (`node_modules`
  removed entirely, not just re-run in place) -- see below.

### Hand-traced transition cases (same style as Phase 5's own verification)

1. **New pre-order created post-migration**: `sellerListingVariantId` is
   persisted as a non-null value (POST already 400s if it's missing from the
   body) -- correct.
2. **The specific over-notification case this fix exists to close**: product
   has variant A (customer Y pre-ordered it specifically) and variant B,
   different seller (customer Z pre-ordered it specifically). Seller
   restocks variant A only. Trigger fires
   `notifyPreOrderCustomers(productId, name, A)`. Y matches (their row's
   `sellerListingVariantId = A`) -- notified. Z does **not** match (their
   row's `sellerListingVariantId = B`, neither equal to `A` nor null) -- not
   notified. **Confirmed closed**, as the prompt specifically asked to
   verify.
3. **Backward compatibility for a legacy row**: a pre-order row created
   before this migration has `sellerListingVariantId = NULL`. When any
   variant on its product transitions, it still matches via the `OR
   sellerListingVariantId IS NULL` branch of the query -- still gets
   notified under the old, broader product-wide rule, exactly as intended.
   Confirmed by reading the query logic directly against this specific case,
   not inferred.
4. **Two variants transitioning in the same request**: each transitioned
   variant id gets collected into `transitionedVariantIds` independently
   during the loop, and each gets its own `notifyPreOrderCustomers` call
   after the loop -- a request that fixes two different sellers' variants at
   once notifies each variant's customers correctly rather than merging them
   into one imprecise call.
5. **Variant never in pending-pre-order state**: unchanged from Phase 5 --
   the `before.isPreOrder && before.availableQuantity === 0` guard gates
   entry into `transitionedVariantIds` at all, so ordinary restocks of
   normal (non-pre-order) variants never trigger a notify call.

### Residual imprecision, deliberately accepted, documented in code

A legacy (null-variant) pre-order row can still be notified more than once
if a product has multiple variants that each transition out of
pending-pre-order separately -- once per transitioned variant, since each
now gets its own call. This is a strictly smaller version of the original
gap: new (non-null) rows are now scoped exactly to their specific variant,
and legacy rows are notified at most as often as variants actually
transition, never about an unrelated seller's variant on every unrelated
product-wide stock change the way the pre-Phase-5 trigger worked. Not fixed
this phase -- it's a minor UX nuisance (a legacy customer might get two
WhatsApp messages instead of one, in the specific case of two variants
un-pre-ordering in the same request), not a correctness bug, and closing the
one over-notification case named in this phase's prompt didn't require
touching it. Documented directly in `notifyPreOrderCustomers`'s doc comment
for visibility, not left implicit.

---

## Do NOT touch this phase -- confirmed left alone

- `DashboardTab.tsx`'s paginated-array-vs-server-total stat inconsistency --
  not touched.
- `CONTROLLED_FIELDS` in `SellerListingForm.tsx` / `CategoryAttributeOptionsModal.tsx`
  -- not touched.
- Any other Open Item from `PHASE5_HANDOFF.md` not named in this phase's
  prompt (e.g. `productsTable.productStatus` column still existing in the DB
  schema, unmigrated) -- not touched, still open, not this phase's scope.

No new "also fixed while I was in there" changes were made beyond the three
parts above.

---

## New Open Items found this phase

1. **Part A is still unresolved** -- see the restated action items above.
   This is the highest-priority open item, now carried across three phases
   (5, and the two attempts represented in the uploaded Phase 5 material,
   plus this one).
2. **Residual legacy-row over-notification nuance** in the pre-order fix
   above (a legacy row can be notified once per transitioned variant, not
   just once per request) -- deliberately accepted, documented in code, not
   fixed.
3. **`TrackOrderPage.tsx`'s `isError` branch conflates "order not found"
   with "fetch failed"** -- the same class of bug this phase's Part B fixed
   in `SellerListingDetailPage.tsx`, spotted while checking for an existing
   retry-pattern convention to reuse. Not fixed here -- out of this phase's
   named scope, logged for a future phase to pick up if it's worth doing
   consistently across the app.

---

## Full typecheck output (fresh `node_modules`, post all Part A/B/C changes)

```
$ rm -rf node_modules artifacts/*/node_modules lib/*/node_modules scripts/node_modules

$ pnpm install
 WARN  Unsupported engine: wanted: {"node":"24.x"} (current: {"node":"v22.22.2","pnpm":"9.15.0"})
Scope: all 9 workspace projects
Lockfile is up to date, resolution step is skipped
Packages: +667
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 667, reused 667, downloaded 0, added 667, done

devDependencies:
+ prettier 3.8.3
+ typescript 5.9.3
Done in 5s

$ pnpm run typecheck
 WARN  Unsupported engine: wanted: {"node":"24.x"} (current: {"node":"v22.22.2","pnpm":"9.15.0"})

> workspace@0.0.0 typecheck /home/claude/repo
> pnpm run typecheck:libs && pnpm -r --filter "./artifacts/**" --filter "./scripts" --if-present run typecheck

 WARN  Unsupported engine: wanted: {"node":"24.x"} (current: {"node":"v22.22.2","pnpm":"9.15.0"})

> workspace@0.0.0 typecheck:libs /home/claude/repo
> tsc --build

.                                        |  WARN  Unsupported engine: wanted: {"node":"24.x"} (current: {"node":"v22.22.2","pnpm":"9.15.0"})
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

(Node engine warning is pre-existing sandbox/version mismatch, unrelated to
this phase's changes -- present before any edit was made, same as every
prior phase.)
