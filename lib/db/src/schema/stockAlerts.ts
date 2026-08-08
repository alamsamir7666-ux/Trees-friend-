import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { productVariantsTable } from "./productVariants";

// Notify-me-when-back-in-stock is per VARIANT, not per product — a
// customer waiting on "Grafted" shouldn't be notified when "Seed Packet"
// restocks instead.
export const stockAlertsTable = pgTable(
  "stock_alerts",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").notNull(),
    variantId: integer("variant_id")
      .notNull()
      .references(() => productVariantsTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    notified: boolean("notified").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // P0-2: index on variantId — the restock-notification job
    // (routes/cron.ts → lowStockJob, plus the notify-on-restock path in
    // routes/stockAlerts.ts) queries WHERE variant_id = ? AND notified = false
    // to find every customer waiting on a given variant. Without this index
    // the restock path seq-scans stock_alerts on every restock event.
    index("stock_alerts_variant_id_idx").on(table.variantId),
  ],
);
