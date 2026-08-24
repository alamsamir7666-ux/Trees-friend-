import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  cleanupAll,
  seedCategory,
  seedProduct,
  seedSeller,
  seedListing,
  seedOrder,
} from "./testDb";

/**
 * Public order tracking endpoint — PII redaction + rate limiting tests.
 *
 * Verifies the fix for the bug where GET /orders/track/:trackingId returned
 * the full formatOrder() payload including shippingAddress (fullName, phone,
 * street, city, district, postalCode), userId (which leaks the buyer's phone
 * for guests as "guest_<phone>"), senderNumber, giftMessage, transactionId,
 * and paymentSessionId.
 *
 * The fix:
 *   1. Adds a per-route trackOrderLimiter (30/15min/IP) so brute-force
 *      tracking-ID sweeps are impractical.
 *   2. Redacts the response to only what TrackOrderPage UI needs:
 *      trackingId, orderNumber, orderStatus, paymentMethod, paymentStatus,
 *      totalAmount, subtotal, discountAmount, giftWrap, items[], timeline,
 *      and timestamps.
 *
 * The authenticated GET /orders/:id route still returns the full payload
 * (including shippingAddress) because the caller is scoped by req.userId —
 * only the order's owner can read it.
 */
describe("GET /orders/track/:trackingId — PII redaction", () => {
  let sellerId: number;
  let productId: number;
  let listingId: number;
  let trackingId: string;
  let orderId: number;

  beforeAll(async () => {
    await cleanupAll();

    const category = await seedCategory();
    const product = await seedProduct(category.id);
    productId = product.id;

    const { seller } = await seedSeller({
      clerkIdSuffix: "track-order-seller",
      email: "track-order-seller@test.example",
      businessName: "Track Order Nursery",
    });
    sellerId = seller.id;

    const listing = await seedListing({
      productId,
      sellerId,
      price: "500.00",
      availableQuantity: 10,
    });
    listingId = listing.id;

    // Seed an order directly with a known tracking ID + realistic PII in
    // the shipping address. If the redaction is broken, the test will
    // see the PII fields in the response and fail.
    const order = await seedOrder({
      userIdClerk: "httptest_track-order-buyer",
      sellerId,
      listingId,
      productId,
      quantity: 2,
      price: 500,
    });
    trackingId = order.trackingId;
    orderId = order.id;

    // Inject realistic PII into the shippingAddress + gift fields so the
    // redaction test can assert these fields are ABSENT from the public
    // response. seedOrder's default shippingAddress is "Test Buyer" etc.
    await db
      .update(ordersTable)
      .set({
        shippingAddress: {
          fullName: "Real Buyer Name",
          phone: "01711122334",
          street: "45 Secret Road",
          city: "Dhaka",
          district: "Dhaka",
          postalCode: "1207",
        },
        giftWrap: true,
        giftMessage: "Happy birthday, secret recipient!",
        senderNumber: "01711122335",
        transactionId: "bkash-tx-internal-12345",
        paymentSessionId: 998877,
        couponCode: "SECRET-COUPON",
      })
      .where(eq(ordersTable.id, orderId));
  });

  afterAll(async () => {
    await cleanupAll();
  });

  it("returns the order WITHOUT PII fields (redacted)", async () => {
    const res = await request(app).get(`/api/orders/track/${trackingId}`);
    expect(res.status).toBe(200);

    // Fields the public tracking endpoint SHOULD return.
    expect(res.body.trackingId).toBe(trackingId);
    expect(res.body.orderStatus).toBe("pending");
    expect(res.body.paymentMethod).toBe("cod");
    expect(res.body.paymentStatus).toBe("pending");
    expect(res.body.totalAmount).toBe(1000); // 500 * 2
    expect(res.body.subtotal).toBe(1000);
    expect(res.body.discountAmount).toBe(0);
    expect(res.body.giftWrap).toBe(true); // boolean, NOT a PII field
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].productName).toBe("Test Product");
    expect(res.body.items[0].quantity).toBe(2);
    expect(res.body.timeline).toBeDefined();
    expect(Array.isArray(res.body.timeline)).toBe(true);
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.updatedAt).toBeDefined();

    // ── PII FIELDS THAT MUST BE ABSENT ───────────────────────────────
    // If any of these appear in the response, the redaction is broken.
    expect(res.body.shippingAddress).toBeUndefined();
    expect(res.body.userId).toBeUndefined();
    expect(res.body.senderNumber).toBeUndefined();
    expect(res.body.giftMessage).toBeUndefined();
    expect(res.body.transactionId).toBeUndefined();
    expect(res.body.paymentSessionId).toBeUndefined();
    expect(res.body.couponCode).toBeUndefined();
  });

  it("returns 404 for an unknown tracking ID", async () => {
    const res = await request(app).get("/api/orders/track/EEUNKNOWN01");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Order not found");
  });

  it("returns 400 for an invalid tracking ID format", async () => {
    // Contains a hyphen — the regex only allows [A-Z0-9]{2,20}
    const res = await request(app).get("/api/orders/track/has-hyphen");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid tracking ID format");
  });

  it("does NOT leak PII even for 404 (empty body, not the order's PII)", async () => {
    // A 404 should return only { error: "Order not found" } — never echo
    // any other field that might leak through an error path.
    const res = await request(app).get("/api/orders/track/EEUNKNOWN02");
    expect(res.status).toBe(404);
    expect(Object.keys(res.body)).toEqual(["error"]);
  });

  it("does not require authentication (public endpoint)", async () => {
    // No Authorization header — the request should still succeed.
    // This is the design (48-bit random tracking ID is the bearer secret),
    // not a bug. The test documents the intent.
    const res = await request(app).get(`/api/orders/track/${trackingId}`);
    expect(res.status).toBe(200);
  });

  it("includes the 5-step timeline with correct completed flags", async () => {
    const res = await request(app).get(`/api/orders/track/${trackingId}`);
    expect(res.status).toBe(200);

    const timeline = res.body.timeline;
    expect(timeline).toHaveLength(5);
    expect(timeline.map((t: { status: string }) => t.status)).toEqual([
      "pending",
      "confirmed",
      "processing",
      "shipped",
      "delivered",
    ]);
    // Order is in "pending" state — only the first step is completed
    expect(timeline[0].completed).toBe(true);
    expect(timeline[1].completed).toBe(false);
    expect(timeline[4].completed).toBe(false);
  });

  it("includes subtotal so the TrackOrderPage delivery-cost breakdown works", async () => {
    // The page renders Subtotal / Delivery / Total using totalAmount,
    // subtotal, and discountAmount. Without subtotal in the response,
    // the delivery-cost line silently breaks.
    const res = await request(app).get(`/api/orders/track/${trackingId}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.subtotal).toBe("number");
    expect(res.body.subtotal).toBe(res.body.totalAmount); // no discount, no delivery charge
  });
});

/**
 * Rate limiter test — verifies the per-route trackOrderLimiter is wired.
 *
 * We can't actually exhaust 30 requests in a unit test (it'd be slow + flaky
 * against the in-memory fallback), so this test asserts the limiter EXISTS
 * by checking that responses include the X-RateLimit-Limit header (which
 * createRateLimiter sets on every response). The actual 429-enforcement is
 * covered by the limiter's own unit tests in rateLimiter.ts.
 */
describe("GET /orders/track/:trackingId — rate limiter wiring", () => {
  let sellerId: number;
  let productId: number;
  let listingId: number;
  let trackingId: string;

  beforeAll(async () => {
    await cleanupAll();

    const category = await seedCategory();
    const product = await seedProduct(category.id);
    productId = product.id;

    const { seller } = await seedSeller({
      clerkIdSuffix: "track-order-rl-seller",
      email: "track-order-rl-seller@test.example",
      businessName: "Track Order RL Nursery",
    });
    sellerId = seller.id;

    const listing = await seedListing({
      productId,
      sellerId,
      price: "500.00",
      availableQuantity: 10,
    });
    listingId = listing.id;

    const order = await seedOrder({
      userIdClerk: "httptest_track-order-rl-buyer",
      sellerId,
      listingId,
      productId,
    });
    trackingId = order.trackingId;
  });

  afterAll(async () => {
    await cleanupAll();
  });

  it("sets X-RateLimit-* headers (proves the per-route limiter is mounted)", async () => {
    const res = await request(app).get(`/api/orders/track/${trackingId}`);
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    // X-RateLimit-Limit should be "30" (the trackOrderLimiter's max)
    expect(res.headers["x-ratelimit-limit"]).toBe("30");
  });
});
