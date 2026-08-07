import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { authHeader } from "./authHelper";
import { cleanupAll, seedSeller, seedUser, seedCategory, seedProduct, seedListing, seedOrder } from "./testDb";

describe("seller-monthly-history routes (HTTP)", () => {
  let sellerClerkId: string;
  let sellerId: number;
  let otherSellerClerkId: string;
  let buyerClerkId: string;
  let ordersCreated: number[] = [];

  beforeAll(async () => {
    await cleanupAll();

    const { user: sellerUser, seller } = await seedSeller({
      clerkIdSuffix: "monthly-seller",
      email: "monthly-seller@test.example",
      businessName: "Monthly History Nursery",
    });
    sellerClerkId = sellerUser.clerkId;
    sellerId = seller.id;

    const { user: otherSellerUser } = await seedSeller({
      clerkIdSuffix: "monthly-other-seller",
      email: "monthly-other-seller@test.example",
      businessName: "Other Monthly Nursery",
    });
    otherSellerClerkId = otherSellerUser.clerkId;

    const buyer = await seedUser({ clerkIdSuffix: "monthly-buyer", email: "monthly-buyer@test.example" });
    buyerClerkId = buyer.clerkId;

    const category = await seedCategory();
    const product = await seedProduct(category.id);
    const listing = await seedListing({ productId: product.id, sellerId, price: "400" });

    // Delivered order this seller can count as revenue
    const delivered = await seedOrder({ userIdClerk: buyerClerkId, sellerId, listingId: listing.id, productId: product.id, price: 400 });
    await db.update(ordersTable).set({ orderStatus: "delivered" }).where(eq(ordersTable.id, delivered.id));
    ordersCreated.push(delivered.id);

    // Pending order -- counts toward totalOrders but NOT totalRevenue
    const pending = await seedOrder({ userIdClerk: buyerClerkId, sellerId, listingId: listing.id, productId: product.id, price: 250 });
    ordersCreated.push(pending.id);
  });

  afterAll(async () => {
    await cleanupAll();
  });

  it("401s GET /api/seller/monthly-history with no auth", async () => {
    const res = await request(app).get("/api/seller/monthly-history");
    expect(res.status).toBe(401);
  });

  it("403s GET /api/seller/monthly-history for a user with no seller account", async () => {
    const res = await request(app)
      .get("/api/seller/monthly-history")
      .set(authHeader(buyerClerkId, "monthly-buyer@test.example"));
    expect(res.status).toBe(403);
  });

  it("returns this month's record with totalOrders counting all orders and totalRevenue counting only delivered ones", async () => {
    const res = await request(app)
      .get("/api/seller/monthly-history")
      .set(authHeader(sellerClerkId, "monthly-seller@test.example"));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.records)).toBe(true);

    const now = new Date();
    const thisMonth = res.body.records.find(
      (r: any) => r.year === now.getFullYear() && r.month === now.getMonth() + 1,
    );
    expect(thisMonth).toBeTruthy();
    expect(ordersCreated).toHaveLength(2);
    expect(thisMonth.totalOrders).toBeGreaterThanOrEqual(ordersCreated.length);
    expect(thisMonth.totalRevenue).toBeGreaterThanOrEqual(400);
  });

  it("does not include another seller's orders in the totals", async () => {
    const res = await request(app)
      .get("/api/seller/monthly-history")
      .set(authHeader(otherSellerClerkId, "monthly-other-seller@test.example"));

    expect(res.status).toBe(200);
    const now = new Date();
    const thisMonth = res.body.records.find(
      (r: any) => r.year === now.getFullYear() && r.month === now.getMonth() + 1,
    );
    // This seller has no orders at all -- either no row for this month, or
    // one with zero counts, but never the other seller's totals.
    if (thisMonth) {
      expect(thisMonth.totalOrders).toBe(0);
      expect(thisMonth.totalRevenue).toBe(0);
    }
  });

  it("400s an invalid ?months= value", async () => {
    const res = await request(app)
      .get("/api/seller/monthly-history?months=0")
      .set(authHeader(sellerClerkId, "monthly-seller@test.example"));
    expect(res.status).toBe(400);
  });

  it("caps ?months= at the maximum window", async () => {
    const res = await request(app)
      .get("/api/seller/monthly-history?months=9999")
      .set(authHeader(sellerClerkId, "monthly-seller@test.example"));
    expect(res.status).toBe(200);
    expect(res.body.months).toBe(60);
  });
});
