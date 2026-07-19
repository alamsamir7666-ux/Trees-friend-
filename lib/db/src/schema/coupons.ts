import {
  pgTable,
  serial,
  text,
  numeric,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const couponsTable = pgTable("coupons", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  discountType: text("discount_type").notNull(),
  discountValue: numeric("discount_value", {
    precision: 10,
    scale: 2,
  }).notNull(),
  minOrderAmount: numeric("min_order_amount", { precision: 10, scale: 2 }),
  expiryDate: timestamp("expiry_date"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCouponSchema = createInsertSchema(couponsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCoupon = z.infer<typeof insertCouponSchema>;
export type Coupon = typeof couponsTable.$inferSelect;
