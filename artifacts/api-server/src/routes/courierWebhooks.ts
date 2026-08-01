import { Router } from "express";
import { db } from "@workspace/db";
import { orderShipmentsTable, ordersTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getCourierAdapter } from "../lib/courierAdapters";
import { sendOrderStatusUpdate } from "../lib/email";
import { attemptSellerPayout } from "../lib/payouts";

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
 *
 * PART 3 ADDENDUM (see PART3_HANDOFF.md): this file's existing delivered-
 * transition branch (the block guarded by `mappedOrderStatus` and the
 * cancelled/already-set check below) also triggers a seller PAYOUT
 * attempt via `attemptSellerPayout()` -- extending this SAME function
 * rather than adding a new webhook or polling mechanism, per the Part 3
 * prompt's explicit instruction. Follows this file's own existing
 * non-blocking-side-effect precedent (the email-sending block a few lines
 * below `attemptSellerPayout()`'s call site): a payout failure must never
 * throw out of `handleCourierWebhook()` and break the courier's own `{ ok:
 * true, ... }` response, since the courier doesn't care about our internal
 * payout bookkeeping.
 *
 * PART 4 ADDENDUM (see PART4_HANDOFF.md): `attemptSellerPayout()` itself
 * has moved to `../lib/payouts.ts` (behavior unchanged, see that file's
 * own doc comment) so the new admin manual-retry route
 * (`POST /admin/payouts/:id/retry` in routes/admin.ts) can call the exact
 * same guard/insert/disburse logic this webhook already used, rather than
 * a second near-identical implementation being written. This file's own
 * call site and try/catch wrapping below is otherwise untouched.
 */

const router = Router();

const ORDER_STATUS_ON_SHIPMENT: Record<string, string | undefined> = {
  picked_up: "shipped",
  in_transit: "shipped",
  delivered: "delivered",
};

// attemptSellerPayout() used to be defined in this file (Part 3). Part 4
// EXTRACTED it, unchanged in behavior, to ../lib/payouts.ts so the new
// admin manual-retry route (routes/admin.ts's
// `POST /admin/payouts/:id/retry`) can call the exact same guard/insert/
// disburse logic instead of a second near-identical implementation being
// written. See that file's own doc comment for the full guard-order and
// retry-policy reasoning (byte-for-byte the same as Part 3's original,
// just moved) -- imported above as `attemptSellerPayout`.

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

      // PART 3: trigger a seller payout attempt, but ONLY on the specific
      // "delivered" transition -- not "shipped" (picked_up/in_transit both
      // also map through mappedOrderStatus, but only "delivered" is a
      // payout trigger; see ORDER_STATUS_ON_SHIPMENT above). Wrapped in its
      // own try/catch, matching this file's own existing precedent for the
      // email block immediately above -- a payout failure must never
      // surface as a 500 to the courier, since the courier doesn't care
      // about our internal payout bookkeeping (attemptSellerPayout() itself
      // already catches and records bKash-side failures into payoutsTable
      // rather than throwing; this outer catch is a last-resort guard
      // against something unexpected, e.g. a DB error on the very first
      // insert, so even that can't break the courier's response).
      if (mappedOrderStatus === "delivered") {
        try {
          await attemptSellerPayout(order);
        } catch (err) {
          console.error(`[courier-webhook:${provider}] Unexpected error in attemptSellerPayout for order ${order.id}:`, err);
        }
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
