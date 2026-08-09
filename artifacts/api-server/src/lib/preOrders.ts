/**
 * Pre-order customer notification logic.
 *
 * EXTRACTED from routes/preOrders.ts so that:
 *  • The logic is reusable from non-HTTP contexts without importing Express.
 *  • The logic is unit-testable in isolation.
 *  • Routes/products.ts and routes/sellerListings.ts import this — decoupling
 *    route files from each other (the audit flagged "business logic exported
 *    from route files" as a code smell because it couples route files
 *    together).
 *
 * ─── Behavior ────────────────────────────────────────────────────────────────
 *
 *  Called whenever a seller edit transitions a variant out of "pending
 *  pre-order" (isPreOrder=true, availableQuantity=0), either by turning
 *  isPreOrder off or by making stock available.
 *
 *  Scopes the notify query to (productId AND sellerListingVariantId) instead
 *  of productId alone — a customer who pre-ordered seller A's variant will
 *  no longer be notified when only seller B's unrelated variant becomes
 *  available.
 *
 *  Legacy rows created before the Phase 6 migration have
 *  sellerListingVariantId = null and cannot be scoped this precisely (the
 *  data was never captured) — those rows still match under the old, broader
 *  "any pending pre-order on this product" condition, via the
 *  `OR sellerListingVariantId IS NULL` branch below. This is intentional
 *  backward-compatible behavior, not a bug.
 */

import { logger } from "./logger";
import { db } from "@workspace/db";
import { preOrdersTable } from "@workspace/db";
import { eq, and, or, isNull } from "drizzle-orm";

/**
 * Notify all customers who pre-ordered a product (optionally scoped to a
 * specific variant) that their pre-order has shipped.
 *
 * For each matching pre-order:
 *  1. If the pre-order has a `whatsappPhone`, send a WhatsApp message via
 *     Twilio (loaded lazily — `await import("twilio")` — so the twilio
 *     dependency is only loaded when actually needed).
 *  2. Mark the pre-order as `status = "shipped"` + `notifiedAt = now()`.
 *
 * Never throws — failures are logged and swallowed so a notification bug
 * can't break the product/variant update flow that calls this.
 */
export async function notifyPreOrderCustomers(
  productId: number,
  productName: string,
  sellerListingVariantId?: number,
): Promise<void> {
  try {
    const scope = sellerListingVariantId != null
      ? and(
          eq(preOrdersTable.productId, productId),
          eq(preOrdersTable.status, "pending"),
          or(
            eq(preOrdersTable.sellerListingVariantId, sellerListingVariantId),
            isNull(preOrdersTable.sellerListingVariantId),
          ),
        )
      : and(eq(preOrdersTable.productId, productId), eq(preOrdersTable.status, "pending"));

    const orders = await db.select().from(preOrdersTable).where(scope);
    logger.info({ count: orders.length, productId, sellerListingVariantId }, "Notifying pre-order customers");
    for (const order of orders) {
      if (order.whatsappPhone) {
        const phone = order.whatsappPhone.replace(/[^+\d]/g, "");
        const to = phone.startsWith("+") ? phone : `+88${phone}`;
        const siteUrl = process.env.VITE_SITE_URL ?? "https://fixed5.vercel.app";
        try {
          const twilio = await import("twilio");
          const client = twilio.default(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await client.messages.create({
            from: process.env.TWILIO_WHATSAPP_FROM ?? "whatsapp:+14155238886",
            to: `whatsapp:${to}`,
            body: `🌸 *Tree Friend*\n\nGreat news! Your pre-ordered *${productName}* has arrived and is now being shipped to you! 🚚\n\nExpected delivery: 2-3 days.\n\nTrack: ${siteUrl}/track\n\nThank you for your patience! 💕`,
          });
        } catch (err) {
          logger.error({ err, orderId: order.id }, "Pre-order WhatsApp notification failed");
        }
      }
      await db.update(preOrdersTable).set({ status: "shipped", notifiedAt: new Date(), updatedAt: new Date() }).where(eq(preOrdersTable.id, order.id));
    }
  } catch (err) {
    logger.error({ err, productId, sellerListingVariantId }, "Pre-order customer notification failed");
  }
}
