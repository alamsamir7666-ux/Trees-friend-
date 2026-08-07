import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import { orderShipmentsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { authHeader } from "./authHelper";
import {
  cleanupAll,
  seedCategory,
  seedProduct,
  seedSeller,
  seedUser,
  seedListing,
  seedOrder,
  seedVerifiedCourierConfig,
} from "./testDb";
import { installSteadfastFetchStub, uninstallSteadfastFetchStub } from "./fetchStub";

describe("order-shipments routes (HTTP)", () => {
  let sellerClerkId: string;
  let sellerId: number;
  let otherSellerClerkId: string;
  let otherSellerId: number;
  let buyerClerkId: string;
  let productId: number;
  let listingId: number;

  beforeAll(async () => {
    await cleanupAll();
    const category = await seedCategory();
    const product = await seedProduct(category.id);
    productId = product.id;

    const { user, seller } = await seedSeller({
      clerkIdSuffix: "shipments-seller",
      email: "shipments-seller@test.example",
      businessName: "Shipments Test Nursery",
    });
    sellerClerkId = user.clerkId;
    sellerId = seller.id;

    const other = await seedSeller({
      clerkIdSuffix: "shipments-other-seller",
      email: "shipments-other-seller@test.example",
      businessName: "Other Seller Nursery",
    });
    otherSellerClerkId = other.user.clerkId;
    otherSellerId = other.seller.id;

    const listing = await seedListing({ productId, sellerId });
    listingId = listing.id;

    buyerClerkId = (await seedUser({ clerkIdSuffix: "shipments-buyer", email: "shipments-buyer@test.example" })).clerkId;
  });

  afterAll(async () => {
    await cleanupAll();
  });

  describe("401/403 gating", () => {
    it("401s GET /api/seller/orders/:orderId/shipment with no auth", async () => {
      const res = await request(app).get("/api/seller/orders/1/shipment");
      expect(res.status).toBe(401);
    });

    it("403s a buyer (non-seller) hitting a seller-only shipment route", async () => {
      const res = await request(app)
        .get("/api/seller/orders/1/shipment")
        .set(authHeader(buyerClerkId, "shipments-buyer@test.example"));
      expect(res.status).toBe(403);
    });

    it("403s a seller trying to book courier for an order they don't own", async () => {
      const order = await seedOrder({ userIdClerk: buyerClerkId, sellerId, listingId, productId });
      const res = await request(app)
        .post(`/api/seller/orders/${order.id}/book-courier`)
        .set(authHeader(otherSellerClerkId, "shipments-other-seller@test.example"))
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/don't own this order/i);
    });
  });

  describe("book-courier: no config / unverified config", () => {
    it("400s booking with no courier config at all", async () => {
      const order = await seedOrder({ userIdClerk: buyerClerkId, sellerId, listingId, productId });
      const res = await request(app)
        .post(`/api/seller/orders/${order.id}/book-courier`)
        .set(authHeader(sellerClerkId, "shipments-seller@test.example"))
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no courier account configured/i);
    });

    it("400s booking with a courier config that exists but isn't verified", async () => {
      // Insert an unverified config directly (bypassing the admin verify
      // step, same convention as seedVerifiedCourierConfig).
      const { sellerCourierConfigsTable } = await import("@workspace/db/schema");
      await db.insert(sellerCourierConfigsTable).values({
        sellerId,
        provider: "steadfast",
        apiKey: "k",
        apiSecret: "s",
        isVerified: false,
      });

      const order = await seedOrder({ userIdClerk: buyerClerkId, sellerId, listingId, productId });
      const res = await request(app)
        .post(`/api/seller/orders/${order.id}/book-courier`)
        .set(authHeader(sellerClerkId, "shipments-seller@test.example"))
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/hasn't been verified yet/i);

      await db.delete(sellerCourierConfigsTable).where(eq(sellerCourierConfigsTable.sellerId, sellerId));
    });
  });

  describe("book-courier happy path (Steadfast fetch stubbed -- see fetchStub.ts)", () => {
    beforeEach(() => installSteadfastFetchStub());
    afterEach(() => uninstallSteadfastFetchStub());

    it("books a courier successfully and persists a real order_shipments row", async () => {
      await seedVerifiedCourierConfig(sellerId, "steadfast");
      const order = await seedOrder({ userIdClerk: buyerClerkId, sellerId, listingId, productId });

      const res = await request(app)
        .post(`/api/seller/orders/${order.id}/book-courier`)
        .set(authHeader(sellerClerkId, "shipments-seller@test.example"))
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.orderId).toBe(order.id);
      expect(res.body.courierProvider).toBe("steadfast");
      expect(res.body.courierTrackingId).toMatch(/^TEST-CONSIGNMENT-/);

      const rows = await db.select().from(orderShipmentsTable).where(eq(orderShipmentsTable.orderId, order.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].courierTrackingId).toBe(res.body.courierTrackingId);

      const { sellerCourierConfigsTable } = await import("@workspace/db/schema");
      await db.delete(sellerCourierConfigsTable).where(eq(sellerCourierConfigsTable.sellerId, sellerId));
    });

    it("400s a second booking attempt once a tracking id already exists", async () => {
      await seedVerifiedCourierConfig(sellerId, "steadfast");
      const order = await seedOrder({ userIdClerk: buyerClerkId, sellerId, listingId, productId });

      const first = await request(app)
        .post(`/api/seller/orders/${order.id}/book-courier`)
        .set(authHeader(sellerClerkId, "shipments-seller@test.example"))
        .send({});
      expect(first.status).toBe(201);

      const second = await request(app)
        .post(`/api/seller/orders/${order.id}/book-courier`)
        .set(authHeader(sellerClerkId, "shipments-seller@test.example"))
        .send({});
      expect(second.status).toBe(400);
      expect(second.body.error).toMatch(/already has a courier booking/i);

      const { sellerCourierConfigsTable } = await import("@workspace/db/schema");
      await db.delete(sellerCourierConfigsTable).where(eq(sellerCourierConfigsTable.sellerId, sellerId));
    });
  });

  describe("manual shipment-status update", () => {
    it("happy path: seller sets a manual status with no courier config at all", async () => {
      const order = await seedOrder({ userIdClerk: buyerClerkId, sellerId, listingId, productId });
      const res = await request(app)
        .put(`/api/seller/orders/${order.id}/shipment-status`)
        .set(authHeader(sellerClerkId, "shipments-seller@test.example"))
        .send({ status: "picked_up" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("picked_up");
      expect(res.body.courierProvider).toBe("manual");

      const rows = await db.select().from(orderShipmentsTable).where(eq(orderShipmentsTable.orderId, order.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("picked_up");
    });

    it("400s an invalid status value", async () => {
      const order = await seedOrder({ userIdClerk: buyerClerkId, sellerId, listingId, productId });
      const res = await request(app)
        .put(`/api/seller/orders/${order.id}/shipment-status`)
        .set(authHeader(sellerClerkId, "shipments-seller@test.example"))
        .send({ status: "not_a_real_status" });
      expect(res.status).toBe(400);
    });
  });

  describe("buyer-facing GET /api/orders/:orderId/shipment", () => {
    it("401s with no auth", async () => {
      const res = await request(app).get("/api/orders/1/shipment");
      expect(res.status).toBe(401);
    });

    it("404s for an order belonging to a different buyer", async () => {
      const order = await seedOrder({ userIdClerk: buyerClerkId, sellerId, listingId, productId });
      const otherBuyerClerkId = (await seedUser({ clerkIdSuffix: "shipments-other-buyer", email: "shipments-other-buyer@test.example" })).clerkId;

      const res = await request(app)
        .get(`/api/orders/${order.id}/shipment`)
        .set(authHeader(otherBuyerClerkId, "shipments-other-buyer@test.example"));
      expect(res.status).toBe(404);
    });

    it("returns null (not 404) for the buyer's own order that has no shipment yet", async () => {
      const order = await seedOrder({ userIdClerk: buyerClerkId, sellerId, listingId, productId });
      const res = await request(app)
        .get(`/api/orders/${order.id}/shipment`)
        .set(authHeader(buyerClerkId, "shipments-buyer@test.example"));
      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });
  });

  /**
   * THE centerpiece test: Part 2's actual fix (order_shipments.order_id's
   * DB-level unique constraint) exercised through two REAL concurrent HTTP
   * requests to the real book-courier route -- not a direct duplicate
   * INSERT against the table, which is what every prior verification of
   * this fix (verify-seller-marketplace.ts, and Part 2's own throwaway
   * proof script per PART2_HANDOFF.md) has done instead.
   *
   * ADDENDUM (found during Part 3 re-verification, fixed here): the first
   * version of this test fired two Promise.all'd requests with no
   * synchronization and asserted "one 201, one 400-or-500". That passed,
   * but for the wrong reason -- measured across 8 runs, the outcome was
   * always exactly one 201 and one 400, NEVER a 500. Instrumenting both
   * responses directly confirmed why: one request's entire SELECT ->
   * fetch -> INSERT -> commit cycle finished before the other's initial
   * "does a shipment already exist" SELECT even ran. The route's own
   * pre-check caught the duplicate every time; the DB-level unique
   * constraint added in Part 2 was never actually reached by either
   * request in any of those runs. Deleting the constraint entirely and
   * re-running confirmed this: the test still passed, unchanged --
   * meaning the original version tested the wrong layer and would not
   * have caught a regression to Part 2's fix.
   *
   * Fixed by using fetchStub's barrier option: both requests now block
   * inside adapter.bookShipment()'s stubbed fetch call until BOTH have
   * arrived, then release together. This guarantees both requests pass
   * their "existingShipment" SELECT (finding nothing, since neither has
   * inserted yet) before either proceeds to INSERT -- the actual race
   * window routes/orderShipments.ts's own doc comment describes. Now the
   * database constraint, not request ordering, decides which INSERT wins.
   */
  describe("book-courier concurrent-request race (Part 2's order_shipments unique-constraint fix, tested through the HTTP layer for the first time)", () => {
    afterEach(() => uninstallSteadfastFetchStub());

    it("exactly one of two simultaneous book-courier requests for the same order succeeds, and the DB ends with exactly one shipment row", async () => {
      installSteadfastFetchStub({ barrier: 2 });
      await seedVerifiedCourierConfig(sellerId, "steadfast");
      const order = await seedOrder({ userIdClerk: buyerClerkId, sellerId, listingId, productId });

      const fireRequest = () =>
        request(app)
          .post(`/api/seller/orders/${order.id}/book-courier`)
          .set(authHeader(sellerClerkId, "shipments-seller@test.example"))
          .send({});

      // Fired together, not awaited one at a time. With the barrier above,
      // both requests are now guaranteed to reach adapter.bookShipment()'s
      // stubbed fetch (i.e. to have already passed their own
      // "existingShipment" SELECT finding nothing) before either resolves
      // and proceeds to INSERT -- so this genuinely exercises the DB
      // constraint deciding the outcome, not request ordering.
      const [resA, resB] = await Promise.all([fireRequest(), fireRequest()]);

      const statuses = [resA.status, resB.status].sort();
      // One request should succeed (201, first INSERT to commit), and the
      // other should fail with a 500 surfaced by the route's generic
      // catch block wrapping the unique-constraint violation -- both
      // requests already passed the "already booked" 400 pre-check before
      // the barrier released them, so 400 is no longer a possible outcome
      // for the loser here; only the DB constraint is left to stop it.
      const successCount = statuses.filter((s) => s === 201).length;
      expect(successCount).toBe(1);
      expect(statuses.filter((s) => s === 500)).toHaveLength(1);

      // The real assertion: the database, not the HTTP responses, is the
      // source of truth. Exactly one order_shipments row must exist for
      // this order no matter how the two requests' responses came back.
      const rows = await db.select().from(orderShipmentsTable).where(eq(orderShipmentsTable.orderId, order.id));
      expect(rows).toHaveLength(1);

      const { sellerCourierConfigsTable } = await import("@workspace/db/schema");
      await db.delete(sellerCourierConfigsTable).where(eq(sellerCourierConfigsTable.sellerId, sellerId));
    });
  });
});
