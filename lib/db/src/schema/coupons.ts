import {
  pgTable,
  serial,
  text,
  numeric,
  boolean,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const couponsTable = pgTable(
  "coupons",
  {
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
    /**
     * Owner of this coupon. NULL = platform-wide coupon (legacy / referral /
     * welcome coupons created by the system). Non-NULL = seller-scoped coupon
     * that only the owning seller can manage (create / edit / toggle / delete)
     * via the seller dashboard's Coupons tab.
     *
     * At checkout, validateCoupon still returns the coupon regardless of
     * sellerId -- the seller scoping is a management concern (which seller
     * can edit it), not an applicability concern (which cart it can be
     * applied to). This keeps the multi-seller cart discount allocation in
     * routes/orders.ts untouched.
     */
    sellerId: integer("seller_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    sellerIdIdx: index("idx_coupons_seller_id").on(table.sellerId),
  }),
);

export const insertCouponSchema = createInsertSchema(couponsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCoupon = z.infer<typeof insertCouponSchema>;
export type Coupon = typeof couponsTable.$inferSelect;
