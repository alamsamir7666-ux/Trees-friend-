import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sellerListingsTable } from "./sellerListings";

/**
 * One purchasable variant of a seller's listing. A listing is created once
 * per seller per product (sellerListingsTable); this table holds the
 * variant-level facts that differ within that listing -- e.g. "Sapling" at
 * one price/stock and "Grafted" at another, each independently
 * pre-orderable and independently priced. One listing = many variants
 * (industry-standard model, like Amazon/Daraz).
 *
 * height/pot_size/age/root_type are comparison-critical fields and MUST be
 * validated server-side against listingAttributeOptionsTable for the
 * listing's product's category before accepting a write. This file does
 * not enforce that -- it belongs in the API route/service layer, not the
 * schema.
 */
export const sellerListingVariantsTable = pgTable("seller_listing_variants", {
  id: serial("id").primaryKey(),
  sellerListingId: integer("seller_listing_id")
    .notNull()
    .references(() => sellerListingsTable.id, { onDelete: "cascade" }),

  form: text("form"), // "seed" | "sapling" | "grafted" | "potted"

  // Comparison-critical -- must be a controlled value from
  // listingAttributeOptionsTable, enforced at the API layer.
  rootType: text("root_type"),
  potSize: text("pot_size"),
  age: text("age"),
  height: text("height"),

  // Free text -- no standardization needed.
  condition: text("condition"),

  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  discountPrice: numeric("discount_price", { precision: 10, scale: 2 }),
  // stock is a mirrored source-of-truth; availableQuantity is the real
  // purchasability gate checked elsewhere in the codebase (cart.ts,
  // orders.ts check availableQuantity, not stock).
  stock: integer("stock").notNull().default(0),
  availableQuantity: integer("available_quantity").notNull().default(0),

  // Can legitimately differ per variant -- a seed packet and a mature
  // potted tree of the same listing ship very differently.
  deliveryCharge: numeric("delivery_charge", { precision: 10, scale: 2 }).notNull().default("0"),

  // Pre-order is a per-variant flag; one variant of a listing can be
  // pre-order while another is in stock.
  isPreOrder: boolean("is_pre_order").notNull().default(false),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSellerListingVariantSchema = createInsertSchema(sellerListingVariantsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSellerListingVariant = z.infer<typeof insertSellerListingVariantSchema>;
export type SellerListingVariant = typeof sellerListingVariantsTable.$inferSelect;
