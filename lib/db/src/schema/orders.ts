import {
  pgTable,
  serial,
  text,
  numeric,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A line item snapshot at checkout time. Mirrors the cart_items XOR shape
 * (see schema/cart.ts): a line is EITHER an admin-direct variant purchase
 * (variantId set, sellerListingId/sellerId absent) OR a marketplace
 * seller's listing (sellerListingId + sellerId set, variantId absent).
 *
 * Every order's items[] array is homogeneous -- either all admin-direct
 * lines or all lines from the SAME seller, never mixed -- because checkout
 * splits a multi-seller cart into one order per seller (plan doc §2, §7)
 * before any order row is written. ordersTable.sellerId (below) mirrors
 * items[].sellerId for the whole order and is the fast-path column for
 * "seller's own orders" queries; items[].sellerId is kept too so a single
 * line is self-describing without joining back to the parent order.
 *
 * Earlier draft of this comment claimed productId would be repointed at
 * seller_listings.id "going forward" -- that never happened and isn't
 * happening now either: productId always stays the admin variety id for
 * both line types, since flows outside the marketplace (search, wishlist,
 * "buy again" links) key off productId and shouldn't need to know which
 * line type they're looking at just to link back to the product page.
 */
export type OrderItem = {
  productId: number;
  productName: string;
  productImage: string;
  quantity: number;
  price: number;
} & (
  | {
      // Admin-direct line (pre-marketplace buying path, unchanged).
      variantId: number;
      variantName: string;
      deliveryCharge: number;
      sellerListingId?: undefined;
      sellerId?: undefined;
    }
  | {
      // Marketplace line: a specific seller's listing of a variety.
      sellerListingId: number;
      sellerId: number;
      variantId?: undefined;
      variantName?: undefined;
      deliveryCharge: number;
    }
);

export type ShippingAddress = {
  fullName: string;
  phone: string;
  street: string;
  city: string;
  district: string;
  postalCode?: string | null;
};

export const ordersTable = pgTable("orders", {
  id: serial("id").primaryKey(),
  trackingId: text("tracking_id").notNull().unique(),
  userId: text("user_id").notNull(),
  // Null for admin-direct orders (pre-marketplace buying path, still live
  // -- see schema/cart.ts and OrderItem doc above). Set to the seller's id
  // for every marketplace order; every item in that order's items[] then
  // has the SAME sellerId, since checkout splits multi-seller carts into
  // one order per seller before insert (plan doc §2, §7).
  sellerId: integer("seller_id"),
  items: jsonb("items").$type<OrderItem[]>().notNull(),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
  paymentMethod: text("payment_method").notNull(),
  senderNumber: text("sender_number"),
  paidAt: timestamp("paid_at"),
  paymentStatus: text("payment_status").notNull().default("pending"),
  orderStatus: text("order_status").notNull().default("pending"),
  transactionId: text("transaction_id"),
  shippingAddress: jsonb("shipping_address").$type<ShippingAddress>().notNull(),
  couponCode: text("coupon_code"),
  discountAmount: numeric("discount_amount", {
    precision: 10,
    scale: 2,
  })
    .notNull()
    .default("0"),
  giftWrap: text("gift_wrap").default("false"),
  giftMessage: text("gift_message"),
  cancellationReason: text("cancellation_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertOrderSchema = createInsertSchema(ordersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof ordersTable.$inferSelect;
