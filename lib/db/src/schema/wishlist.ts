import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { productsTable } from "./products";
import { sellerListingVariantsTable } from "./sellerListingVariants";

export const wishlistTable = pgTable(
  "wishlist",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    productId: integer("product_id")
      .notNull()
      .references(() => productsTable.id, { onDelete: "cascade" }),
    // Set only for a "seller listing" wishlist row (the person hearted a
    // specific seller's variant, e.g. from SellerListingDetailPage) --
    // null for a plain "product variety" wishlist row (hearted from
    // ProductDetailPage/ProductsPage, no seller chosen yet). productId is
    // still always set in both cases (a seller listing always belongs to
    // one product), so existing productId-only queries/joins keep working
    // unchanged; this column is purely additive and used to split the two
    // kinds apart on the Wishlist page.
    //
    // Cascades on delete like reviews/cart_items' equivalent column, since
    // a wishlist row for a listing that no longer exists is meaningless.
    // Nullable so old rows and product-only wishlist rows are unaffected.
    sellerListingVariantId: integer("seller_listing_variant_id")
      .references(() => sellerListingVariantsTable.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (table) => [
    // FIX: these partial unique indexes previously existed ONLY in
    // migration.sql, not in the Drizzle schema. A plain
    // unique(userId, productId) would also cover seller-listing rows
    // (they carry productId too) and wrongly block wishlisting a product
    // AND a seller listing of that same product, or two different
    // sellers' listings of that same product, as separate rows. What's
    // actually needed is two PARTIAL unique indexes — one scoped to
    // WHERE seller_listing_variant_id IS NULL (product rows), one
    // scoped to WHERE seller_listing_variant_id IS NOT NULL (listing
    // rows). Now declared inline via `sql` so the schema is the single
    // source of truth (drizzle-orm doesn't have a .where() on unique()
    // yet, so we use a raw partial index with a WHERE clause).
    uniqueIndex("wishlist_user_product_unique")
      .on(table.userId, table.productId)
      .where(sql`seller_listing_variant_id IS NULL`),
    uniqueIndex("wishlist_user_seller_listing_variant_unique")
      .on(table.userId, table.sellerListingVariantId)
      .where(sql`seller_listing_variant_id IS NOT NULL`),
    // Index for "user's wishlist" queries (most common read pattern).
    index("wishlist_user_id_idx").on(table.userId),
  ],
);

export type WishlistItem = typeof wishlistTable.$inferSelect;
