// lib/db/src/schema/subscriptions.ts
// Replenishment / recurring order subscriptions
import {
  pgTable, serial, text, numeric, integer, boolean, timestamp, jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { productsTable } from "./products";

export type SubscriptionItem = {
  productId: number;
  productName: string;
  productImage: string;
  quantity: number;
  price: number;
};

export type SubscriptionAddress = {
  fullName: string;
  phone: string;
  street: string;
  city: string;
  district: string;
  postalCode?: string | null;
};

export const subscriptionsTable = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  status: text("status").notNull().default("active"), // "active" | "paused" | "cancelled"
  frequency: text("frequency").notNull(),             // "weekly" | "biweekly" | "monthly"
  items: jsonb("items").$type<SubscriptionItem[]>().notNull(),
  shippingAddress: jsonb("shipping_address").$type<SubscriptionAddress>().notNull(),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
  discountPercent: integer("discount_percent").notNull().default(10), // loyalty discount
  nextOrderDate: timestamp("next_order_date").notNull(),
  lastOrderDate: timestamp("last_order_date"),
  orderCount: integer("order_count").notNull().default(0),
  paymentMethod: text("payment_method").notNull().default("cod"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSubscriptionSchema = createInsertSchema(subscriptionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptionsTable.$inferSelect;
