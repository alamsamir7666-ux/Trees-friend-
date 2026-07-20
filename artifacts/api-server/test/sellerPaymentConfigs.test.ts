import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import { sellerPaymentConfigsTable, sellerListingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { authHeader } from "./authHelper";
import { cleanupAll, seedCategory, seedProduct, seedSeller, seedUser, seedListing } from "./testDb";

describe("seller-payment-configs routes (HTTP)", () => {
  let sellerClerkId: string;
  let sellerId: number;
  let buyerClerkId: string;
  let productId: number;

  beforeAll(async () => {
    await cleanupAll();
    const category = await seedCategory();
    const product = await seedProduct(category.id);
    productId = product.id;

    const { user, seller } = await seedSeller({
      clerkIdSuffix: "payconfig-seller",
      email: "payconfig-seller@test.example",
      businessName: "Payment Config Nursery",
    });
    sellerClerkId = user.clerkId;
    sellerId = seller.id;

    const buyer = await seedUser({ clerkIdSuffix: "payconfig-buyer", email: "payconfig-buyer@test.example" });
    buyerClerkId = buyer.clerkId;
  });

  afterAll(async () => {
    await cleanupAll();
  });

  it("401s GET /api/seller-payment-configs/mine with no auth", async () => {
    const res = await request(app).get("/api/seller-payment-configs/mine");
    expect(res.status).toBe(401);
  });

  it("403s POST /api/seller-payment-configs for a non-seller buyer", async () => {
    const res = await request(app)
      .post("/api/seller-payment-configs")
      .set(authHeader(buyerClerkId, "payconfig-buyer@test.example"))
      .send({ merchantAppKey: "k", merchantAppSecret: "s", merchantUsername: "u", merchantPassword: "p" });
    expect(res.status).toBe(403);
  });

  it("404s GET /api/seller-payment-configs/mine before any config exists", async () => {
    const res = await request(app)
      .get("/api/seller-payment-configs/mine")
      .set(authHeader(sellerClerkId, "payconfig-seller@test.example"));
    expect(res.status).toBe(404);
  });

  it("happy path: seller creates a payment config, it's masked in the response, isVerified starts false", async () => {
    const res = await request(app)
      .post("/api/seller-payment-configs")
      .set(authHeader(sellerClerkId, "payconfig-seller@test.example"))
      .send({
        merchantAppKey: "real-app-key-1234",
        merchantAppSecret: "real-app-secret-5678",
        merchantUsername: "merchantuser",
        merchantPassword: "supersecretpassword",
      });

    expect(res.status).toBe(201);
    expect(res.body.isVerified).toBe(false);
    expect(res.body.merchantAppKeyMasked).not.toContain("real-app-key-1234");
    expect(res.body.merchantAppKeyMasked).toMatch(/^•+/);

    const rows = await db.select().from(sellerPaymentConfigsTable).where(eq(sellerPaymentConfigsTable.sellerId, sellerId));
    expect(rows).toHaveLength(1);
    // Confirm the stored value is actually encrypted, not plaintext.
    expect(rows[0].merchantAppKey).not.toBe("real-app-key-1234");
  });

  it("GET /api/seller-payment-configs/mine now returns the masked config", async () => {
    const res = await request(app)
      .get("/api/seller-payment-configs/mine")
      .set(authHeader(sellerClerkId, "payconfig-seller@test.example"));
    expect(res.status).toBe(200);
    expect(res.body.sellerId).toBe(sellerId);
  });

  it("delete reconciliation: deleting a verified config flips the seller's advance/both listings back to cod", async () => {
    // Manually flip this seller's existing config to verified (no admin
    // verify route needed for this test's purpose -- see seedVerifiedPaymentConfig
    // doc comment in testDb.ts for the same convention).
    await db.update(sellerPaymentConfigsTable).set({ isVerified: true }).where(eq(sellerPaymentConfigsTable.sellerId, sellerId));

    const listing = await seedListing({ productId, sellerId, paymentMethod: "advance" });

    const res = await request(app)
      .delete("/api/seller-payment-configs/mine")
      .set(authHeader(sellerClerkId, "payconfig-seller@test.example"));
    expect(res.status).toBe(200);

    const [refetched] = await db.select().from(sellerListingsTable).where(eq(sellerListingsTable.id, listing.id));
    expect(refetched.paymentMethod).toBe("cod");

    const configRows = await db.select().from(sellerPaymentConfigsTable).where(eq(sellerPaymentConfigsTable.sellerId, sellerId));
    expect(configRows).toHaveLength(0);
  });

  it("404s deleting a payment config that no longer exists", async () => {
    const res = await request(app)
      .delete("/api/seller-payment-configs/mine")
      .set(authHeader(sellerClerkId, "payconfig-seller@test.example"));
    expect(res.status).toBe(404);
  });
});
