import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import { cartItemsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { authHeader } from "./authHelper";
import {
  cleanupAll,
  seedCategory,
  seedProduct,
  seedSeller,
  seedUser,
  seedListing,
  seedVerifiedPaymentConfig,
} from "./testDb";

/**
 * Real HTTP-level tests for routes/cart.ts, driven through supertest
 * against the actual Express `app` -- real requireAuth middleware, real
 * route handlers, real Postgres. No DB mocking, no auth bypass.
 */
describe("cart routes (HTTP)", () => {
  let buyerClerkId: string;
  const buyerEmail = "cart-buyer-1@test.example";
  let sellerId: number;
  let productId: number;
  let listingId: number;

  beforeAll(async () => {
    await cleanupAll();

    const category = await seedCategory();
    const product = await seedProduct(category.id);
    productId = product.id;

    const { seller } = await seedSeller({
      clerkIdSuffix: "cart-seller-1",
      email: "cart-seller-1@test.example",
      businessName: "Cart Test Nursery",
    });
    sellerId = seller.id;
    await seedVerifiedPaymentConfig(sellerId);

    const listing = await seedListing({ productId, sellerId, price: "500.00", availableQuantity: 5 });
    listingId = listing.id;

    // Seed the buyer explicitly (rather than relying on requireAuth's
    // auto-create-on-first-request path) so its clerkId carries the
    // TEST_MARKER prefix and cleanupAll can find it -- see markerId's doc
    // comment in testDb.ts for why this matters.
    const buyer = await seedUser({ clerkIdSuffix: "cart-buyer-1", email: buyerEmail });
    buyerClerkId = buyer.clerkId;
  });

  afterAll(async () => {
    await cleanupAll();
  });

  it("401s GET /api/cart with no Authorization header", async () => {
    const res = await request(app).get("/api/cart");
    expect(res.status).toBe(401);
  });

  it("401s GET /api/cart with a garbage bearer token", async () => {
    const res = await request(app).get("/api/cart").set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("returns an empty cart for a fresh authenticated buyer", async () => {
    const res = await request(app)
      .get("/api/cart")
      .set(authHeader(buyerClerkId, buyerEmail));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("happy path: POST /api/cart/items adds a seller-listing line and it round-trips through GET /api/cart", async () => {
    const addRes = await request(app)
      .post("/api/cart/items")
      .set(authHeader(buyerClerkId, buyerEmail))
      .send({ productId, sellerListingId: listingId, quantity: 2 });

    expect(addRes.status).toBe(200);
    expect(addRes.body.items).toHaveLength(1);
    expect(addRes.body.items[0].kind).toBe("seller_listing");
    expect(addRes.body.items[0].sellerListingId).toBe(listingId);
    expect(addRes.body.items[0].quantity).toBe(2);
    // hasVerifiedPaymentConfig batched query (cart.ts) should read true, since
    // this seller has a verified seller_payment_configs row (seeded above).
    expect(addRes.body.items[0].seller.hasVerifiedPaymentConfig).toBe(true);
    expect(addRes.body.subtotal).toBe(1000);

    const getRes = await request(app)
      .get("/api/cart")
      .set(authHeader(buyerClerkId, buyerEmail));
    expect(getRes.status).toBe(200);
    expect(getRes.body.items).toHaveLength(1);
    expect(getRes.body.items[0].quantity).toBe(2);

    // Confirm the write actually landed in the DB, not just in the response body.
    const rows = await db.select().from(cartItemsTable).where(eq(cartItemsTable.userId, buyerClerkId));
    expect(rows).toHaveLength(1);
    expect(rows[0].sellerListingId).toBe(listingId);
    expect(rows[0].quantity).toBe(2);
  });

  it("rejects adding both variantId and sellerListingId (XOR enforcement)", async () => {
    const res = await request(app)
      .post("/api/cart/items")
      .set(authHeader(buyerClerkId, buyerEmail))
      .send({ productId, sellerListingId: listingId, variantId: 999999, quantity: 1 });
    expect(res.status).toBe(400);
  });

  it("rejects adding a listing beyond its availableQuantity", async () => {
    const res = await request(app)
      .post("/api/cart/items")
      .set(authHeader(buyerClerkId, buyerEmail))
      .send({ productId, sellerListingId: listingId, quantity: 6 }); // listing has availableQuantity: 5
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/available in stock/i);
  });

  it("DELETE /api/cart clears the authenticated buyer's cart", async () => {
    const res = await request(app)
      .delete("/api/cart")
      .set(authHeader(buyerClerkId, buyerEmail));
    expect(res.status).toBe(200);

    const rows = await db.select().from(cartItemsTable).where(eq(cartItemsTable.userId, buyerClerkId));
    expect(rows).toHaveLength(0);
  });
});
