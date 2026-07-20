import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import { ordersTable, sellerListingsTable, cartItemsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { authHeader } from "./authHelper";
import { cleanupAll, seedCategory, seedProduct, seedSeller, seedUser, seedListing } from "./testDb";

describe("orders routes (HTTP)", () => {
  let buyerClerkId: string;
  let sellerId: number;
  let productId: number;
  let listingId: number;

  beforeAll(async () => {
    await cleanupAll();

    const category = await seedCategory();
    const product = await seedProduct(category.id);
    productId = product.id;

    const { seller } = await seedSeller({
      clerkIdSuffix: "orders-seller",
      email: "orders-seller@test.example",
      businessName: "Orders Test Nursery",
    });
    sellerId = seller.id;

    const listing = await seedListing({ productId, sellerId, price: "500.00", availableQuantity: 10 });
    listingId = listing.id;

    buyerClerkId = (await seedUser({ clerkIdSuffix: "orders-buyer", email: "orders-buyer@test.example" })).clerkId;
  });

  afterAll(async () => {
    await cleanupAll();
  });

  it("401s GET /api/orders with no auth", async () => {
    const res = await request(app).get("/api/orders");
    expect(res.status).toBe(401);
  });

  it("401s POST /api/orders (checkout) with no auth", async () => {
    const res = await request(app)
      .post("/api/orders")
      .send({ paymentMethod: "cod", shippingAddress: { fullName: "X", phone: "01700000000", street: "s", city: "c" } });
    expect(res.status).toBe(401);
  });

  it("400s checkout with an empty cart", async () => {
    const res = await request(app)
      .post("/api/orders")
      .set(authHeader(buyerClerkId, "orders-buyer@test.example"))
      .send({ paymentMethod: "cod", shippingAddress: { fullName: "X", phone: "01700000000", street: "s", city: "c" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cart is empty/i);
  });

  it("happy path: COD checkout creates a real order, decrements listing stock, and clears the cart", async () => {
    const addRes = await request(app)
      .post("/api/cart/items")
      .set(authHeader(buyerClerkId, "orders-buyer@test.example"))
      .send({ productId, sellerListingId: listingId, quantity: 3 });
    expect(addRes.status).toBe(200);

    const checkoutRes = await request(app)
      .post("/api/orders")
      .set(authHeader(buyerClerkId, "orders-buyer@test.example"))
      .send({
        paymentMethod: "cod",
        shippingAddress: { fullName: "Test Buyer", phone: "01700000000", street: "123 Rd", city: "Dhaka", district: "Dhaka" },
      });

    expect(checkoutRes.status).toBe(201);
    expect(Array.isArray(checkoutRes.body)).toBe(true);
    expect(checkoutRes.body).toHaveLength(1);
    const created = checkoutRes.body[0];
    expect(created.paymentMethod).toBe("cod");
    expect(created.sellerId).toBe(sellerId);
    expect(created.totalAmount).toBe(1500); // 500 * 3

    // Confirm real DB state, not just the response payload.
    const [orderRow] = await db.select().from(ordersTable).where(eq(ordersTable.id, created.id));
    expect(orderRow).toBeDefined();
    expect(orderRow.userId).toBe(buyerClerkId);

    const [listingRow] = await db.select().from(sellerListingsTable).where(eq(sellerListingsTable.id, listingId));
    expect(listingRow.availableQuantity).toBe(7); // 10 - 3

    const cartRows = await db.select().from(cartItemsTable).where(eq(cartItemsTable.userId, buyerClerkId));
    expect(cartRows).toHaveLength(0);
  });

  it("GET /api/orders returns only the authenticated buyer's own orders", async () => {
    const res = await request(app)
      .get("/api/orders")
      .set(authHeader(buyerClerkId, "orders-buyer@test.example"));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every((o: { userId: string }) => o.userId === buyerClerkId)).toBe(true);
  });

  it("GET /api/orders/:id 404s for an order belonging to a different user", async () => {
    const otherBuyer = await seedUser({ clerkIdSuffix: "orders-other-buyer", email: "orders-other-buyer@test.example" });

    const mine = await request(app)
      .get("/api/orders")
      .set(authHeader(buyerClerkId, "orders-buyer@test.example"));
    const orderId = mine.body[0].id;

    const res = await request(app)
      .get(`/api/orders/${orderId}`)
      .set(authHeader(otherBuyer.clerkId, "orders-other-buyer@test.example"));
    expect(res.status).toBe(404);
  });
});
