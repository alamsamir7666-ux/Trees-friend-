import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

export const loyaltyPointsTable = pgTable("loyalty_points", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  points: integer("points").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const loyaltyTransactionsTable = pgTable("loyalty_transactions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  points: integer("points").notNull(), // positive = earned, negative = spent
  reason: text("reason").notNull(),    // "order_#123", "redeemed", "referral_bonus"
  orderId: integer("order_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
