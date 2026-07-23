# Phase 3a Handoff: API Contract Sync + Data-Entry Forms

This covers Part 0 (OpenAPI spec sync), Part 1 (admin product form —
variant creation removed), and Part 2 (seller listing form — rebuilt
around nested variants).

**Verification status:** `pnpm run typecheck` passes clean (exit 0) across
all workspace packages (`api-server`, `tree-friend`, `mockup-sandbox`,
`scripts`). `artifacts/tree-friend` builds clean with `vite build`. No
live database was available in this environment, so nothing here was
exercised against real data; typecheck/build plus a field-by-field manual
trace against the real route code (§4 below) is the extent of
verification possible, same caveat as Phase 2's handoff.

---

## 1. Part 0 — OpenAPI spec sync

Read the real source of truth first, per the prompt's instruction not to
guess from its summary: `artifacts/api-server/src/routes/sellerListings.ts`
(`toListing()`, `toVariant()`, `toListingWithVariants()`, and the POST/PUT
handlers' own doc comments describing the request shape) and
`artifacts/api-server/src/routes/products.ts` (`toProduct()`,
`MarketplaceStats`, and the POST/PUT `/products` handlers).

### 1.1 `Product` schema

Added `listingMinPrice: number | null`, `listingMaxPrice: number | null`,
`listingCount: integer`, and put **all three** in `required`. This was a
direct check against `toProduct()`, not a guess: the function always
spreads `marketplaceStats.listingMinPrice` / `.listingMaxPrice` /
`.listingCount` into the response object, defaulting to
`EMPTY_MARKETPLACE_STATS` (`{ listingMinPrice: null, listingMaxPrice:
null, listingCount: 0 }`) when no stats are passed — so all three keys are
**always present**, even when the price fields are `null`. Presence ≠
non-null, so `required` + nullable `type` on the two price fields is
correct and matches the codebase's existing convention (e.g.
`startingPrice` is already `required` and nullable the same way).

Left `startingPrice`/`totalStock`/`inStock`/`variants` untouched — they
still exist in the real response (now permanently null/0/false/[] for
every product created after Phase 2, per PHASE2_HANDOFF.md §5), and
removing them from the spec would break any other consumer still reading
them.

### 1.2 `SellerListing` → listing-level only + nested `variants`

Stripped `form`/`rootType`/`potSize`/`age`/`height`/`condition`/`price`/
`discountPrice`/`stock`/`availableQuantity` off `SellerListing` (the old
flat shape) and added `variants: SellerListingVariant[]`. New
`SellerListingVariant` schema holds exactly what `toVariant()` returns,
field-for-field, including the two Phase-2-new fields the prompt called
out to double check: `deliveryCharge: number` (required, not nullable —
`toVariant()` always does `Number(v.deliveryCharge)`, no null branch) and
`isPreOrder: boolean` (required).

### 1.3 Create/Update body shapes

