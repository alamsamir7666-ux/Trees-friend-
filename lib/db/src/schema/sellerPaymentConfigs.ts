import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sellersTable } from "./sellers";

/**
 * Per-seller bKash merchant credentials. Platform never holds customer
 * money -- advance payments go buyer -> seller's own bKash merchant
 * account directly.
 *
 * SECURITY: this table stores real financial/API credentials. Encrypt at
 * rest, same standard as password storage. Do not log these fields. Do not
 * return them in any API response body beyond a masked/last-4 indicator.
 * That masking/encryption is an application-layer concern -- these columns
 * hold ciphertext, not plaintext, once the encryption layer is wired up.
 *
 * A seller with no verified row here can only offer COD. Reject
 * seller_listings.payment_method = "advance" | "both" at the API layer if
 * is_verified is false or no row exists.
 */
export const sellerPaymentConfigsTable = pgTable("seller_payment_configs", {
  id: serial("id").primaryKey(),
  sellerId: integer("seller_id")
    .notNull()
    .unique()
    .references(() => sellersTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("bkash"), // "bkash"

  // Encrypted at rest. Never returned verbatim via API.
  merchantAppKey: text("merchant_app_key").notNull(),
  merchantAppSecret: text("merchant_app_secret").notNull(),
  merchantUsername: text("merchant_username").notNull(),
  merchantPassword: text("merchant_password").notNull(),

  isVerified: boolean("is_verified").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSellerPaymentConfigSchema = createInsertSchema(sellerPaymentConfigsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSellerPaymentConfig = z.infer<typeof insertSellerPaymentConfigSchema>;
export type SellerPaymentConfig = typeof sellerPaymentConfigsTable.$inferSelect;
