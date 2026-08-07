# Tree Friend — Cloudinary cleanup + review photos fix

13 files changed. Extract this tarball into your repo root (overwrites these
exact files, nothing else) and typecheck was verified clean via
`pnpm run typecheck` before packaging.

## New file
- `artifacts/api-server/src/lib/cloudinary.ts` — shared helper: derives Cloudinary
  public_id from a stored secure_url and deletes assets (image/video/raw) by URL.

## Cloudinary cleanup on delete/edit (previously leaked storage)
- `artifacts/api-server/src/routes/products.ts`
- `artifacts/api-server/src/routes/sellerListings.ts`
- `artifacts/api-server/src/routes/sellers.ts` (nursery images + logo)
- `artifacts/api-server/src/routes/categories.ts` (icon/subcategory image + cascade delete fix: deleting a parent category now reassigns child products to an "Uncategorized" bucket instead of orphaning them)
- `artifacts/api-server/src/routes/conversations.ts` (chat image/video/document attachments, within the existing 15-min delete window)

## Review photos feature (was partially built, never finished)
- `lib/db/src/schema/reviews.ts` — added `photos` jsonb column to Drizzle schema
- `artifacts/api-server/src/routes/reviews.ts` — removed `as any` casts, wired
  photos through insert/format, added Cloudinary cleanup on review delete
- `lib/api-spec/openapi.yaml` — added `photos` field to Review/SellerListingReview
- `lib/api-zod/src/generated/api.ts` + `lib/api-client-react/src/generated/api.schemas.ts`
  — regenerated via `orval` to include `photos`
- `artifacts/tree-friend/src/components/ui/PhotoReviewForm.tsx` — fixed missing
  API base URL prefix and missing Clerk bearer-token auth
- `artifacts/tree-friend/src/pages/ProductDetailPage.tsx` — wired PhotoReviewForm
  in (replacing the old text-only form), added photo thumbnails to review cards

## Still open (flagged, not fixed — for your next session)
- `GET /admin/reviews` doesn't select `photos`, so the admin dashboard won't
  show review photos yet.

## DB migration note
The `photos` column SQL already existed in `lib/db/src/schema/migration.sql`
(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS photos jsonb NOT NULL DEFAULT '[]'::jsonb;`).
Make sure that's actually been run against your live database — it's
idempotent (`IF NOT EXISTS`), safe to re-run.