Added `SellerListingVariantCreateInput` (price required, no `id` field —
every entry in a create request is necessarily new) and
`SellerListingVariantUpdateInput` (`id` optional; presence of `id`
means "update this existing variant", absence means "create a new one" —
matches the PUT handler's doc comment exactly). `CreateSellerListingBody`
now requires `variants` (min 1 item) instead of the old flat `price`.
`UpdateSellerListingBody` gained `variants` (optional array) and
`deletedVariantIds` (optional integer array), matching the PUT handler's
documented "update some, create some, delete some in one request" shape.

### 1.4 `SellerListingCard` / `AdminSellerListing`

Checked both per the prompt's instruction to verify, not assume, they
still make sense post-nesting:
- `SellerListingCard.listing` is a `$ref` to `SellerListing`, so it picks
  up the nested shape automatically — confirmed against the route
  (`GET /products/:productId/seller-listings`) which does call
  `toListingWithVariants()` under the hood. No change needed.
- `AdminSellerListing`'s `allOf` adds `sellerBusinessName`/`productName`
  on top of `SellerListing` — confirmed against `GET
  /admin/seller-listings`, which spreads exactly
  `{ ...toListingWithVariants(listing, variants), sellerBusinessName,
  productName }`. Still correct as-is, no change needed.

### 1.5 Extra bug found and fixed: `CreateProductBody.variants`

Not in the prompt's explicit Part 0 list, but the prompt told me to check
whether the generated `useCreateProduct`/`useUpdateProduct` types still
expected `variants` after the fix, and to treat that as "a Part 0 gap, go
fix the spec" rather than working around it in the component. They did:
`CreateProductBody` had `variants` in its `required` array even though
`POST /products` (confirmed by reading the route) destructures the body
without ever reading `variants`, and its own doc comment says a
`variants` field, if present, is **silently ignored**, not rejected.
Requiring a field the route never reads was simply wrong. Fixed by making
`variants` optional on both `CreateProductBody` and `UpdateProductBody`,
with a `description` annotating it as deprecated/ignored so a future
reader of the spec doesn't reintroduce it as real. Confirmed
`PUT /products/:id` has the identical "silently ignored" doc comment, so
applied the same fix there too, even though it was already optional
(annotation only).

### 1.6 Codegen output

```
> @workspace/api-spec@0.0.0 codegen /home/claude/work/Trees-friend--main/lib/api-spec
> orval --config ./orval.config.ts && echo 'export * from "./generated/api";' > ../api-zod/src/index.ts && pnpm -w run typecheck:libs

🍻 orval v8.12.1 - A swagger client generator for typescript
api-client-react Cleaning output folder
🎉 api-client-react - Your OpenAPI spec has been converted into ready to use orval!
zod Cleaning output folder
🎉 zod - Your OpenAPI spec has been converted into ready to use orval!

> workspace@0.0.0 typecheck:libs /home/claude/work/Trees-friend--main
> tsc --build

(clean exit, no errors)
```

Confirmed via grep that the regenerated types now match reality:
- `lib/api-client-react/src/generated/api.schemas.ts` has
  `listingMinPrice: number | null;` on `Product`.
- `SellerListingVariant` interface exists with all 13 fields
  (id, sellerListingId, form, rootType, potSize, age, height, condition,
  price, discountPrice, stock, availableQuantity, deliveryCharge,
  isPreOrder, createdAt, updatedAt).
- `SellerListing` interface has `variants: SellerListingVariant[]` and no
  flat price/stock/form fields.
- `CreateProductBody.variants` is now `variants?: ProductVariantInput[]`
  (optional, was required).

---

## 2. Part 1 — Admin `ProductModal.tsx`: variant creation removed

- Removed the `variants` state, `validateVariantsLocally()`, the
  `<VariantEditor>` render, the `variantError` display, and the
  `variants: [...]` array from the submit payload. Admin now
  creates/edits only the product/variety fields (name, description,
  category, care info, images, video, homepage tag, `productStatus`) —
  confirmed the payload sent to `useCreateProduct`/`useUpdateProduct` no
  longer has a `variants` key at all.
- `productStatus` (in_stock/pre_order/out_of_stock) was left completely
  untouched, per the prompt — it's the admin-set field on the product
  itself, unrelated to variant-level `isPreOrder`.
- Grepped the whole frontend for `VariantEditor` before deciding what to
  do with the file: it was only referenced by its own definition file and
  by `ProductModal.tsx`. Once removed from `ProductModal.tsx`, nothing
  else imports it, so **deleted**
  `artifacts/tree-friend/src/components/admin/VariantEditor.tsx` rather
  than leaving dead code, per the prompt's instruction.

---

## 3. Part 2 — `SellerListingForm.tsx`: rebuilt around nested variants

Read the full ~500-line original first. Rebuilt so the form represents
ONE listing containing MULTIPLE variant blocks.

### 3.1 Shape decisions

**Local state split into two pieces**, mirroring the schema split itself:
- `Draft` — listing-level fields only (variety picker, delivery time,
  warranty, return policy, payment method + its bKash warning text,
  description, offer text, certification, tags, video URL, images).
  `draftFromListing()`/`EMPTY_DRAFT` updated to match.
- `variants: VariantDraft[]` — one entry per repeatable variant block
  (form, condition, the four `ControlledAttributeSelect` fields, price,
  discountPrice, stock, the new `deliveryCharge` field, the new
  `isPreOrder` toggle).

**Representing "new" vs. "existing" vs. "deleted" variants** — the part
of Part 2 with the most design freedom, so documenting the reasoning:

- Each `VariantDraft` carries a **stable local `key`** (`existing-{id}`
  for a variant loaded from `editing.variants`, or `new-{counter}` for one
  added via "Add another variant" this session). `key` is purely a React
  list-identity value and is **never sent to the API** — it exists so
  `removeVariant`/`setVariantField` can target the right block without
  relying on array index, which would break as blocks are added/removed.
- Each `VariantDraft` also optionally carries the **real** variant `id`
  (only present if it came from `editing.variants`). At submit time, `id
  != null` → include `id` in the request object (an update to that
  existing variant); `id == null` → omit it (a new variant). This is a
  direct mirror of the PUT handler's own documented convention ("an item
  WITH an `id` updates... an item with NO `id` creates"), not an
  independent design choice — matching the backend's convention exactly
  was the goal, since anything else would need a translation layer.
- **Deletions** are tracked in a *separate* `deletedVariantIds: number[]`
  state, not just inferred by "whatever's missing from `variants`". This
  matters because of how the PUT handler actually behaves: it only
  touches variants explicitly named in `variants` (update/create) or
  `deletedVariantIds` (delete) — a variant that exists on the server but
  is simply absent from both arrays is **left alone**, not deleted. So
  `removeVariant()` does two things: drops the block from local `variants`
  state (so it stops rendering), and — only if the removed block had a
  real `id` — appends that id to `deletedVariantIds` so the next PUT
  actually tells the server to delete it. A locally-added, not-yet-saved
  block (`id == null`) being removed just vanishes from state with no
  further bookkeeping, since the server never knew about it.

### 3.2 Validation

Added `validateVariantsLocally()` mirroring the backend's own two rules
(`validateVariantShape()` + the "≥1 variant" guard): every block needs a
valid `price > 0`; if `discountPrice` is set it must be `< price`; and the
`variants` array must have at least one entry. Shown as an inline error
(`variantsError`) rather than only relying on the API's 400, per the
prompt.

### 3.3 What was left alone

`ControlledAttributeSelect` and `ProductPicker` — reused completely
unchanged, just called once per variant block now instead of once for the
whole form (for `ControlledAttributeSelect`). `handleImageUpload` /
`removeImage` (listing-level, unchanged). Visual conventions (shadcn
`Button`/`Input`/`Label`/`Textarea`, existing Tailwind classes) — this was
a data-shape restructure, not a redesign, so the variant-block card
styling (`border rounded-xl p-4 bg-muted/10`) intentionally reuses the
same visual language as the rest of the form rather than introducing
something new.

### 3.4 Edit-mode initial state

`editing.variants` (the nested array Part 0's codegen fix now actually
returns) is mapped directly into `VariantDraft[]` via
`variantDraftFromVariant()` — no flat-field reads on `editing` itself
remain anywhere in the file (confirmed via grep, see §5 below).

---

## 4. Manual trace (prompt's verification step 5)

Scenario: seller submits a **new** listing with 2 variants — Sapling
৳550/stock 10, Grafted ৳900/stock 3, pre-order off for both, payment
method COD, no controlled attributes set.

Traced the exact request body the form's `handleSubmit` (create branch)
builds against `POST /seller-listings`'s actual handler in
`sellerListings.ts`, line by line: `productId`/`variants` presence
checks, `validateVariantShape()` per variant, `paymentMethod` enum +
verified-config gate (skipped here since `cod`), `images`/`tags` array
checks, product lookup, `validateControlledAttributes()` per variant
(short-circuits to no-op since no controlled fields were set), the
`sellerListingsTable` insert, and the `sellerListingVariantsTable` insert
(`.map` over `variants` with the same field names/coercions the form
already sends numeric values for). Every field name and nesting level
matched exactly — no mismatches found. Full trace kept for reference; the
short version is: the form's payload keys are a 1:1 match against what
the route destructures, because Part 0's schema was written directly from
the route's own doc comments rather than guessed independently.

---

## 5. Fallout fixes (expected, prompt pre-approved these as in-scope)

Per the prompt: "If fixing Part 0's types breaks their typecheck because
they read old flat fields, that's expected and IN scope to fix
minimally... don't redesign their layout." Root typecheck after Part 0 +
Part 1 + Part 2 surfaced exactly this in three DISPLAY-only files (no
create/edit logic in any of them):

- **`components/admin/tabs/SellerListingsTab.tsx`** — was reading
  `l.discountPrice ?? l.price` / `l.stock` directly off the (now-nested)
  listing. Added a small `variantSummary()` helper that shows a price
  range (`Tk{min}` or `Tk{min}–{max}` across variants, using each
  variant's discount price when set) + total stock + variant count.
  Layout/structure of the card otherwise untouched.
- **`components/seller/SellerListingsTab.tsx`** — same issue, same fix
  (`variantPriceStockSummary()`), same "range + total, don't redesign"
  approach.
- **`components/ui/SellerListingsSection.tsx`** (buyer-facing seller
  cards) — was reading `card.listing.price`/`.discountPrice`/`.stock`
  directly. This one needed one extra judgment call: which variant's
  price should a single-price buyer card show? Mirrored the **exact same
  rule the backend already uses** for `sort=price_asc`
  (PHASE2_HANDOFF.md §7 — "cheapest qualifying (in-stock) variant wins,
  sold-out variants don't get to advertise a price nobody can pay"):
  picks the cheapest variant with `availableQuantity > 0`, falling back
  to the cheapest variant overall only if every variant on that card
  happens to be sold out (so the card still renders a price instead of
  crashing on an empty array). `outOfStock` now means "zero qualifying
  variants" instead of the old single `stock <= 0` check; stock display
  sums across all variants. Layout otherwise untouched.

No other frontend files needed changes for this phase's type sync
(confirmed via `grep -rn` sweep across `artifacts/tree-friend/src` for any
remaining `.listing.price`/`.listing.stock`/`.listing.discountPrice`/
`.listing.form`/`.listing.condition`/`.listing.availableQuantity` reads —
none found after the fixes above).

---

## 6. Spec/route mismatch found, NOT silently patched (flagged per prompt)

`components/ui/SellerListingsSection.tsx`'s add-to-cart call
(`useAddToCart` → `POST /cart`) sends `{ productId, sellerListingId,
quantity }` with no variant id. This did **not** produce a compile error
— `AddToCartBody.variantId`/`sellerListingId` are both optional
(`number | null`), so the existing call still typechecks — but per
PHASE2_HANDOFF.md §1 (Decision 1), `cartItemsTable` uniqueness moved to
`sellerListingVariantId` specifically so a buyer can hold two different
variants from the same listing in their cart simultaneously. Add-to-cart
not carrying a variant id means every marketplace add-to-cart from this
component currently ends up pointing at *a* listing with no way to
disambiguate which variant was intended once a listing has more than one.

This is a **pre-existing gap**, not something Part 0's spec fix caused —
`AddToCartBody` already had `variantId`/`sellerListingId` as separate
optional fields before this phase, and `cart.ts` is explicitly listed as
"already done in Phase 2" / out of scope for this phase's backend work.
Not silently patched, per the prompt's instruction ("if so, report it
precisely, don't silently patch the route") — flagging here for whoever
picks up the buyer-facing seller-card variant-selection UI (Phase 3b:
`ProductDetailPage.tsx` rebuild, new listing detail page) to wire a real
variant picker into this add-to-cart call once that UI exists.

---

## 7. Verification output (prompt's steps 1–4)

### `pnpm install`
Succeeded (667 packages, some peer-dep/postinstall warnings only, no
errors). Node engine warning (`wanted: 24.x, current: 22.22.2`) is
environmental, not caused by this phase — same warning Phase 2 would have
hit.

### `pnpm run codegen` (inside `lib/api-spec`)
See §1.6 above for full output — succeeded, `typecheck:libs` clean.

### `pnpm run typecheck` (root)

```
> workspace@0.0.0 typecheck
> pnpm run typecheck:libs && pnpm -r --filter "./artifacts/**" --filter "./scripts" --if-present run typecheck

> workspace@0.0.0 typecheck:libs
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

Clean, 0 errors, all 4 workspace packages. (Note: `lib/db`'s composite
`dist/` output wasn't present at the very start of this session —
`tsc --build --force` at the root was needed once to produce it before
`api-server`'s per-package `tsc --noEmit` could resolve `@workspace/db`'s
declaration files; this is a pre-existing build-ordering property of the
TS project-references setup, not something this phase's changes caused,
and `pnpm run typecheck`'s own `typecheck:libs` step handles it on a
normal from-scratch run.)

### `pnpm run build` for `artifacts/tree-friend`

```
> @workspace/tree-friend@0.0.0 build
> vite build --config vite.config.ts

vite v7.3.3 building client environment for production...
✓ 2100 modules transformed.
✓ built in 9.49s
```

Clean build, all chunks emitted (`dist/public/...`). The four
"Error when using sourcemap for reporting an error" lines for
`select.tsx`/`label.tsx`/`dropdown-menu.tsx`/`sheet.tsx` are Vite
sourcemap-resolution noise, not build errors — build still succeeds with
exit 0 and full asset output, same as they would on an unrelated change.

### Manual trace
See §4 above.

---

## 8. Files changed

| File | What changed |
|---|---|
| `lib/api-spec/openapi.yaml` | `Product`: added listingMinPrice/Max/Count. `SellerListing`: stripped to listing-level + nested `variants`. Added `SellerListingVariant`, `SellerListingVariantCreateInput`, `SellerListingVariantUpdateInput`. `CreateSellerListingBody`/`UpdateSellerListingBody`: flat → variants array + deletedVariantIds. `CreateProductBody`/`UpdateProductBody`: `variants` made optional + annotated deprecated/ignored (bug found beyond the prompt's explicit list). |
| `artifacts/tree-friend/src/components/admin/modals/ProductModal.tsx` | Removed all variant state/validation/payload/UI. |
| `artifacts/tree-friend/src/components/admin/VariantEditor.tsx` | **Deleted** — no longer referenced anywhere. |
| `artifacts/tree-friend/src/components/seller/SellerListingForm.tsx` | Full rewrite: listing-level `Draft` + repeatable `VariantDraft[]` blocks, new/existing/deleted variant tracking, `deliveryCharge`/`isPreOrder` fields added, local `validateVariantsLocally()`. |
| `artifacts/tree-friend/src/components/admin/tabs/SellerListingsTab.tsx` | Minimal compile fix: price/stock display reads nested `variants` via new `variantSummary()` helper. |
| `artifacts/tree-friend/src/components/seller/SellerListingsTab.tsx` | Same minimal fix, `variantPriceStockSummary()`. |
| `artifacts/tree-friend/src/components/ui/SellerListingsSection.tsx` | Same minimal fix; picks cheapest-qualifying-variant price per card, mirroring the backend's own sort=price_asc rule. |

## 9. Not done / flagged for later (out of scope this phase)

- §6 above: buyer-facing add-to-cart doesn't send a variant id yet — no
  UI exists to pick one until Phase 3b's product/listing detail pages are
  built.
- Everything under "Do NOT touch this phase" in the prompt was left
  alone: `ProductDetailPage.tsx`, any listing-detail page, `ProductCard.tsx`,
  `ProductsPage.tsx` sort, `ProductComparison.tsx`, `SearchAutocomplete.tsx`,
  `BlogProductCarousel.tsx`, `WishlistPage.tsx`, flash-sale UI, and all
  backend routes.
