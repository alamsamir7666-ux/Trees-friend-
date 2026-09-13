import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import { guestOtpsTable, ordersTable, cartItemsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import {
  cleanupAll,
  seedCategory,
  seedProduct,
  seedSeller,
  seedListing,
} from "./testDb";
import { generateAndSend } from "../src/lib/guestOtp";

/**
 * Guest checkout HTTP tests — Part 3 of the Daraz-style guest checkout.
 *
 * Verifies that a phone-verified guest can:
 *   1. Place an order with marketplace items (seller listing variants)
 *   2. Get a multi-seller split if the cart spans multiple sellers
 *   3. See their order history via GET /orders (with guest JWT)
 *   4. View individual order details via GET /orders/:id
 *
 * Flow:
 *   1. Verify a guest phone → get guest JWT
 *   2. Add marketplace items to the server cart (POST /cart/items)
 *   3. Place an order via POST /orders (same endpoint as authenticated users)
 *   4. Verify the response shape + order contents
 *   5. Fetch order history via GET /orders
 *   6. Fetch individual order via GET /orders/:id
 */

const TEST_PHONE = "01700123456";

describe("guest checkout with marketplace items (HTTP)", () => {
  let guestToken: string;
  let productId: number;
  let sellerAId: number;
  let sellerBId: number;
  let listingVariantAId: number;
  let listingVariantBId: number;

  beforeAll(async () => {
    await cleanupAll();

    // Seed: one product, two sellers, each with a listing
    const category = await seedCategory();
    const product = await seedProduct(category.id);
    productId = product.id;

    const { seller: sellerA } = await seedSeller({
      clerkIdSuffix: "guest-checkout-seller-a",
      email: "guest-checkout-a@test.example",
      businessName: "Guest Checkout Nursery A",
    });
    sellerAId = sellerA.id;

    const { seller: sellerB } = await seedSeller({
      clerkIdSuffix: "guest-checkout-seller-b",
      email: "guest-checkout-b@test.example",
      businessName: "Guest Checkout Nursery B",
    });
    sellerBId = sellerB.id;

    const listingA = await seedListing({
      productId,
      sellerId: sellerAId,
      price: "500.00",
      availableQuantity: 10,
    });
    listingVariantAId = listingA._firstVariant.id;

    const listingB = await seedListing({
      productId,
      sellerId: sellerBId,
      price: "300.00",
      availableQuantity: 5,
    });
    listingVariantBId = listingB._firstVariant.id;

    // Verify the guest phone and get a JWT
    const { code } = await generateAndSend(TEST_PHONE);
    const verifyRes = await request(app)
      .post("/api/auth/guest-otp/verify")
      .send({ phone: TEST_PHONE, code });
    guestToken = verifyRes.body.guestToken;
  });

  afterAll(async () => {
    await cleanupAll();
  });

  beforeEach(async () => {
    // Clean cart + OTP rows between tests
    await db
      .delete(cartItemsTable)
      .where(eq(cartItemsTable.userId, `guest_${TEST_PHONE}`));
    await db.delete(guestOtpsTable).where(eq(guestOtpsTable.phone, TEST_PHONE));
    // Re-verify to get a fresh token (the old one might have expired
    // if tests take >30 min, which they shouldn't, but defense-in-depth)
    if (!guestToken) {
      const { code } = await generateAndSend(TEST_PHONE);
      const verifyRes = await request(app)
        .post("/api/auth/guest-otp/verify")
        .send({ phone: TEST_PHONE, code });
      guestToken = verifyRes.body.guestToken;
    }
  });

  it("guest places a single-seller marketplace order via POST /orders", async () => {
    // Add one marketplace item to the cart
    await request(app)
      .post("/api/cart/items")
      .set("Authorization", `Bearer ${guestToken}`)
      .send({
        productId,
        sellerListingVariantId: listingVariantAId,
        quantity: 2,
      });

    // Place the order
    const res = await request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${guestToken}`)
      .set("Idempotency-Key", "test-guest-order-single-seller")
      .send({
        paymentMethod: "cod",
        shippingAddress: {
          fullName: "Test Guest",
          phone: TEST_PHONE,
          street: "123 Test Street",
          city: "Dhaka",
          district: "Dhaka",
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.orders).toBeDefined();
    expect(Array.isArray(res.body.orders)).toBe(true);
    expect(res.body.orders).toHaveLength(1);

    const order = res.body.orders[0];
    expect(order.sellerId).toBe(sellerAId);
    expect(order.paymentMethod).toBe("cod");
    expect(order.paymentStatus).toBe("pending");
    expect(order.orderStatus).toBe("pending");
    expect(order.items).toHaveLength(1);
    expect(order.items[0].productId).toBe(productId);
    expect(order.items[0].quantity).toBe(2);
    expect(order.shippingAddress.fullName).toBe("Test Guest");
    expect(order.shippingAddress.phone).toBe(TEST_PHONE);

    // Cart should be cleared after checkout
    const cartRes = await request(app)
      .get("/api/cart")
      .set("Authorization", `Bearer ${guestToken}`);
    expect(cartRes.body.items).toEqual([]);
  });

  it("guest places a multi-seller order — split into N orders", async () => {
    // Add items from BOTH sellers
    await request(app)
      .post("/api/cart/items")
      .set("Authorization", `Bearer ${guestToken}`)
      .send({
        productId,
        sellerListingVariantId: listingVariantAId,
        quantity: 1,
      });
    await request(app)
      .post("/api/cart/items")
      .set("Authorization", `Bearer ${guestToken}`)
      .send({
        productId,
        sellerListingVariantId: listingVariantBId,
        quantity: 3,
      });

    // Place the order
    const res = await request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${guestToken}`)
      .set("Idempotency-Key", "test-guest-order-multi-seller")
      .send({
        paymentMethod: "cod",
        shippingAddress: {
          fullName: "Test Guest",
          phone: TEST_PHONE,
          street: "456 Multi Seller Ave",
          city: "Chittagong",
          district: "Chittagong",
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.orders).toHaveLength(2);

    // Verify each order has the correct seller
    const sellerIds = res.body.orders.map((o: any) => o.sellerId).sort();
    expect(sellerIds).toEqual([sellerAId, sellerBId].sort());

    // Each order should have 1 item
    for (const order of res.body.orders) {
      expect(order.items).toHaveLength(1);
      expect(order.shippingAddress.fullName).toBe("Test Guest");
    }
  });

  it("guest can fetch order history via GET /orders", async () => {
    // The previous tests created orders — verify they're visible
    const res = await request(app)
      .get("/api/orders")
      .set("Authorization", `Bearer ${guestToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2); // at least the two from above

    // All orders should belong to this guest
    for (const order of res.body) {
      expect(order.userId).toBe(`guest_${TEST_PHONE}`);
    }
  });

  it("guest can fetch individual order details via GET /orders/:id", async () => {
    // Get an order ID from the order history
    const listRes = await request(app)
      .get("/api/orders")
      .set("Authorization", `Bearer ${guestToken}`);
    const orderId = listRes.body[0].id;

    const res = await request(app)
      .get(`/api/orders/${orderId}`)
      .set("Authorization", `Bearer ${guestToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(orderId);
    expect(res.body.userId).toBe(`guest_${TEST_PHONE}`);
  });

  it("guest order has the guest phone in the shipping address", async () => {
    // The shipping address phone should be the one the buyer entered
    // (which matches the verified guest phone — the buyer used the same
    // number for both OTP verification and the shipping address)
    const listRes = await request(app)
      .get("/api/orders")
      .set("Authorization", `Bearer ${guestToken}`);
    const order = listRes.body[0];

    expect(order.shippingAddress.phone).toBe(TEST_PHONE);
  });

  it("idempotency: duplicate POST /orders with same key returns existing orders", async () => {
    // Add an item
    await request(app)
      .post("/api/cart/items")
      .set("Authorization", `Bearer ${guestToken}`)
      .send({
        productId,
        sellerListingVariantId: listingVariantAId,
        quantity: 1,
      });

    // Place the order with a specific idempotency key
    const idempotencyKey = "test-guest-idempotency-" + Date.now();
    const res1 = await request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${guestToken}`)
      .set("Idempotency-Key", idempotencyKey)
      .send({
        paymentMethod: "cod",
        shippingAddress: {
          fullName: "Idempotency Test",
          phone: TEST_PHONE,
          street: "789 Idempotency Rd",
          city: "Sylhet",
          district: "Sylhet",
        },
      });

    expect(res1.status).toBe(201);
    expect(res1.body.orders).toBeDefined();
    const firstOrderIds = res1.body.orders.map((o: any) => o.id);

    // Submit again with the SAME idempotency key — should return the same
    // orders via idempotent replay. The replay response shape is:
    //   { "0": order1, "1": order2, ..., idempotentReplay: true }
    // (the existing orders array is spread into the response object —
    //  see routes/orders.ts's idempotency check).
    const res2 = await request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${guestToken}`)
      .set("Idempotency-Key", idempotencyKey)
      .send({
        paymentMethod: "cod",
        shippingAddress: {
          fullName: "Idempotency Test",
          phone: TEST_PHONE,
          street: "789 Idempotency Rd",
          city: "Sylhet",
          district: "Sylhet",
        },
      });

    expect(res2.status).toBe(200); // 200, not 201 — idempotent replay
    expect(res2.body.idempotentReplay).toBe(true);
    // Extract order IDs from the spread-array response shape
    const secondOrderIds = Object.keys(res2.body)
      .filter((k) => /^\d+$/.test(k))
      .map((k) => res2.body[k].id);
    expect(secondOrderIds.sort()).toEqual(firstOrderIds.sort());
  });

  it("rejects POST /orders with no Authorization header", async () => {
    const res = await request(app).post("/api/orders").send({
      paymentMethod: "cod",
      shippingAddress: {
        fullName: "No Auth",
        phone: TEST_PHONE,
        street: "123",
        city: "Dhaka",
      },
    });
    expect(res.status).toBe(401);
  });
});
