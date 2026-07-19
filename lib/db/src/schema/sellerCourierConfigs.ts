import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sellersTable } from "./sellers";

/**
 * Per-seller courier credentials (Pathao or Steadfast, phase 1 only).
 * Buyer pays courier fee. Seller uses their own merchant account --
 * platform is not billed and holds no courier liability.
 *
 * Sellers without a verified row here (or using an unsupported courier)
 * fall back to order_shipments.courierProvider = "manual": no webhook, no
 * tracking ID, seller updates status by hand in Manage Orders.
 *
 * SECURITY: real API credentials -- same encryption/no-log/masked-response
 * standard as sellerPaymentConfigsTable.
 *
 * sellerId has .unique(), mirroring sellerPaymentConfigsTable, so at most
 * one row can exist per seller -- routes/sellerCourierConfigs.ts's own
 * delete-then-insert logic assumes exactly this. This constraint was added
 * in a later session (Part C) after Phase 8's real-database testing found
 * and confirmed it was previously missing here (this table's DB-level
 * constraint had lagged sellerPaymentConfigsTable's; a duplicate-insert
 * attempt against the live DB succeeded before this fix, proving the gap
 * was real, not hypothetical).
 */
export const sellerCourierConfigsTable = pgTable("seller_courier_configs", {
  id: serial("id").primaryKey(),
  sellerId: integer("seller_id")
    .notNull()
    .unique()
    .references(() => sellersTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(), // "pathao" | "steadfast"

  apiKey: text("api_key").notNull(),
  apiSecret: text("api_secret").notNull(),
  storeId: text("store_id"),

  isVerified: boolean("is_verified").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSellerCourierConfigSchema = createInsertSchema(sellerCourierConfigsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertSellerCourierConfig = z.infer<typeof insertSellerCourierConfigSchema>;
export type SellerCourierConfig = typeof sellerCourierConfigsTable.$inferSelect;
