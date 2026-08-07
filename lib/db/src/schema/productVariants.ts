import { pgTable, serial, integer, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { productsTable } from "./products";

/**
 * A sellable form of a product, e.g. "Grafted Sapling - 3ft" or "Seed Packet".
 * A product must have at least one variant -- there is no price/stock on
 * the product itself. Each variant carries its own delivery charge because
 * a seed packet and a mature potted tree of the same product ship very
 * differently, and the admin sets that manually per variant.
 */
export const productVariantsTable = pgTable("product_variants", {
  id: serial("id").primaryKey(),
  productId: integer("product_id")
    .notNull()
    .references(() => productsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),                  // e.g. "Seed Packet", "Grafted - 3ft", "Potted - Mature"
  variantType: text("variant_type").notNull(),    // "form" | "size" | "pack" (kept generic for reuse beyond plants)
  form: text("form"),                             // "seed" | "sapling" | "grafted" | "potted"
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  discountPrice: numeric("discount_price", { precision: 10, scale: 2 }),
  stock: integer("stock").notNull().default(0),
  deliveryCharge: numeric("delivery_charge", { precision: 10, scale: 2 }).notNull().default("0"),
  sku: text("sku"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
