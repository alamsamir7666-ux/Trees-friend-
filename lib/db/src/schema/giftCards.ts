// lib/db/src/schema/giftCards.ts
import {
  pgTable, serial, text, numeric, boolean, timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const giftCardsTable = pgTable("gift_cards", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),            // e.g. "ENVY-XXXX-XXXX"
  initialBalance: numeric("initial_balance", { precision: 10, scale: 2 }).notNull(),
  balance: numeric("balance", { precision: 10, scale: 2 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  purchasedByUserId: text("purchased_by_user_id"),  // null = admin-issued
  recipientEmail: text("recipient_email"),
  recipientName: text("recipient_name"),
  message: text("message"),
  expiryDate: timestamp("expiry_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const giftCardTransactionsTable = pgTable("gift_card_transactions", {
  id: serial("id").primaryKey(),
  giftCardId: serial("gift_card_id").notNull().references(() => giftCardsTable.id),
  orderId: text("order_id"),
  userId: text("user_id"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(), // negative = debit
  balanceAfter: numeric("balance_after", { precision: 10, scale: 2 }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertGiftCardSchema = createInsertSchema(giftCardsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertGiftCard = z.infer<typeof insertGiftCardSchema>;
export type GiftCard = typeof giftCardsTable.$inferSelect;
