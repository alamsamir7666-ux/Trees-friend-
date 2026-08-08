import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { db } from "@workspace/db";
import { orderShipmentsTable, ordersTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getCourierAdapter } from "../lib/courierAdapters";
import { sendOrderStatusUpdate } from "../lib/email";
import { attemptSellerPayout } from "../lib/payouts";

/**
 * Shared normalized webhook endpoints (plan doc §8: "/webhooks/courier/pathao,
 * /webhooks/courier/steadfast"). Not registered in openapi.yaml -- external
 * webhook receivers aren't part of our typed client.
 *
 * SECURITY (previously an open gap -- see git history / PART4B_HANDOFF.md
 * for the prior unauthenticated state): both routes below now require a
 * shared secret before any DB lookup happens, via `requireCourierWebhookSecret`.
 * On top of that shared-secret floor, Pathao additionally gets real
 * signature verification:
 *
 *  - Pathao: dashboard-configured webhook secret is sent back verbatim on
 *    every webhook request as the `X-PATHAO-Signature` header (confirmed
 *    against Pathao's own WooCommerce plugin source and merchant blog post
 *    describing the "Webhook Integration" secret field -- see
 *    verifyPathaoSignature below). Checked with a constant-time compare.
 *  - Steadfast: Steadfast's own API docs (portal.packzy.com) don't
 *    document an official webhook-signing convention. Community packages
 *    consistently implement an `Authorization: Bearer <token>` check
 *    against a merchant-configured token instead (not an official Steadfast
 *    feature, just the de facto pattern every integration converges on) --
 *    supported here as STEADFAST_WEBHOOK_BEARER_TOKEN, optional, layered on
 *    top of (not instead of) the mandatory shared secret below.
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

const COURIER_WEBHOOK_SECRET = process.env.COURIER_WEBHOOK_SECRET;

if (!COURIER_WEBHOOK_SECRET) {
  // Fail loudly at startup rather than silently accepting unauthenticated
  // courier webhooks -- same convention as MOBILE_JWT_SECRET
  // (middlewares/mobileJwt.ts) and CREDENTIAL_ENCRYPTION_KEY
  // (lib/credentialEncryption.ts).
  throw new Error(
    "COURIER_WEBHOOK_SECRET environment variable is not set. Generate one with " +
      "`openssl rand -base64 32` and configure the SAME value as the secret " +
      "path segment / header on both the Pathao and Steadfast webhook URLs " +
      "registered with each courier.",
  );
}

/** Constant-time string compare, safe for secrets of different lengths (unlike `a === b`, which short-circuits on length and leaks timing info). */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run timingSafeEqual against a same-length buffer so a
    // length mismatch doesn't return faster than a content mismatch.
    timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Shared-secret floor for BOTH courier webhooks, checked before any DB
 * lookup. Accepts the secret via EITHER:
 *   - `X-Courier-Webhook-Secret` header, or
 *   - `?secret=` query param (couriers' dashboards typically only let you
 *     configure a URL, not custom headers, so a query param keeps this
 *     usable from a plain "Callback URL" field; still transmitted over
 *     HTTPS only, same as any URL-embedded token).
 * Rejects with 401 before the request reaches handleCourierWebhook() at
 * all -- no shipment/order lookup, no DB write, on a failed check.
 */
function requireCourierWebhookSecret(req: ApiRequest, res: any, next: any) {
  const provided = req.get("X-Courier-Webhook-Secret") ?? req.query.secret;
  if (typeof provided !== "string" || !safeCompare(provided, COURIER_WEBHOOK_SECRET as string)) {
    res.status(401).json({ ok: false, reason: "unauthorized" });
    return;
  }
  next();
}

/**
 * Pathao-specific: verifies the `X-PATHAO-Signature` header against the
 * per-merchant webhook secret configured in the Pathao Merchant Dashboard
 * (Developer API > Webhook Integration). Pathao sends this secret back
 * verbatim on every webhook call (not an HMAC of the body -- confirmed
 * against Pathao's own WooCommerce plugin source, which does a direct
 * string compare, and Pathao's merchant blog describing the dashboard
 * "Callback URL + Secret" field). Optional: only enforced if
 * PATHAO_WEBHOOK_SECRET is set, since the mandatory shared secret above
 * already covers this route either way.
 */
function verifyPathaoSignature(req: ApiRequest): boolean {
  const configured = process.env.PATHAO_WEBHOOK_SECRET;
  if (!configured) return true; // not configured -- shared secret above still applies
  const signature = req.get("X-PATHAO-Signature");
  return typeof signature === "string" && safeCompare(signature, configured);
}

/**
 * Steadfast-specific: verifies an `Authorization: Bearer <token>` header
 * against a merchant-configured token. Not an officially documented
 * Steadfast feature (their API docs don't describe a webhook-auth
 * convention) -- this follows the pattern several community Steadfast
 * integration packages use. Optional: only enforced if
 * STEADFAST_WEBHOOK_BEARER_TOKEN is set, since the mandatory shared secret
 * above already covers this route either way.
 */
function verifySteadfastBearerToken(req: ApiRequest): boolean {
  const configured = process.env.STEADFAST_WEBHOOK_BEARER_TOKEN;
  if (!configured) return true; // not configured -- shared secret above still applies
  const header = req.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  return typeof token === "string" && safeCompare(token, configured);
}

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
    logger.info({ provider, trackingId }, "courier-webhook: no shipment found for tracking id");
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
    logger.info({ provider, payload }, "courier-webhook: unrecognized status, stored raw only");
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
      } catch (err) {
        logger.error({ err }, "Route handler error");
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
          logger.error({ err, orderId: order.id, provider }, "courier-webhook: unexpected error in attemptSellerPayout");
        }
      }
    }
  }

  return { ok: true, orderId: shipment.orderId, statusUpdated: true };
}

router.post("/webhooks/courier/pathao", requireCourierWebhookSecret, async (req, res) => {
  if (!verifyPathaoSignature(req)) {
    res.status(401).json({ ok: false, reason: "unauthorized" });
    return;
  }
  try {
    const result = await handleCourierWebhook("pathao", req.body);
    res.json(result);
  } catch (err) {
    logger.error({ err: err }, "[courier-webhook:pathao] error");
    res.status(500).json({ ok: false });
  }
});

router.post("/webhooks/courier/steadfast", requireCourierWebhookSecret, async (req, res) => {
  if (!verifySteadfastBearerToken(req)) {
    res.status(401).json({ ok: false, reason: "unauthorized" });
    return;
  }
  try {
    const result = await handleCourierWebhook("steadfast", req.body);
    res.json(result);
  } catch (err) {
    logger.error({ err: err }, "[courier-webhook:steadfast] error");
    res.status(500).json({ ok: false });
  }
});
import { logger } from "../lib/logger";
import type { ApiRequest } from "../types/apiRequest";

export default router;
