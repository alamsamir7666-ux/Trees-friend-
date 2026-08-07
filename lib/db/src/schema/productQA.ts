import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { productsTable } from "./products";
import { sellerListingsTable } from "./sellerListings";
import { sellersTable } from "./sellers";

/**
 * Product-level Q&A (sellerListingId/sellerId both null) is answered by
 * admins only -- unchanged behavior. Seller-listing Q&A (sellerListingId
 * set) is a separate, parallel set of rows scoped to one seller's listing
 * -- answered by that listing's OWNING seller (sellerId, denormalized from
 * seller_listings.seller_id for the same reason reviews.ts denormalizes it:
 * "which seller can answer this" is checked on every read of the seller's
 * own Q&A queue, and forcing that through a join to seller_listings for
 * every check would touch more call sites for no benefit) or an admin.
 *
 * Scoped to the LISTING, not a specific variant, matching reviewsTable's
 * existing sellerListingId precedent for aggregation-level fields -- a
 * question like "does this ship with fertilizer?" applies to the seller's
 * listing as a whole, not to one variant of it.
 */
export const productQATable = pgTable("product_qa", {
  id: serial("id").primaryKey(),
  // FIX: FK added — previously no reference, so orphan Q&A rows could
  // exist for deleted products. Cascade on delete: if a product is
  // removed, its Q&A goes with it.
  productId: integer("product_id")
    .notNull()
    .references(() => productsTable.id, { onDelete: "cascade" }),
  // Null for product-level Q&A (unchanged, admin-answered). Set for
  // seller-listing Q&A (seller-answered) -- see table doc comment above.
  sellerListingId: integer("seller_listing_id").references(
    () => sellerListingsTable.id,
    { onDelete: "cascade" },
  ),
  sellerId: integer("seller_id").references(() => sellersTable.id, {
    onDelete: "cascade",
  }),
  userId: text("user_id").notNull(),
  userName: text("user_name").notNull(),
  question: text("question").notNull(),
  answer: text("answer"),
  answeredAt: timestamp("answered_at"),
  isPublished: boolean("is_published").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
