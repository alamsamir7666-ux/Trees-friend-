import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import { guestOtpsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  cleanupAll,
  seedCategory,
  seedProduct,
  seedSeller,
  seedListing,
} from "./testDb";
import { generateAndSend } from "../src/lib/guestOtp";

/**
 * Guest cart HTTP tests — Part 2 of the Daraz-style guest checkout.
 *
 * Verifies that a phone-verified guest (holding a guest JWT) can use the
 * same cart API as a logged-in user: GET /cart, POST /cart/items,
 * POST /cart/merge, PUT /cart/items/:id, DELETE /cart/items/:id,
 * DELETE /cart.
 *
 * Flow:
 *   1. Send OTP to a test phone (via the library — bypasses HTTP rate limits)
 *   2. Call POST /auth/guest-otp/verify via HTTP to get the guest JWT
 *   3. Use the guest JWT as Authorization: Bearer on all cart requests
 *
 * Test phone numbers: 01700XXXXXXXX range (017 = Grameenphone, 00 = unlikely
 * real). cleanupAll deletes all 01700-prefixed guest_otps rows.
 */

const TEST_PHONE = "01700123456";

describe("guest cart (HTTP with guest JWT)", () => {
  let guestToken: string;
  let productId: number;
  let sellerId: number;
  let listingVariantId: number;

  beforeAll(async () => {
    await cleanupAll();

    // Seed a category + product + seller + listing for cart operations
    const category = await seedCategory();
    const product = await seedProduct(category.id);
    productId = product.id;

    const { seller } = await seedSeller({
      clerkIdSuffix: "guest-cart-seller",
      email: "guest-cart-seller@test.example",
      businessName: "Guest Cart Test Nursery",
    });
    sellerId = seller.id;

    const listing = await seedListing({
      productId,
      sellerId,
      price: "500.00",
      availableQuantity: 10,
    });
    listingVariantId = listing._firstVariant.id;
  });

  afterAll(async () => {
    await cleanupAll();
  });

  beforeEach(async () => {
    // Clean OTP rows for the test phone between tests
    await db.delete(guestOtpsTable).where(eq(guestOtpsTable.phone, TEST_PHONE));
  });

  it("issues a guest JWT on successful OTP verification", async () => {
    // Generate via the library (bypasses HTTP rate limiting)
    const { code } = await generateAndSend(TEST_PHONE);

    // Now call the HTTP verify endpoint to get the guest JWT
    const res = await request(app)
      .post("/api/auth/guest-otp/verify")
      .send({ phone: TEST_PHONE, code });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.guestToken).toBeDefined();
    expect(typeof res.body.guestToken).toBe("string");

    guestToken = res.body.guestToken;
  });

  it("GET /api/cart with guest JWT returns an empty cart", async () => {
    if (!guestToken) {
      const { code } = await generateAndSend(TEST_PHONE);
      const verifyRes = await request(app)
        .post("/api/auth/guest-otp/verify")
        .send({ phone: TEST_PHONE, code });
      guestToken = verifyRes.body.guestToken;
    }

    const res = await request(app)
      .get("/api/cart")
      .set("Authorization", `Bearer ${guestToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.subtotal).toBe(0);
    expect(res.body.total).toBe(0);
  });

  it("POST /api/cart/items with guest JWT adds an item to the server cart", async () => {
    const res = await request(app)
      .post("/api/cart/items")
      .set("Authorization", `Bearer ${guestToken}`)
      .send({
        productId,
        sellerListingVariantId: listingVariantId,
        quantity: 2,
      });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].productId).toBe(productId);
    expect(res.body.items[0].quantity).toBe(2);
    expect(res.body.subtotal).toBe(1000); // 500 × 2
  });

  it("GET /api/cart returns the item added by the guest", async () => {
    const res = await request(app)
      .get("/api/cart")
      .set("Authorization", `Bearer ${guestToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].productId).toBe(productId);
    expect(res.body.items[0].quantity).toBe(2);
  });

  it("PUT /api/cart/items/:id with guest JWT updates quantity", async () => {
    // Get the cart to find the item id
    const cartRes = await request(app)
      .get("/api/cart")
      .set("Authorization", `Bearer ${guestToken}`);
    const itemId = cartRes.body.items[0].id;

    const res = await request(app)
      .put(`/api/cart/items/${itemId}`)
      .set("Authorization", `Bearer ${guestToken}`)
      .send({ quantity: 5 });

    expect(res.status).toBe(200);
    expect(res.body.items[0].quantity).toBe(5);
    expect(res.body.subtotal).toBe(2500); // 500 × 5
  });

  it("DELETE /api/cart/items/:id with guest JWT removes the item", async () => {
    // Get the cart to find the item id
    const cartRes = await request(app)
      .get("/api/cart")
      .set("Authorization", `Bearer ${guestToken}`);
    const itemId = cartRes.body.items[0].id;

    const res = await request(app)
      .delete(`/api/cart/items/${itemId}`)
      .set("Authorization", `Bearer ${guestToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.subtotal).toBe(0);
  });

  it("POST /api/cart/merge with guest JWT merges items into the server cart", async () => {
    // Cart should be empty at this point (previous test deleted the item)
    const res = await request(app)
      .post("/api/cart/merge")
      .set("Authorization", `Bearer ${guestToken}`)
      .send({
        items: [
          { productId, sellerListingVariantId: listingVariantId, quantity: 3 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].quantity).toBe(3);
    expect(res.body.subtotal).toBe(1500); // 500 × 3
  });

  it("DELETE /api/cart with guest JWT clears the cart", async () => {
    const res = await request(app)
      .delete("/api/cart")
      .set("Authorization", `Bearer ${guestToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Cart cleared");

    // Verify the cart is empty
    const cartRes = await request(app)
      .get("/api/cart")
      .set("Authorization", `Bearer ${guestToken}`);
    expect(cartRes.body.items).toEqual([]);
  });

  it("rejects cart requests with an invalid guest JWT", async () => {
    const res = await request(app)
      .get("/api/cart")
      .set("Authorization", "Bearer invalid.guest.token");

    // Should fall through to Clerk auth (which also fails) → 401
    expect(res.status).toBe(401);
  });

  it("rejects cart requests with no Authorization header", async () => {
    const res = await request(app).get("/api/cart");
    expect(res.status).toBe(401);
  });
});

describe("guest cart isolation (guest carts don't leak between phones)", () => {
  const TEST_PHONE_A = "01700111111";
  const TEST_PHONE_B = "01700222222";
  let tokenA: string;
  let tokenB: string;
  let productId: number;
  let listingVariantId: number;

  beforeAll(async () => {
    await cleanupAll();

    const category = await seedCategory();
    const product = await seedProduct(category.id);
    productId = product.id;

    const { seller } = await seedSeller({
      clerkIdSuffix: "guest-isolation-seller",
      email: "guest-isolation-seller@test.example",
      businessName: "Isolation Test Nursery",
    });

    const listing = await seedListing({
      productId,
      sellerId: seller.id,
      price: "100.00",
      availableQuantity: 50,
    });
    listingVariantId = listing._firstVariant.id;

    // Verify phone A and get its guest token
    const { code: codeA } = await generateAndSend(TEST_PHONE_A);
    const verifyResA = await request(app)
      .post("/api/auth/guest-otp/verify")
      .send({ phone: TEST_PHONE_A, code: codeA });
    tokenA = verifyResA.body.guestToken;

    // Verify phone B and get its guest token
    const { code: codeB } = await generateAndSend(TEST_PHONE_B);
    const verifyResB = await request(app)
      .post("/api/auth/guest-otp/verify")
      .send({ phone: TEST_PHONE_B, code: codeB });
    tokenB = verifyResB.body.guestToken;
  });

  afterAll(async () => {
    await cleanupAll();
  });

  it("guest A's cart items are not visible to guest B", async () => {
    // Guest A adds an item
    await request(app)
      .post("/api/cart/items")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ productId, sellerListingVariantId: listingVariantId, quantity: 1 });

    // Guest B's cart should be empty
    const resB = await request(app)
      .get("/api/cart")
      .set("Authorization", `Bearer ${tokenB}`);

    expect(resB.status).toBe(200);
    expect(resB.body.items).toEqual([]);
  });
});
