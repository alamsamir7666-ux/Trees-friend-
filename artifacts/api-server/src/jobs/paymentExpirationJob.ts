import { db } from "@workspace/db";
import {
  ordersTable,
  productVariantsTable,
  sellerListingVariantsTable,
  paymentSessionsTable,
} from "@workspace/db";
import { eq, and, lt, sql, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import type { OrderItem } from "@workspace/db";

/**
 * Payment-pending expiration job.
 *
 * TWO PHASES:
 *
 * Phase 1 — Expire payment SESSIONS (multi-seller bKash):
 *   Finds sessions where paymentStatus = 'payment_pending' AND
 *   paymentExpiresAt < now(). For each expired session:
 *     1. Cancels the session (paymentStatus → 'cancelled')
 *     2. Cancels ALL linked orders (orderStatus → 'cancelled',
 *        paymentStatus → 'cancelled')
 *     3. Restores stock for every item in every linked order
 *
 * Phase 2 — Expire individual ORDERS (legacy / per-order bKash):
 *   Finds orders where paymentStatus = 'payment_pending' AND
 *   paymentExpiresAt < now() AND orderStatus != 'cancelled' AND
 *   paymentSessionId IS NULL (session-linked orders were already
 *   cancelled in Phase 1). For each:
 *     1. Sets orderStatus = 'cancelled', paymentStatus = 'cancelled'
 *     2. Restores stock for every item in the order
 *
 * Phase 1 runs BEFORE Phase 2 so that session-linked orders are already
 * cancelled when Phase 2 runs — the `orderStatus != 'cancelled'` filter
 * in Phase 2 skips them, avoiding double stock restoration.
 *
 * Industry standard: Shopify's inventory_hold_minutes (60 min default),
 * Magento cart/checkout/lifetime, WooCommerce "Hold Stock".
 *
 * Idempotent: both phases filter out already-cancelled orders/sessions,
 * and stock restoration uses additive `stock = stock + quantity` (safe
 * to run twice — though the filter prevents that).
 */
export async function runPaymentExpirationJob(): Promise<void> {
  const now = new Date();
  let cancelled = 0;
  let stockRestored = 0;

  // ── Phase 1: Expire payment sessions ────────────────────────────
  const expiredSessions = await db
    .select()
    .from(paymentSessionsTable)
    .where(
      and(
        eq(paymentSessionsTable.paymentStatus, "payment_pending"),
        lt(paymentSessionsTable.paymentExpiresAt, now),
      ),
    );

  if (expiredSessions.length > 0) {
    logger.info(
      { count: expiredSessions.length },
      "Payment expiration job: processing expired payment sessions",
    );

    for (const session of expiredSessions) {
      try {
        // Find all orders linked to this session.
        const linkedOrders = await db
          .select()
          .from(ordersTable)
          .where(eq(ordersTable.paymentSessionId, session.id));

        // Restore stock for every item in every linked order.
        for (const order of linkedOrders) {
          if (order.orderStatus === "cancelled") continue; // idempotency
          const items = (order.items ?? []) as OrderItem[];
          for (const item of items) {
            if (item.variantId != null) {
              await db
                .update(productVariantsTable)
                .set({ stock: sql`${productVariantsTable.stock} + ${item.quantity}` })
                .where(eq(productVariantsTable.id, item.variantId));
              stockRestored++;
            } else if (item.sellerListingVariantId != null) {
              await db
                .update(sellerListingVariantsTable)
                .set({
                  stock: sql`${sellerListingVariantsTable.stock} + ${item.quantity}`,
                  availableQuantity: sql`${sellerListingVariantsTable.availableQuantity} + ${item.quantity}`,
                  updatedAt: new Date(),
                })
                .where(eq(sellerListingVariantsTable.id, item.sellerListingVariantId));
              stockRestored++;
            }
          }
          cancelled++;
        }

        // Cancel all linked orders in one update.
        if (linkedOrders.length > 0) {
          await db
            .update(ordersTable)
            .set({
              orderStatus: "cancelled",
              paymentStatus: "cancelled",
              cancellationReason: "Payment session timed out (not completed within 60 minutes)",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(ordersTable.paymentSessionId, session.id),
                sql`${ordersTable.orderStatus} != 'cancelled'`,
              ),
            );
        }

        // Cancel the session itself.
        await db
          .update(paymentSessionsTable)
          .set({
            paymentStatus: "cancelled",
            updatedAt: new Date(),
          })
          .where(eq(paymentSessionsTable.id, session.id));
      } catch (err) {
        logger.error(
          { err, sessionId: session.id },
          "Payment expiration job: failed to cancel session",
        );
      }
    }
  }

  // ── Phase 2: Expire individual orders (no session) ──────────────
  // Only processes orders that are NOT linked to a payment session
  // (paymentSessionId IS NULL) — session-linked orders were already
  // handled in Phase 1.
  const expiredOrders = await db
    .select()
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.paymentStatus, "payment_pending"),
        lt(ordersTable.paymentExpiresAt, now),
        sql`${ordersTable.orderStatus} != 'cancelled'`,
        isNull(ordersTable.paymentSessionId),
      ),
    );

  if (expiredOrders.length > 0) {
    logger.info(
      { count: expiredOrders.length },
      "Payment expiration job: processing expired payment-pending orders (no session)",
    );

    for (const order of expiredOrders) {
      try {
        const items = (order.items ?? []) as OrderItem[];

        for (const item of items) {
          if (item.variantId != null) {
            await db
              .update(productVariantsTable)
              .set({ stock: sql`${productVariantsTable.stock} + ${item.quantity}` })
              .where(eq(productVariantsTable.id, item.variantId));
            stockRestored++;
          } else if (item.sellerListingVariantId != null) {
            await db
              .update(sellerListingVariantsTable)
              .set({
                stock: sql`${sellerListingVariantsTable.stock} + ${item.quantity}`,
                availableQuantity: sql`${sellerListingVariantsTable.availableQuantity} + ${item.quantity}`,
                updatedAt: new Date(),
              })
              .where(eq(sellerListingVariantsTable.id, item.sellerListingVariantId));
            stockRestored++;
          }
        }

        await db
          .update(ordersTable)
          .set({
            orderStatus: "cancelled",
            paymentStatus: "cancelled",
            cancellationReason: "Payment timed out (not completed within 60 minutes)",
            updatedAt: new Date(),
          })
          .where(eq(ordersTable.id, order.id));

        cancelled++;
      } catch (err) {
        logger.error(
          { err, orderId: order.id, trackingId: order.trackingId },
          "Payment expiration job: failed to cancel order",
        );
      }
    }
  }

  if (cancelled > 0 || stockRestored > 0) {
    logger.info(
      {
        cancelled,
        stockRestored,
        sessionsExpired: expiredSessions.length,
        ordersExpired: expiredOrders.length,
      },
      "Payment expiration job: completed",
    );
  }
}
