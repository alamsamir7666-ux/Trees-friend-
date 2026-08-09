import { pgTable, serial, integer, numeric, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { type z } from "zod/v4";
import { sellersTable } from "./sellers";

/**
 * Platform's only revenue: flat 500 taka/year seller subscription fee.
 * No commission, ever, on any sale, any payment method. First 6 months
 * are free (trial) -- tracked via sellersTable.trialEndsAt, not here.
 * One row per seller per year they've paid (or are overdue) for.
 */
export const sellerSubscriptionsTable = pgTable(
  "seller_subscriptions",
  {
    id: serial("id").primaryKey(),
    sellerId: integer("seller_id")
      .notNull()
      .references(() => sellersTable.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull().default("500"),
    paidAt: timestamp("paid_at"),
    status: text("status").notNull().default("overdue"), // "paid" | "overdue"
  },
  (table) => [
    // Composite index on (sellerId, year) — supports the admin per-seller
    // subscription view and the subscription job's "find overdue sellers
    // for current year" query.
    index("seller_subscriptions_seller_id_year_idx").on(table.sellerId, table.year),
  ],
);

export const insertSellerSubscriptionSchema = createInsertSchema(sellerSubscriptionsTable).omit({
  id: true,
});
export type InsertSellerSubscription = z.infer<typeof insertSellerSubscriptionSchema>;
export type SellerSubscription = typeof sellerSubscriptionsTable.$inferSelect;
