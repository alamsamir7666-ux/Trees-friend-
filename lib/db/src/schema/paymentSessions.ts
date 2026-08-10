import { pgTable, serial, text, numeric, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Payment Session — groups N orders from a single checkout into ONE bKash
 * charge, so the buyer pays once for a multi-seller cart instead of N times.
 *
 * WHY THIS EXISTS
 * ───────────────
 * bKash's Tokenized Checkout API takes exactly one amount + one invoice
 * number per Create Payment call. There's no "pay N invoices in one bKash
 * session" primitive. Before this table, a multi-seller cart where 3 orders
 * resolved to bKash required the buyer to go through bKash's hosted page 3
 * times sequentially — a real UX cost.
 *
 * This table implements the industry-standard solution (Shopify, Amazon,
 * Etsy, eBay all do this): the platform becomes the merchant of record.
 * The buyer pays the PLATFORM once (one bKash charge for the session
 * total). The platform later disburses each seller's share via bKash B2C
 * (Phase 2, not yet implemented — currently manual bank transfer).
 *
 * LIFECYCLE
 * ─────────
 * 1. Checkout creates N orders (existing behavior, unchanged).
 * 2. If ANY order is bKash, checkout creates ONE payment session covering
 *    all bKash orders from that checkout, and links them via
 *    orders.paymentSessionId.
 * 3. Frontend calls POST /bkash/create-payment-session with the sessionId.
 *    The backend calls bKash Create Payment with session.totalAmount (the
 *    sum of all linked orders) and invoiceNumber "PS-{sessionId}".
 * 4. bKash redirects the buyer back to /api/bkash/callback.
 * 5. The callback looks up the session by bkashPaymentId, verifies the
 *    paid amount matches session.totalAmount, then marks the session
 *    "paid" AND cascades to all linked orders (paymentStatus → "paid",
 *    paidAt set, paymentExpiresAt cleared).
 * 6. (Phase 2, not yet) A disbursement cron job pays each seller their
 *    share via bKash B2C, then marks the session "disbursed".
 *
 * COD orders are NOT linked to a payment session — they have no bKash
 * charge to group. Only bKash orders from a checkout get a session.
 *
 * BACKWARD COMPATIBILITY
 * ──────────────────────
 * Legacy orders (created before this table existed) have
 * paymentSessionId = NULL. The old POST /bkash/create-payment (orderId)
 * endpoint and per-order callback flow stay for those orders and for
 * single-order retry scenarios. New bKash orders use the session flow.
 *
 * GUEST CHECKOUT
 * ──────────────
 * Guest checkout is admin-direct only (single seller), so it doesn't have
 * the multi-seller problem. For consistency, guest bKash orders also use
 * a payment session (one session, one order) — but the UX improvement is
 * only visible on multi-seller authenticated carts.
 */
export const paymentSessionsTable = pgTable(
  "payment_sessions",
  {
    id: serial("id").primaryKey(),
    // The buyer who paid. NULL for guest sessions (guest orders use a
    // "guest_" prefixed userId on the orders themselves; the session
    // doesn't need it since the linked orders carry their own userId).
    userId: text("user_id").references(() => usersTable.clerkId, {
      onDelete: "set null",
    }),
    // Sum of all linked orders' totalAmount. Captured at session-creation
    // time so bKash charges exactly this amount. If an order is later
    // cancelled/refunded, the session total stays the same (the refund
    // is a separate bKash partial-refund call, tracked elsewhere).
    totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
    // bKash paymentID — persisted at Create Payment time so the callback
    // can look up the session by paymentID (indexed) without calling
    // queryPayment. NULL until POST /bkash/create-payment-session runs.
    bkashPaymentId: text("bkash_payment_id"),
    // "payment_pending" → "paid" → "disbursed" (Phase 2).
    // "cancelled" if the session expires before payment (cron job).
    // "refunded" if a partial/full refund was issued (Phase 3).
    paymentStatus: text("payment_status").notNull().default("payment_pending"),
    // When bKash callback confirms payment (session + all linked orders
    // marked paid at this instant).
    paidAt: timestamp("paid_at"),
    // (Phase 2) When all seller disbursements complete.
    disbursedAt: timestamp("disbursed_at"),
    // 60-minute payment window — same as orders.paymentExpiresAt. The
    // payment expiration cron cancels expired sessions + their linked
    // orders + restores stock.
    paymentExpiresAt: timestamp("payment_expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Lookup by userId (buyer's "my payment sessions" — future feature).
    index("payment_sessions_user_id_idx").on(table.userId),
    // Callback lookup by bkashPaymentId (the fast path — O(1) indexed).
    index("payment_sessions_bkash_payment_id_idx").on(table.bkashPaymentId),
    // Expiration cron lookup (find sessions where paymentExpiresAt < now).
    index("payment_sessions_payment_expires_at_idx").on(table.paymentExpiresAt),
  ],
);

export type PaymentSession = typeof paymentSessionsTable.$inferSelect;
