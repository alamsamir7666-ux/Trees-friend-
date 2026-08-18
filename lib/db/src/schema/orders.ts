import {
  pgTable,
  serial,
  text,
  numeric,
  integer,
  boolean,
  timestamp,
  jsonb,
  check,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { type z } from "zod/v4";
import { sql } from "drizzle-orm";
import { sellersTable } from "./sellers";
import { usersTable } from "./users";

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
      // Which VARIANT of that listing was bought (e.g. "grafted" vs
      // "sapling") -- distinct from sellerListingId, which only identifies
      // the listing as a whole. Added so review eligibility (reviews.ts)
      // can be checked exactly against the variant a buyer purchased,
      // instead of only against the listing (which could span variants
      // that differ meaningfully, e.g. different pot sizes or forms).
      // Optional (not required) so existing historical orders written
      // before this field existed still satisfy the type -- eligibility
      // checks fall back to listing-level matching for those.
      sellerListingVariantId?: number;
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

export const ordersTable = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    trackingId: text("tracking_id").notNull().unique(),
    // Industry-standard sequential order number for display (Shopify
    // #1001, #1002; WooCommerce order numbers). Distinct from id (PK,
    // never displayed) and trackingId (random hex, used as a bearer
    // secret for guest order lookup). orderNumber is the friendly,
    // sequential identifier shown to buyers and referenced in emails.
    // Populated via a Postgres SEQUENCE (order_number_seq) for race-free
    // sequential assignment — started at 1001 so the first order is
    // #1001 (matches Shopify convention, avoids single-digit order
    // numbers that look unprofessional).
    //
    // Defense-in-depth (v6.2 Part 14):
    //   - The INSERT paths at routes/orders.ts:367,960 explicitly set
    //     `orderNumber: sql\`nextval('order_number_seq')\``. But production
    //     data showed 10 orders with NULL order_number despite this line
    //     being present in the code — the deployed version may not have
    //     had it, OR the SQL template wasn't emitted by Drizzle for some
    //     INSERT paths. Root cause was never fully isolated.
    //   - The column-level `.default(sql\`nextval('order_number_seq')\`)`
    //     is defense-in-depth: even if a future INSERT forgets to set
    //     orderNumber (or the explicit value gets stripped by a Drizzle
    //     bug), the column default kicks in + assigns a fresh sequence
    //     value. The explicit INSERT value (when present) wins over the
    //     default — no double-nextval waste.
    //   - `.notNull()` enforces the invariant at the DB layer. Combined
    //     with the backfill (assign nextval() to existing NULL rows), the
    //     column is now guaranteed non-NULL going forward.
    orderNumber: integer("order_number")
      .notNull()
      .default(sql`nextval('order_number_seq')`),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.clerkId, { onDelete: "restrict" }),
    // Null for admin-direct orders (pre-marketplace buying path, still live
    // -- see schema/cart.ts and OrderItem doc above). Set to the seller's id
    // for every marketplace order; every item in that order's items[] then
    // has the SAME sellerId, since checkout splits multi-seller carts into
    // one order per seller before insert (plan doc §2, §7).
    // FK added: RESTRICT on delete — an order should never silently disappear
    // when a seller is deleted (financial audit trail). The seller delete
    // route should soft-delete instead.
    sellerId: integer("seller_id").references(() => sellersTable.id, {
      onDelete: "restrict",
    }),
    items: jsonb("items").$type<OrderItem[]>().notNull(),
    totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
    paymentMethod: text("payment_method").notNull(),
    senderNumber: text("sender_number"),
    paidAt: timestamp("paid_at"),
    paymentStatus: text("payment_status").notNull().default("pending"),
    orderStatus: text("order_status").notNull().default("pending"),
    transactionId: text("transaction_id"),
    // Industry-standard idempotency: if the buyer's client sends an
    // Idempotency-Key header on POST /orders, we store it here. A duplicate
    // request with the same key returns the existing order(s) instead of
    // creating new ones — prevents duplicate orders on network retry /
    // double-click. Shopify uses X-Shopify-Checkout-Access-Token; Stripe
    // uses Idempotency-Key. Nullable + unique: NULL for orders created
    // before this column existed or when the client didn't send a key.
    idempotencyKey: text("idempotency_key").unique(),
    // bKash paymentID persisted at Create Payment time so the callback can
    // look up the order directly without a queryPayment round-trip to
    // bKash's API. Nullable: only set for bKash orders, and only after
    // POST /bkash/create-payment has returned a paymentID.
    bkashPaymentId: text("bkash_payment_id"),
    // Industry-standard payment-pending order expiration: bKash orders
    // start at paymentStatus='payment_pending' and must be completed within
    // this window (default 60 minutes). A cron job cancels expired orders
    // and restores stock. Nullable: NULL for COD orders (no payment
    // pending) and for orders created before this column existed.
    paymentExpiresAt: timestamp("payment_expires_at"),
    // Payment session this order belongs to (for multi-seller bKash carts).
    // NULL for COD orders (no bKash charge to group) and for legacy orders
    // created before the payment_sessions table existed. See
    // schema/paymentSessions.ts for the full rationale.
    paymentSessionId: integer("payment_session_id"),
    // ── Per-status timestamps (industry-standard) ──────────────────
    // Each timestamp records WHEN the order entered that status. Used by:
    //   1. The 7-day return window (now reads deliveredAt, not updatedAt —
    //      updatedAt changes on every status flip, which was silently
    //      resetting the return window).
    //   2. SLA reporting ("average time to ship", "average time to deliver").
    //   3. The OrderTimeline component (shows real per-step timestamps
    //      instead of the fake "all steps share updatedAt" display).
    //   4. Audit trail (when was this cancelled? when was it confirmed?).
    // NULL = the order hasn't reached that status yet (or was created
    // before these columns existed).
    confirmedAt: timestamp("confirmed_at"),
    shippedAt: timestamp("shipped_at"),
    deliveredAt: timestamp("delivered_at"),
    cancelledAt: timestamp("cancelled_at"),
    shippingAddress: jsonb("shipping_address").$type<ShippingAddress>().notNull(),
    couponCode: text("coupon_code"),
    discountAmount: numeric("discount_amount", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("0"),
    // FIX (migration 0005): was text default "false" — stored booleans as
    // strings. Now proper boolean type.
    giftWrap: boolean("gift_wrap").notNull().default(false),
    giftMessage: text("gift_message"),
    cancellationReason: text("cancellation_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    // FIX: soft-delete column. Orders should NEVER be hard-deleted —
    // financial records must be retained for accounting/tax compliance.
    // Cancelled orders set this column; the row stays for audit trail.
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    // FIX: CHECK constraints on money columns — total_amount and
    // discount_amount must be >= 0. Prevents negative prices/discounts
    // from being inserted (defense-in-depth at the DB layer).
    check("orders_total_amount_check", sql`${table.totalAmount} >= 0`),
    check("orders_discount_amount_check", sql`${table.discountAmount} >= 0`),
    // P0-2: indexes on the two hottest order-list query paths.
    // orders.userId is queried on every buyer's order-list call
    // (routes/orders.ts:60); orders.sellerId is queried on every seller's
    // order-list call (routes/sellerOrders.ts:74). Without these indexes
    // both queries seq-scan the orders table, which becomes unusably slow
    // past ~10k orders. Composite with createdAt DESC so the same index
    // also serves the common "list a user's/seller's orders, newest first"
    // pattern without a separate sort step.
    index("orders_user_id_created_idx").on(table.userId, table.createdAt),
    index("orders_seller_id_created_idx").on(table.sellerId, table.createdAt),
    // Index for payment-pending expiration cron: finds all orders where
    // paymentStatus='payment_pending' AND paymentExpiresAt < now(). Without
    // this index the cron job seq-scans the orders table every 5 minutes.
    index("orders_payment_expires_at_idx").on(table.paymentExpiresAt),
    // Index for bKash callback order lookup: the callback receives a
    // paymentID and needs to find the matching order. Without this index
    // the callback seq-scans orders on every bKash redirect.
    index("orders_bkash_payment_id_idx").on(table.bkashPaymentId),
    // Index for payment session lookup: "find all orders linked to this
    // session" (used by the callback cascade + the disbursement cron).
    index("orders_payment_session_id_idx").on(table.paymentSessionId),
  ],
);

export const insertOrderSchema = createInsertSchema(ordersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof ordersTable.$inferSelect;
