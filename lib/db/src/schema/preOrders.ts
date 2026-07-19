import { pgTable, serial, text, numeric, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

export type PreOrderShipping = {
  fullName: string; phone: string; street: string; city: string; district: string; postalCode?: string | null;
};

export const preOrdersTable = pgTable("pre_orders", {
  id: serial("id").primaryKey(),
  trackingId: text("tracking_id").notNull().unique(),
  userId: text("user_id").notNull().default("guest"),
  productId: integer("product_id").notNull(),
  productName: text("product_name").notNull(),
  productImage: text("product_image").notNull().default(""),
  quantity: integer("quantity").notNull().default(1),
  productPrice: numeric("product_price", { precision: 10, scale: 2 }).notNull(),
  discountedPrice: numeric("discounted_price", { precision: 10, scale: 2 }).notNull(),
  deliveryCharge: numeric("delivery_charge", { precision: 10, scale: 2 }).notNull(),
  whatsappPhone: text("whatsapp_phone"),
  shippingAddress: jsonb("shipping_address").$type<PreOrderShipping>().notNull(),
  paymentMethod: text("payment_method").notNull().default("bkash"),
  senderNumber: text("sender_number"),
  transactionId: text("transaction_id"),
  paymentStatus: text("payment_status").notNull().default("pending_verification"),
  status: text("status").notNull().default("pending"),
  notifiedAt: timestamp("notified_at"),
  cancellationReason: text("cancellation_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PreOrder = typeof preOrdersTable.$inferSelect;
