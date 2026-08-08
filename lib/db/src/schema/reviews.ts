import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  unique,
  index,
  jsonb,
  check,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { type z } from "zod/v4";
import { sql } from "drizzle-orm";
import { productsTable } from "./products";
import { sellersTable } from "./sellers";
import { sellerListingsTable } from "./sellerListings";
import { sellerListingVariantsTable } from "./sellerListingVariants";

/**
 * Reviews rate the specific seller-listing VARIANT a buyer actually
 * purchased, not the listing or the variety as a whole (plan doc §3b,
 * revisited in Phase 2). Two sellers on the same product (e.g. Langra
 * Mango) can and do carry different ratings; as of Phase 2, so can two
 * variants of the SAME seller's listing -- a Sapling and a Grafted tree
 * from the same seller are different purchase/quality experiences (growth
 * stage, handling, survivability), so collapsing their reviews into one
 * per-seller bucket would lose real signal. productId is kept for
 * variety-level aggregation/backward compat with pre-marketplace rows;
 * sellerId + sellerListingId + sellerListingVariantId are the source of
 * truth going forward.
 *
 * sellerListingId is kept alongside sellerListingVariantId (denormalized
 * from the variant's own sellerListingId), same convention/rationale as
 * cartItemsTable (see schema/cart.ts doc comment): most read paths here
 * (buyer-facing seller-card rating aggregation in
 * routes/sellerListings.ts) group by sellerListingId directly, and forcing
 * that through the variant table for every query would touch more call
 * sites for no benefit. sellerListingId is read/aggregation convenience
 * data; sellerListingVariantId is what the uniqueness constraint and
 * "did this buyer actually purchase this" check are keyed on.
 *
 * A review must attach to a sellerListingVariantId the buyer actually
 * purchased via a completed orders row -- enforce that at the API layer,
 * not here.
 */
export const reviewsTable = pgTable(
  "reviews",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => productsTable.id, { onDelete: "cascade" }),
    sellerId: integer("seller_id").references(() => sellersTable.id, {
      onDelete: "cascade",
    }),
    // Denormalized from sellerListingVariantsTable.sellerListingId --
    // convenience/aggregation data, not the uniqueness source of truth as
    // of Phase 2. See table doc comment above.
    sellerListingId: integer("seller_listing_id").references(
      () => sellerListingsTable.id,
      { onDelete: "cascade" },
    ),
    // The actual purchased unit being reviewed as of Phase 2. Nullable for
    // the same reason sellerListingId always was: pre-marketplace rows (and
    // admin-direct-variant purchases, which have no seller listing at all)
    // never set this.
    sellerListingVariantId: integer("seller_listing_variant_id").references(
      () => sellerListingVariantsTable.id,
      { onDelete: "cascade" },
    ),
    userId: text("user_id").notNull(),
    userName: text("user_name").notNull(),
    // FIX: CHECK constraint added — rating must be between 1 and 5.
    // Previously accepted any integer (0, -1, 999 all valid).
    rating: integer("rating").notNull(),
    comment: text("comment").notNull(),
    // Up to 4 Cloudinary secure_urls a buyer attached to their review.
    // Column added via migration.sql ("add_review_photos.sql" entry) --
    // this Drizzle declaration was previously missing even though the
    // column existed in the DB and routes/reviews.ts already read/wrote it
    // via `as any` casts (see that file's formatReview/formatSellerListing
    // Review comments). Same jsonb(string[]) convention as
    // productsTable.images/keyBenefits/bestFor/careTips.
    photos: jsonb("photos").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // One review per seller-listing VARIANT per user, not per listing per
    // user -- a buyer can separately review each variant of a seller's
    // listing they've purchased (e.g. review the Sapling AND, separately,
    // the Grafted tree from the same seller). Pre-marketplace / admin-direct
    // rows (sellerListingVariantId null) are not covered by this
    // constraint; a nullable-column unique index allows multiple nulls per
    // productId/userId, which is intentional here.
    unique("reviews_seller_listing_variant_user_unique").on(
      table.sellerListingVariantId,
      table.userId,
    ),
    // FIX: CHECK constraint — rating must be 1-5 (industry standard for
    // 5-star review systems). Prevents 0, negative, or >5 values from
    // being inserted (defense-in-depth at the DB layer, in addition to
    // API-layer validation).
    check("reviews_rating_check", sql`${table.rating} >= 1 AND ${table.rating} <= 5`),
    // P0-2: index on productId — supports product-detail review aggregation
    // (routes/products.ts:162, fetchReviewStats) which groups reviews by
    // product. Without this index, every product page seq-scans reviews.
    index("reviews_product_id_idx").on(table.productId),
    // P0-2: index on sellerListingId — supports seller-listing-detail
    // review aggregation (routes/sellerListings.ts:292) which groups
    // reviews by listing. Denormalized column (see table doc comment
    // above) intentionally indexed to serve this aggregation path.
    index("reviews_seller_listing_id_idx").on(table.sellerListingId),
  ],
);

export const insertReviewSchema = createInsertSchema(reviewsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertReview = z.infer<typeof insertReviewSchema>;
export type Review = typeof reviewsTable.$inferSelect;

