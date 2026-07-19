import { Router } from "express";
import { db } from "@workspace/db";
import { orderShipmentsTable, ordersTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getCourierAdapter } from "../lib/courierAdapters";
import { sendOrderStatusUpdate } from "../lib/email";

/**
 * Shared normalized webhook endpoints (plan doc §8: "/webhooks/courier/pathao,
 * /webhooks/courier/steadfast"). Not registered in openapi.yaml -- external
 * webhook receivers aren't part of our typed client, same precedent as
 * /sms-webhook (smsWebhook.ts isn't in the spec either).
 *
 * No signature/HMAC verification here: neither Pathao's nor Steadfast's
 * publicly documented merchant API describes a webhook-signing secret in
 * the sources checked while building this (Steadfast's docs mention an
 * optional bearer-token header some community packages configure, but that
 * isn't confirmed as an official requirement). Flagging as a real gap
 * rather than fabricating a verification step that might silently reject
 * legitimate webhooks or, worse, look like security that isn't real. If
 * either courier's dashboard exposes a webhook secret/signing key when a
 * seller sets this up for real, add verification here before trusting
 * payloads in production.
 *
 * Each courier's webhook doesn't identify WHICH seller it's for (Pathao/
 * Steadfast only know their own merchant account, not our seller_id) -- so
 * this looks up the shipment purely by courierTrackingId, which is unique
 * per courier, and updates whichever order that shipment belongs to. No
 * seller-scoping needed at this layer since the tracking id itself is the
 * join key.
 */

const router = Router();

const ORDER_STATUS_ON_SHIPMENT: Record<string, string | undefined> = {
  picked_up: "shipped",
  in_transit: "shipped",
  delivered: "delivered",
};

async function handleCourierWebhook(provider: "pathao" | "steadfast", payload: unknown) {
  const adapter = getCourierAdapter(provider);
  if (!adapter) return { ok: false, reason: "unknown_provider" as const };

  const trackingId = adapter.extractTrackingId(payload);
  if (!trackingId) return { ok: false, reason: "no_tracking_id" as const };

  const normalizedStatus = adapter.normalizeWebhookStatus(payload);

  const [shipment] = await db
    .select()
    .from(orderShipmentsTable)
    .where(eq(orderShipmentsTable.courierTrackingId, trackingId))
    .limit(1);

  if (!shipment) {
    console.log(`[courier-webhook:${provider}] No shipment found for tracking id`, trackingId);
    return { ok: false, reason: "no_matching_shipment" as const };
  }

  // Always store the raw payload for debugging, even if status couldn't be
  // normalized -- per orderShipments.ts's rawWebhookPayload doc comment
  // ("kept for debugging when a courier's webhook payload shape changes").
  const updates: Partial<typeof orderShipmentsTable.$inferInsert> = {
    lastSyncedAt: new Date(),
    rawWebhookPayload: payload as any,
  };
  if (normalizedStatus) updates.status = normalizedStatus;

  await db.update(orderShipmentsTable).set(updates).where(eq(orderShipmentsTable.id, shipment.id));

  if (!normalizedStatus) {
    console.log(`[courier-webhook:${provider}] Unrecognized status in payload, stored raw only`, payload);
    return { ok: true, orderId: shipment.orderId, statusUpdated: false };
  }

  // Reflect delivery/shipped progress onto the order's own orderStatus so
  // buyer-facing order history (OrdersPage.tsx) stays in sync without
  // needing to separately query order_shipments for every order in a list.
  const mappedOrderStatus = ORDER_STATUS_ON_SHIPMENT[normalizedStatus];
  if (mappedOrderStatus) {
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, shipment.orderId)).limit(1);
    if (order && order.orderStatus !== "cancelled" && order.orderStatus !== mappedOrderStatus) {
      await db
        .update(ordersTable)
        .set({ orderStatus: mappedOrderStatus, updatedAt: new Date() })
        .where(eq(ordersTable.id, order.id));

      try {
        const [userRow] = await db
          .select({ email: usersTable.email, firstName: usersTable.firstName, lastName: usersTable.lastName })
          .from(usersTable)
          .where(eq(usersTable.clerkId, order.userId))
          .limit(1);
        if (userRow?.email && !userRow.email.endsWith("@clerk.user")) {
          const name = [userRow.firstName, userRow.lastName].filter(Boolean).join(" ") || "Customer";
          await sendOrderStatusUpdate({
            to: userRow.email,
            name,
            orderId: order.id,
            trackingId: order.trackingId,
            newStatus: mappedOrderStatus,
          }).catch(() => {});
        }
      } catch {
        /* non-blocking */
      }
    }
  }

  return { ok: true, orderId: shipment.orderId, statusUpdated: true };
}

router.post("/webhooks/courier/pathao", async (req, res) => {
  try {
    const result = await handleCourierWebhook("pathao", req.body);
    res.json(result);
  } catch (err) {
    console.error("[courier-webhook:pathao] error:", err);
    res.status(500).json({ ok: false });
  }
});

router.post("/webhooks/courier/steadfast", async (req, res) => {
  try {
    const result = await handleCourierWebhook("steadfast", req.body);
    res.json(result);
  } catch (err) {
    console.error("[courier-webhook:steadfast] error:", err);
    res.status(500).json({ ok: false });
  }
});

export default router;
