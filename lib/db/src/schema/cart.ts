import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  numeric,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { productsTable } from "./products";
import { productVariantsTable } from "./productVariants";
import { sellerListingsTable } from "./sellerListings";
import { sellerListingVariantsTable } from "./sellerListingVariants";
import { usersTable } from "./users";

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
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.clerkId, { onDelete: "cascade" }),
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
    sellerListingId: integer("seller_listing_id").references(() => sellerListingsTable.id, {
      onDelete: "cascade",
    }),
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
    // Industry-standard cart TTL: abandoned carts expire after 30 days.
    // Refreshed on every insert/update so an actively-edited cart stays
    // alive. A cron job (or ad-hoc DELETE WHERE expires_at < now()) cleans
    // up stale rows. Without this, cart_items rows persist forever —
    // Shopify/Magento/WooCommerce all expire abandoned carts by default.
    expiresAt: timestamp("expires_at").notNull().defaultNow(),
    // Industry-standard price locking: snapshot of the variant's effective
    // price (discountPrice ?? price) at the moment the buyer added the item
    // to their cart. Checkout compares this against the current variant
    // price and surfaces a "price has changed" warning if they differ —
    // so the buyer is never silently charged a different amount than what
    // they saw in the bag. Shopify stores this on the cart line
    // (`cart_line.original_price`); WooCommerce stores it as
    // `woocommerce_cart_contents_price`; Magento stores it on the quote
    // item as `custom_price`. NULL for rows created before this column
    // existed (backfilled to the current price on first update).
    //
    // This is a SNAPSHOT, not the source of truth — the actual charge at
    // checkout always uses the current variant price (after re-validation).
    // The snapshot exists only to detect drift and warn the buyer.
    priceSeenAtAdd: numeric("price_seen_at_add", { precision: 10, scale: 2 }),
  },
  (table) => [
    // A user can have one cart line per (product, variant) pair. Since
    // variantId is nullable, Postgres treats each NULL as distinct, so
    // this still correctly allows only one no-variant line per product
    // per user, and one line per distinct variant per user.
    unique("cart_user_product_variant_unique").on(table.userId, table.productId, table.variantId),
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
    // P0-2: index on userId — every cart read (buildCart in routes/cart.ts:45,
    // 59) filters WHERE user_id = ?. The unique constraints above cover
    // (user, product, variant) and (user, sellerListingVariant) but NOT a
    // plain "all this user's cart lines" lookup — Postgres can't use a
    // composite unique index for a prefix-only scan when NULLs are involved
    // (variantId is nullable, sellerListingVariantId is nullable). A plain
    // index on userId is the right tool for this read pattern.
    index("cart_items_user_id_idx").on(table.userId),
  ],
);

export type CartItem = typeof cartItemsTable.$inferSelect;
