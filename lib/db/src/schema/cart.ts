import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { productsTable } from "./products";
import { productVariantsTable } from "./productVariants";
import { sellerListingsTable } from "./sellerListings";

/**
 * A cart line is EITHER an admin-direct variant purchase (variantId set,
 * sellerListingId null) OR a marketplace seller's listing (sellerListingId
 * set, variantId null) -- never both, never neither. These are two
 * separate, coexisting buying paths (plan doc §2, §6): the admin-owned
 * productVariants line stays exactly as it worked before the marketplace
 * existed; the seller_listings line is new in phase 3. Enforced at the API
 * layer (routes/cart.ts), not by a DB constraint, to keep error messages
 * readable -- see that file for the actual XOR check.
 *
 * productId is kept NOT NULL and always populated even for seller-listing
 * lines (denormalized from seller_listings.productId at insert time) so
 * existing joins/grouping/"view product" links that only know about
 * productId keep working unchanged for both line types.
 */
export const cartItemsTable = pgTable(
  "cart_items",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    productId: integer("product_id")
      .notNull()
      .references(() => productsTable.id, { onDelete: "cascade" }),
    // Nullable: not every product has variants, and seller-listing lines
    // never set this. When set, this cart line is for a specific admin
    // variant (size/form/pack) rather than a seller's listing.
    variantId: integer("variant_id").references(() => productVariantsTable.id, {
      onDelete: "cascade",
    }),
    // Nullable: only set for marketplace (seller-listing) cart lines.
    // Mutually exclusive with variantId -- see table doc comment above.
    sellerListingId: integer("seller_listing_id").references(
      () => sellerListingsTable.id,
      { onDelete: "cascade" },
    ),
    quantity: integer("quantity").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // A user can have one cart line per (product, variant) pair. Since
    // variantId is nullable, Postgres treats each NULL as distinct, so
    // this still correctly allows only one no-variant line per product
    // per user, and one line per distinct variant per user.
    unique("cart_user_product_variant_unique").on(
      table.userId,
      table.productId,
      table.variantId,
    ),
    // Mirror constraint for the marketplace path: one cart line per
    // (user, sellerListing). Distinct from the constraint above so a user
    // can't accidentally get two rows for the same seller listing either.
    unique("cart_user_seller_listing_unique").on(
      table.userId,
      table.sellerListingId,
    ),
  ],
);

export type CartItem = typeof cartItemsTable.$inferSelect;
