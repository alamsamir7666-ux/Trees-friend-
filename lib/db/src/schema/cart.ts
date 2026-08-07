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
import { sellerListingVariantsTable } from "./sellerListingVariants";

/**
 * A cart line is EITHER an admin-direct variant purchase (variantId set,
 * sellerListingId/sellerListingVariantId null) OR a marketplace line
 * (sellerListingId + sellerListingVariantId set, variantId null) -- never
 * both, never neither. These are two separate, coexisting buying paths
 * (plan doc §2, §6): the admin-owned productVariants line stays exactly as
 * it worked before the marketplace existed; the seller_listings line is new
 * in phase 3. Enforced at the API layer (routes/cart.ts), not by a DB
 * constraint, to keep error messages readable -- see that file for the
 * actual XOR check.
 *
 * productId is kept NOT NULL and always populated even for seller-listing
 * lines (denormalized from seller_listings.productId at insert time) so
 * existing joins/grouping/"view product" links that only know about
 * productId keep working unchanged for both line types.
 *
 * Phase 2 (variant-per-listing split): one seller_listings row can now hold
 * MULTIPLE seller_listing_variants rows (e.g. "Sapling" and "Grafted" from
 * the same seller listing of the same product), and a buyer must be able to
 * add both to their cart as two separate lines. sellerListingVariantId is
 * the new column that actually addresses a specific purchasable variant;
 * sellerListingId is KEPT alongside it (denormalized from
 * seller_listing_variants.sellerListingId at insert time), for the same
 * reason productId is denormalized above: most existing read paths
 * (buildCart's per-seller grouping/join, orders.ts's seller-group
 * resolution, admin "cart contents by seller" views) key off
 * sellerListingId directly, and forcing every one of those through an extra
 * join on the variant table to recover the listing/seller would touch far
 * more call sites for no real benefit. sellerListingId is therefore
 * READ-only convenience data here, not the source of truth for
 * purchasability/pricing -- sellerListingVariantId is.
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
    // Denormalized from the variant's own sellerListingId (see doc comment
    // above) -- convenience/grouping data, not the purchasability source of
    // truth.
    sellerListingId: integer("seller_listing_id").references(
      () => sellerListingsTable.id,
      { onDelete: "cascade" },
    ),
    // Nullable: only set for marketplace (seller-listing) cart lines.
    // Mutually exclusive with variantId. This is the actual purchasable
    // unit for a marketplace line as of Phase 2 -- price/stock/
    // deliveryCharge/isPreOrder all live on seller_listing_variants now, not
    // on seller_listings itself. See table doc comment above.
    sellerListingVariantId: integer("seller_listing_variant_id").references(
      () => sellerListingVariantsTable.id,
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
    // Phase 2: uniqueness for the marketplace path moves from
    // (user, sellerListingId) to (user, sellerListingVariantId), so a buyer
    // CAN have two lines against the same listing as long as they're
    // different variants (e.g. Sapling AND Grafted from the same seller) --
    // that's the whole point of the variant split. A single seller listing
    // is no longer the addressable purchase unit; its variant is.
    unique("cart_user_seller_listing_variant_unique").on(
      table.userId,
      table.sellerListingVariantId,
    ),
  ],
);

export type CartItem = typeof cartItemsTable.$inferSelect;
