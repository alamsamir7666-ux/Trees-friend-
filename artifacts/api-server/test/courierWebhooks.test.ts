import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import { orderShipmentsTable, ordersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { cleanupAll, seedCategory, seedProduct, seedSeller, seedUser, seedListing, seedOrder } from "./testDb";

/**
 * HTTP-level coverage for routes/courierWebhooks.ts -- this route has never
 * been tested before this session. It receives external, unauthenticated
 * input from Pathao and Steadfast.
 *
 * SECURITY POSTURE, confirmed independently (not copied from the route's own
 * doc comment): re-reading routes/index.ts confirms this router is mounted
 * exactly like every other route (`router.use(courierWebhooksRouter)`), with
 * no requireAuth/requireSeller/requireAdmin wrapping it, no shared-secret
 * header check, and no signature verification of any kind in the handler
 * itself. The doc comment's claim is accurate. Independent conclusion: this
 * is a real, currently-open gap -- anyone who can reach this endpoint can
 * flip any order's shipment status (and, for delivered/in_transit-mapped
 * statuses, the parent order's buyer-facing orderStatus) for ANY order in
 * the system, as long as they know or can guess a courierTrackingId. Whether
 * that's an acceptable risk depends on how guessable/enumerable
 * courierTrackingId values are in production (they're assigned by Pathao/
 * Steadfast, not sequential ints from this app's own DB, which raises the
 * bar somewhat -- but "somewhat harder to guess" is not authentication).
 * Not fixed here per the task brief: a real fix (shared-secret header,
 * IP allowlist, or provider-specific signature verification once Pathao/
 * Steadfast dashboards are confirmed to expose one) is out of scope for a
 * testing-only session and deserves its own reviewed change.
 *
 * Body-parsing behavior confirmed directly (not assumed) before writing
 * assertions below: express.json() runs BEFORE this route and, with its
 * default `strict: true`, rejects any top-level JSON value that isn't an
 * object or array (bare strings/numbers/null, and malformed JSON syntax)
 * by throwing synchronously -- caught by app.ts's global error handler, NOT
 * this route's own try/catch. That produces a 500 with the parser's raw
 * error message in the body, which is a DIFFERENT contract than the route's
 * own `{ ok: false, reason }` 200-on-logical-failure shape. A bare JSON
 * array, by contrast, passes the parser's strict check (arrays count as
 * "objects" for that purpose) and reaches the route as `req.body`, where
 * extractTrackingId's `typeof payload === "object"` check also passes
 * (arrays are objects in JS) but finds no `consignment_id` field, so it
 * falls through cleanly to this route's own `no_tracking_id` 200 contract.
 */
describe("courier-webhooks routes (HTTP)", () => {
  let sellerId: number;
  let buyerClerkId: string;
  let productId: number;
  let listingId: number;

  beforeAll(async () => {
    await cleanupAll();
    const category = await seedCategory();
    const product = await seedProduct(category.id);
    productId = product.id;

    const { seller } = await seedSeller({
      clerkIdSuffix: "courierwebhook-seller",
      email: "courierwebhook-seller@test.example",
      businessName: "Courier Webhook Nursery",
    });
    sellerId = seller.id;

    const listing = await seedListing({ productId, sellerId });
    listingId = listing.id;

    buyerClerkId = (await seedUser({ clerkIdSuffix: "courierwebhook-buyer", email: "courierwebhook-buyer@test.example" })).clerkId;
  });

  afterAll(async () => {
    await cleanupAll();
  });

  /** Creates an order + a "manual" order_shipments row with the given courierTrackingId, for a fresh order each call. */
  async function seedOrderWithShipment(opts: { courierTrackingId: string; orderStatus?: string }) {
    const order = await seedOrder({ userIdClerk: buyerClerkId, sellerId, listingId, productId });
    if (opts.orderStatus) {
      await db.update(ordersTable).set({ orderStatus: opts.orderStatus }).where(eq(ordersTable.id, order.id));
    }
    const [shipment] = await db
      .insert(orderShipmentsTable)
      .values({
        orderId: order.id,
        courierProvider: "pathao",
        courierTrackingId: opts.courierTrackingId,
        status: "pending",
      })
      .returning();
    return { order, shipment };
  }

  function uniqueTrackingId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  describe("security posture, confirmed not assumed", () => {
    it("accepts a request with no auth headers at all (route is genuinely unauthenticated)", async () => {
      const trackingId = uniqueTrackingId("SEC-NOAUTH");
      const { order } = await seedOrderWithShipment({ courierTrackingId: trackingId });

      const res = await request(app)
        .post("/api/webhooks/courier/pathao")
        .send({ consignment_id: trackingId, order_status: "Delivered" });

      // No Authorization header, no API key, no signature -- and it's
      // accepted and processed. This pins down the current (unauthenticated)
      // behavior; it is not an endorsement of it.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, orderId: order.id, statusUpdated: true });
    });

    it("accepts a request with garbage/irrelevant headers (they're silently ignored, not validated)", async () => {
      const trackingId = uniqueTrackingId("SEC-GARBAGE-HEADERS");
      await seedOrderWithShipment({ courierTrackingId: trackingId });

      const res = await request(app)
        .post("/api/webhooks/courier/pathao")
        .set("Authorization", "Bearer totally-made-up-token")
        .set("X-Webhook-Signature", "not-a-real-signature")
        .set("X-Api-Key", "not-a-real-key")
        .send({ consignment_id: trackingId, order_status: "Delivered" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("a wrong-shaped payload (valid JSON object, none of the expected fields) is rejected via the route's own 200/ok:false contract, not a 500", async () => {
      const res = await request(app)
        .post("/api/webhooks/courier/pathao")
        .send({ totally: "unexpected", shape: 123 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, reason: "no_tracking_id" });
    });
  });

  describe("valid Pathao webhook payloads", () => {
    it.each([
      { pathaoStatus: "Delivered", expectShipmentStatus: "delivered", expectOrderStatus: "delivered" },
      { pathaoStatus: "In_Transit", expectShipmentStatus: "in_transit", expectOrderStatus: "shipped" },
      { pathaoStatus: "Picked", expectShipmentStatus: "picked_up", expectOrderStatus: "shipped" },
      { pathaoStatus: "Return", expectShipmentStatus: "returned", expectOrderStatus: null },
    ])(
      "POST /api/webhooks/courier/pathao with order_status=$pathaoStatus updates shipment status, rawWebhookPayload, lastSyncedAt, and orderStatus ($expectOrderStatus)",
      async ({ pathaoStatus, expectShipmentStatus, expectOrderStatus }) => {
        const trackingId = uniqueTrackingId(`PATHAO-${pathaoStatus}`);
        const { order, shipment } = await seedOrderWithShipment({ courierTrackingId: trackingId });
        const payload = { consignment_id: trackingId, order_status: pathaoStatus, merchant_order_id: String(order.id) };

        const res = await request(app).post("/api/webhooks/courier/pathao").send(payload);

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.orderId).toBe(order.id);

        const [row] = await db.select().from(orderShipmentsTable).where(eq(orderShipmentsTable.id, shipment.id));
        expect(row.status).toBe(expectShipmentStatus);
        expect(row.rawWebhookPayload).toEqual(payload);
        expect(row.lastSyncedAt).not.toBeNull();

        const [updatedOrder] = await db.select().from(ordersTable).where(eq(ordersTable.id, order.id));
        if (expectOrderStatus) {
          expect(updatedOrder.orderStatus).toBe(expectOrderStatus);
        } else {
          // "returned" has no entry in ORDER_STATUS_ON_SHIPMENT, so the
          // order's own orderStatus is deliberately left untouched.
          expect(updatedOrder.orderStatus).toBe("pending");
        }
      },
    );

    /**
     * MUTATION-TESTED (per task brief): this guard --
     * `order.orderStatus !== "cancelled"` in courierWebhooks.ts -- is exactly
     * the kind of branch that looks covered by a happy-path test but isn't.
     * Proof of the mutation test is recorded in PART4B_HANDOFF.md (removed
     * the guard locally, reran this exact test, confirmed it failed with the
     * order flipping to "shipped"; restored the guard, reran, confirmed it
     * passed again). The test below is the guard's real, permanent coverage.
     */
    it("does NOT overwrite orderStatus for an order that's already 'cancelled', even on a status-mapped webhook (mutation-tested guard)", async () => {
      const trackingId = uniqueTrackingId("PATHAO-CANCELLED-GUARD");
      const { order, shipment } = await seedOrderWithShipment({ courierTrackingId: trackingId, orderStatus: "cancelled" });

      const res = await request(app)
        .post("/api/webhooks/courier/pathao")
        .send({ consignment_id: trackingId, order_status: "Delivered" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, orderId: order.id, statusUpdated: true });

      // The shipment row itself IS still updated (the guard only protects
      // the parent order's orderStatus, not the shipment tracking data).
      const [shipmentRow] = await db.select().from(orderShipmentsTable).where(eq(orderShipmentsTable.id, shipment.id));
      expect(shipmentRow.status).toBe("delivered");

      // The order's orderStatus must remain "cancelled" -- this is the
      // actual guard under test.
      const [orderRow] = await db.select().from(ordersTable).where(eq(ordersTable.id, order.id));
      expect(orderRow.orderStatus).toBe("cancelled");
    });
  });

  describe("valid Steadfast webhook payloads", () => {
    it.each([
      { steadfastStatus: "delivered", expectShipmentStatus: "delivered", expectOrderStatus: "delivered" },
      { steadfastStatus: "DELIVERED", expectShipmentStatus: "delivered", expectOrderStatus: "delivered" }, // case-insensitive
      { steadfastStatus: "cancelled", expectShipmentStatus: "failed", expectOrderStatus: null },
      { steadfastStatus: "hold", expectShipmentStatus: "pending", expectOrderStatus: null },
    ])(
      "POST /api/webhooks/courier/steadfast with status=$steadfastStatus updates shipment status and orderStatus ($expectOrderStatus) accordingly",
      async ({ steadfastStatus, expectShipmentStatus, expectOrderStatus }) => {
        const trackingId = uniqueTrackingId(`STEADFAST-${steadfastStatus}`);
        const { order, shipment } = await seedOrderWithShipment({ courierTrackingId: trackingId });
        const payload = { consignment_id: trackingId, status: steadfastStatus };

        const res = await request(app).post("/api/webhooks/courier/steadfast").send(payload);

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const [row] = await db.select().from(orderShipmentsTable).where(eq(orderShipmentsTable.id, shipment.id));
        expect(row.status).toBe(expectShipmentStatus);
        expect(row.rawWebhookPayload).toEqual(payload);

        const [updatedOrder] = await db.select().from(ordersTable).where(eq(ordersTable.id, order.id));
        expect(updatedOrder.orderStatus).toBe(expectOrderStatus ?? "pending");
      },
    );

    it("reads tracking_code as a fallback tracking-id field (not just consignment_id)", async () => {
      const trackingId = uniqueTrackingId("STEADFAST-TRACKCODE");
      const { shipment } = await seedOrderWithShipment({ courierTrackingId: trackingId });

      const res = await request(app)
        .post("/api/webhooks/courier/steadfast")
        .send({ tracking_code: trackingId, status_type: "delivered" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const [row] = await db.select().from(orderShipmentsTable).where(eq(orderShipmentsTable.id, shipment.id));
      expect(row.status).toBe("delivered");
    });

    it("reads cid as a fallback tracking-id field", async () => {
      const trackingId = uniqueTrackingId("STEADFAST-CID");
      const { shipment } = await seedOrderWithShipment({ courierTrackingId: trackingId });

      const res = await request(app).post("/api/webhooks/courier/steadfast").send({ cid: trackingId, delivery_status: "delivered" });

      expect(res.status).toBe(200);
      const [row] = await db.select().from(orderShipmentsTable).where(eq(orderShipmentsTable.id, shipment.id));
      expect(row.status).toBe("delivered");
    });
  });

  describe("malformed / garbage payloads", () => {
    it("a non-object top-level JSON body (bare string) is rejected by express.json()'s strict parser with a 500, BEFORE reaching this route's own ok:false contract", async () => {
      const res = await request(app)
        .post("/api/webhooks/courier/pathao")
        .set("Content-Type", "application/json")
        .send('"just a string"');
      expect(res.status).toBe(500);
      // Confirmed distinct from the route's own contract: this is Express's
      // JSON body-parser error, not { ok: false, reason: ... }.
      expect(res.body.reason).toBeUndefined();
    });

    it("an empty body with no Content-Type is treated as {} by express.json() and reaches the route's own no_tracking_id contract (200, not 500)", async () => {
      const res = await request(app).post("/api/webhooks/courier/pathao");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, reason: "no_tracking_id" });
    });

    it("wrong-typed consignment_id field (an object, not a string/number) does not crash the route", async () => {
      const res = await request(app)
        .post("/api/webhooks/courier/pathao")
        .send({ consignment_id: { nested: "object" }, order_status: "Delivered" });
      // extractTrackingId does `String(id)` on whatever it finds, so this
      // still produces A tracking id string ("[object Object]") -- just one
      // that won't match any real shipment. Confirming the actual contract
      // here rather than assuming a 400.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, reason: "no_matching_shipment" });
    });

    it("an unrecognized status string with a real, matching tracking id stores the raw payload but leaves status/orderStatus untouched", async () => {
      const trackingId = uniqueTrackingId("PATHAO-BOGUS-STATUS");
      const { order, shipment } = await seedOrderWithShipment({ courierTrackingId: trackingId });

      const res = await request(app)
        .post("/api/webhooks/courier/pathao")
        .send({ consignment_id: trackingId, order_status: "Some_Status_Pathao_Has_Never_Documented" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, orderId: order.id, statusUpdated: false });

      const [row] = await db.select().from(orderShipmentsTable).where(eq(orderShipmentsTable.id, shipment.id));
      expect(row.status).toBe("pending"); // unchanged from seed default
      expect(row.rawWebhookPayload).toBeTruthy(); // still stored, per the route's own doc comment

      const [orderRow] = await db.select().from(ordersTable).where(eq(ordersTable.id, order.id));
      expect(orderRow.orderStatus).toBe("pending"); // unchanged
    });

    it("a payload with no tracking-id field at all is rejected cleanly with no DB write", async () => {
      const res = await request(app).post("/api/webhooks/courier/pathao").send({ order_status: "Delivered" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, reason: "no_tracking_id" });
    });
  });

  describe("tracking id with no matching shipment in the DB", () => {
    it("handles gracefully: no crash, no orphan order_shipments row created, returns no_matching_shipment", async () => {
      const before = await db.select().from(orderShipmentsTable);

      const res = await request(app)
        .post("/api/webhooks/courier/steadfast")
        .send({ consignment_id: uniqueTrackingId("NEVER-BOOKED"), status: "delivered" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, reason: "no_matching_shipment" });

      const after = await db.select().from(orderShipmentsTable);
      expect(after.length).toBe(before.length);
    });
  });

  describe("idempotency / duplicate delivery", () => {
    /**
     * MUTATION-TESTED (per task brief): confirms the
     * `order.orderStatus !== mappedOrderStatus` guard at courierWebhooks.ts's
     * call site actually prevents a second identical webhook from re-running
     * the order UPDATE (and, in production, the notification email) -- not
     * just that it looks like it should from reading the code. Mutation-test
     * proof recorded in PART4B_HANDOFF.md: temporarily removed the
     * `!== mappedOrderStatus` half of the guard, reran this test, confirmed
     * it failed (updatedAt changed on the second call); restored the guard,
     * reran, confirmed it passed again.
     */
    it("a second identical 'delivered' webhook for the same shipment does not re-run the order update (order.updatedAt unchanged on the 2nd call)", async () => {
      const trackingId = uniqueTrackingId("IDEMPOTENCY-DELIVERED");
      const { order, shipment } = await seedOrderWithShipment({ courierTrackingId: trackingId });
      const payload = { consignment_id: trackingId, order_status: "Delivered" };

      const first = await request(app).post("/api/webhooks/courier/pathao").send(payload);
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ ok: true, orderId: order.id, statusUpdated: true });

      const [afterFirst] = await db.select().from(ordersTable).where(eq(ordersTable.id, order.id));
      expect(afterFirst.orderStatus).toBe("delivered");
      const updatedAtAfterFirst = afterFirst.updatedAt;

      // Second, identical call for the same shipment/status.
      const second = await request(app).post("/api/webhooks/courier/pathao").send(payload);
      expect(second.status).toBe(200);
      // The route still reports statusUpdated: true, because the SHIPMENT
      // row's status/lastSyncedAt/rawWebhookPayload are unconditionally
      // rewritten every call (there's no idempotency guard at that layer --
      // only the order-level update is guarded). Confirming the real
      // contract, not the one that would be "nicer."
      expect(second.body).toEqual({ ok: true, orderId: order.id, statusUpdated: true });

      const [afterSecond] = await db.select().from(ordersTable).where(eq(ordersTable.id, order.id));
      expect(afterSecond.orderStatus).toBe("delivered");
      // The real assertion: the order's updatedAt must NOT change on the
      // second call, proving the `orderStatus !== mappedOrderStatus` guard
      // actually short-circuited the second UPDATE (and, in production,
      // the notification email at that same call site) rather than just
      // reading that way in the source.
      expect(afterSecond.updatedAt).toEqual(updatedAtAfterFirst);

      // The shipment row's lastSyncedAt SHOULD still advance on the second
      // call (that update is unconditional) -- confirming the two layers'
      // different idempotency behavior isn't accidental.
      const [shipmentRow] = await db.select().from(orderShipmentsTable).where(eq(orderShipmentsTable.id, shipment.id));
      expect(shipmentRow.lastSyncedAt).not.toBeNull();
    });
  });
});
