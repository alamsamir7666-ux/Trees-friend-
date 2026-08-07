import { pgTable, serial, integer, numeric, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sellersTable } from "./sellers";

/**
 * Platform's only revenue: flat 500 taka/year seller subscription fee.
 * No commission, ever, on any sale, any payment method. First 6 months
 * are free (trial) -- tracked via sellersTable.trialEndsAt, not here.
 * One row per seller per year they've paid (or are overdue) for.
 */
export const sellerSubscriptionsTable = pgTable("seller_subscriptions", {
  id: serial("id").primaryKey(),
  sellerId: integer("seller_id")
    .notNull()
    .references(() => sellersTable.id, { onDelete: "cascade" }),
  year: integer("year").notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull().default("500"),
  paidAt: timestamp("paid_at"),
  status: text("status").notNull().default("overdue"), // "paid" | "overdue"
});

export const insertSellerSubscriptionSchema = createInsertSchema(sellerSubscriptionsTable).omit({
  id: true,
});
export type InsertSellerSubscription = z.infer<typeof insertSellerSubscriptionSchema>;
export type SellerSubscription = typeof sellerSubscriptionsTable.$inferSelect;
