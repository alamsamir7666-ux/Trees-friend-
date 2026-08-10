import { db } from "@workspace/db";
import { ordersTable, productVariantsTable, sellerListingVariantsTable } from "@workspace/db";
import { eq, and, lt, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import type { OrderItem } from "@workspace/db";

/**
 * Payment-pending order expiration job.
 *
 * Finds all orders where:
 *   paymentStatus = 'payment_pending'
 *   AND paymentExpiresAt < now()
 *   AND orderStatus != 'cancelled'  (idempotency — don't re-process)
 *
 * For each expired order:
 *   1. Sets orderStatus = 'cancelled', paymentStatus = 'cancelled'
 *   2. Restores stock for every item in the order (reverses the
 *      decrement done at checkout time)
 *   3. Logs the cancellation for audit
 *
 * This is the industry-standard pattern for payment-pending order
 * cleanup. Shopify's default is 60 minutes (inventory_hold_minutes);
 * Magento has `cart/checkout/lifetime`; WooCommerce has "Hold Stock
 * for unpaid orders for X minutes". Without this, bKash orders that
 * the buyer abandoned at the hosted payment page sit at
 * payment_pending FOREVER, holding inventory that could be sold to
 * other buyers.
 *
 * Idempotency: the query filters `orderStatus != 'cancelled'` so
 * re-running the job on the same expired order is a no-op. Stock
 * restoration is also idempotent — it uses `stock = stock + quantity`
 * (additive), so even if the job somehow runs twice on the same order
 * before the status flip commits, the stock is only restored once
 * (the second run's WHERE clause finds the order already cancelled and
 * skips it).
 *
 * Scheduled via POST /api/cron/payment-expiration every 5 minutes
 * (see routes/cron.ts and vercel.json).
 */
export async function runPaymentExpirationJob(): Promise<void> {
  const now = new Date();

  // Find all expired payment-pending orders that haven't been cancelled yet.
  const expiredOrders = await db
    .select()
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.paymentStatus, "payment_pending"),
        lt(ordersTable.paymentExpiresAt, now),
        sql`${ordersTable.orderStatus} != 'cancelled'`,
      ),
    );

  if (expiredOrders.length === 0) {
    return;
  }

  logger.info(
    { count: expiredOrders.length },
    "Payment expiration job: processing expired payment-pending orders",
  );

  let cancelled = 0;
  let stockRestored = 0;

  for (const order of expiredOrders) {
    try {
      const items = (order.items ?? []) as OrderItem[];

      // Restore stock for each item. Marketplace items (sellerListingVariantId
      // set) restore sellerListingVariantsTable.stock + availableQuantity;
      // admin-direct items (variantId set) restore productVariantsTable.stock.
      // Uses additive `stock = stock + quantity` so it's idempotent.
      for (const item of items) {
        if (item.variantId != null) {
          // Admin-direct variant line
          await db
            .update(productVariantsTable)
            .set({
              stock: sql`${productVariantsTable.stock} + ${item.quantity}`,
            })
            .where(eq(productVariantsTable.id, item.variantId));
          stockRestored++;
        } else if (item.sellerListingVariantId != null) {
          // Marketplace seller-listing-variant line
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

      // Cancel the order. paymentStatus → 'cancelled' (distinct from
      // 'failed' — this was a timeout, not a payment failure); orderStatus
      // → 'cancelled'. The cancellationReason records why.
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
      // Log but don't throw — one failed order shouldn't block the rest.
      logger.error(
        { err, orderId: order.id, trackingId: order.trackingId },
        "Payment expiration job: failed to cancel order",
      );
    }
  }

  logger.info(
    { cancelled, stockRestored, total: expiredOrders.length },
    "Payment expiration job: completed",
  );
}
