import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { productVariantsTable } from "./productVariants";

// Notify-me-when-back-in-stock is per VARIANT, not per product — a
// customer waiting on "Grafted" shouldn't be notified when "Seed Packet"
// restocks instead.
export const stockAlertsTable = pgTable("stock_alerts", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull(),
  variantId: integer("variant_id")
    .notNull()
    .references(() => productVariantsTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  notified: boolean("notified").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
