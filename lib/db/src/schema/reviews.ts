import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { productsTable } from "./products";
import { sellersTable } from "./sellers";
import { sellerListingsTable } from "./sellerListings";

/**
 * Reviews rate a specific seller's listing of a variety, not the variety
 * itself -- two sellers on the same product (e.g. Langra Mango) can and do
 * carry different ratings (plan doc §3b). productId is kept for
 * variety-level aggregation/backward compat with pre-marketplace rows;
 * sellerId + sellerListingId are the source of truth going forward.
 *
 * A review must attach to a sellerListingId the buyer actually purchased
 * via a completed orders row -- enforce that at the API layer, not here.
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
    sellerListingId: integer("seller_listing_id").references(
      () => sellerListingsTable.id,
      { onDelete: "cascade" },
    ),
    userId: text("user_id").notNull(),
    userName: text("user_name").notNull(),
    rating: integer("rating").notNull(),
    comment: text("comment").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // One review per seller listing per user, not per product per user --
    // a buyer can separately review each seller they've bought this
    // variety from. Pre-marketplace rows (sellerListingId null) are not
    // covered by this constraint; a nullable-column unique index allows
    // multiple nulls per productId/userId, which is intentional here.
    unique("reviews_seller_listing_user_unique").on(table.sellerListingId, table.userId),
  ],
);

export const insertReviewSchema = createInsertSchema(reviewsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertReview = z.infer<typeof insertReviewSchema>;
export type Review = typeof reviewsTable.$inferSelect;

