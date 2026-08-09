import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const loyaltyPointsTable = pgTable("loyalty_points", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  points: integer("points").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const loyaltyTransactionsTable = pgTable(
  "loyalty_transactions",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    points: integer("points").notNull(), // positive = earned, negative = spent
    reason: text("reason").notNull(),    // "order_#123", "redeemed", "referral_bonus"
    orderId: integer("order_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // P0-2: index on userId — the loyalty history page
    // (routes/loyalty.ts: GET /loyalty/transactions) filters
    // WHERE user_id = ? ORDER BY created_at DESC. Without this index the
    // loyalty history page seq-scans loyalty_transactions for every signed-in
    // user. Composite with createdAt so the same index serves the sort.
    index("loyalty_transactions_user_id_created_idx").on(
      table.userId,
      table.createdAt,
    ),
    // P0-2: index on orderId — supports "earned from order X" lookup
    // (used by admin analytics and loyalty debugging).
    index("loyalty_transactions_order_id_idx").on(table.orderId),
  ],
);
