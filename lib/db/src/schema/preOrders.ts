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
  // Phase 6: added to fix the over-notification gap logged in Phase 5's
  // handoff. Nullable, and deliberately a bare integer (no references() FK)
  // -- matching this table's existing convention for productId above, which
  // is also a plain id, not a live FK, because pre_orders is a
  // denormalized/historical record (see productName/productImage snapshot
  // fields) rather than something that should break or cascade if the
  // referenced seller_listing_variants row is later edited or deleted.
  // Null on any row created before this migration (legacy rows) --
  // notifyPreOrderCustomers in routes/preOrders.ts falls back to its old,
  // broader product-wide behavior for those, see that function's doc
  // comment.
  sellerListingVariantId: integer("seller_listing_variant_id"),
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
