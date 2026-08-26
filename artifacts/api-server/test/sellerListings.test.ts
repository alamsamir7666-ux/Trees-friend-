import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import { sellerListingsTable, sellerListingVariantsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { authHeader } from "./authHelper";
import {
  cleanupAll,
  seedCategory,
  seedProduct,
  seedSeller,
  seedUser,
  seedSellerPayoutAccount,
} from "./testDb";

/**
 * Real HTTP-level tests for routes/sellerListings.ts. Centerpiece is the
 * hasSellerPayoutAccount enforcement test (post-migration name; was
 * hasVerifiedPaymentConfig pre-migration): routes/sellerListings.ts's
 * POST/PUT reject paymentMethod="advance"|"both" if the seller has no
 * seller_payout_accounts row on file. This suite confirms requireSeller +
 * the route handler actually enforce it end-to-end through Express.
 */
describe("seller-listings routes (HTTP)", () => {
  let productId: number;
  let categoryId: number;

  let activeSellerClerkId: string;
  let activeSellerId: number;

  let unverifiedSellerClerkId: string;
  let unverifiedSellerId: number;

  let pendingSellerClerkId: string;

  let buyerClerkId: string;

  beforeAll(async () => {
    await cleanupAll();

    const category = await seedCategory();
    categoryId = category.id;
    const product = await seedProduct(categoryId);
    productId = product.id;

    const activeSeller = await seedSeller({
      clerkIdSuffix: "listings-active-seller",
      email: "listings-active-seller@test.example",
      businessName: "Active Listings Nursery",
      status: "active",
    });
    activeSellerClerkId = activeSeller.user.clerkId;
    activeSellerId = activeSeller.seller.id;
    await seedSellerPayoutAccount(activeSellerId);

    const unverifiedSeller = await seedSeller({
      clerkIdSuffix: "listings-unverified-seller",
      email: "listings-unverified-seller@test.example",
      businessName: "No Payout Account Nursery",
      status: "active",
    });
    unverifiedSellerClerkId = unverifiedSeller.user.clerkId;
    unverifiedSellerId = unverifiedSeller.seller.id;
    // Deliberately NOT calling seedSellerPayoutAccount for this seller.

    const pendingSeller = await seedSeller({
      clerkIdSuffix: "listings-pending-seller",
      email: "listings-pending-seller@test.example",
      businessName: "Pending Verification Nursery",
      status: "pending_verification",
    });
    pendingSellerClerkId = pendingSeller.user.clerkId;

    const buyer = await seedUser({
      clerkIdSuffix: "listings-buyer",
      email: "listings-buyer@test.example",
    });
    buyerClerkId = buyer.clerkId;
  });

  afterAll(async () => {
    await cleanupAll();
  });

  describe("401/403 gating", () => {
    it("401s POST /api/seller-listings with no auth", async () => {
      const res = await request(app).post("/api/seller-listings").send({ productId, price: 100 });
      expect(res.status).toBe(401);
    });

    it("403s POST /api/seller-listings for an authenticated buyer with no seller account", async () => {
      const res = await request(app)
        .post("/api/seller-listings")
        .set(authHeader(buyerClerkId, "listings-buyer@test.example"))
        .send({ productId, price: 100 });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/don't have a seller account/i);
    });

    it("403s POST /api/seller-listings for a pending_verification seller (requireSeller requires active)", async () => {
      const res = await request(app)
        .post("/api/seller-listings")
        .set(authHeader(pendingSellerClerkId, "listings-pending-seller@test.example"))
        .send({ productId, price: 100 });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/not active/i);
    });

    it("403s GET /api/seller-listings/mine for a non-seller buyer", async () => {
      const res = await request(app)
        .get("/api/seller-listings/mine")
        .set(authHeader(buyerClerkId, "listings-buyer@test.example"));
      expect(res.status).toBe(403);
    });
  });

  describe("happy path", () => {
    it("an active seller can create a COD listing with no payment config", async () => {
      const res = await request(app)
        .post("/api/seller-listings")
        .set(authHeader(unverifiedSellerClerkId, "listings-unverified-seller@test.example"))
        .send({ productId, price: "450.00", paymentMethod: "cod", stock: 10 });

      expect(res.status).toBe(201);
      expect(res.body.paymentMethod).toBe("cod");
      expect(res.body.sellerId).toBe(unverifiedSellerId);

      const rows = await db
        .select()
        .from(sellerListingsTable)
        .where(eq(sellerListingsTable.id, res.body.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].approvalStatus).toBe("pending");
    });

    it("an active seller with a verified payment config can create an 'advance' listing", async () => {
      const res = await request(app)
        .post("/api/seller-listings")
        .set(authHeader(activeSellerClerkId, "listings-active-seller@test.example"))
        .send({ productId, price: "600.00", paymentMethod: "advance", stock: 5 });

      expect(res.status).toBe(201);
      expect(res.body.paymentMethod).toBe("advance");

      const rows = await db
        .select()
        .from(sellerListingsTable)
        .where(eq(sellerListingsTable.id, res.body.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].paymentMethod).toBe("advance");
    });

    it("a seller can list their own listings via GET /api/seller-listings/mine", async () => {
      const res = await request(app)
        .get("/api/seller-listings/mine")
        .set(authHeader(activeSellerClerkId, "listings-active-seller@test.example"));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body.every((l: { sellerId: number }) => l.sellerId === activeSellerId)).toBe(true);
    });
  });

  describe("hasSellerPayoutAccount enforcement through the real HTTP route (post-migration: was hasVerifiedPaymentConfig pre-migration)", () => {
    it("POST /api/seller-listings rejects paymentMethod='advance' for a seller with NO seller_payout_accounts row", async () => {
      const res = await request(app)
        .post("/api/seller-listings")
        .set(authHeader(unverifiedSellerClerkId, "listings-unverified-seller@test.example"))
        .send({ productId, price: "700.00", paymentMethod: "advance", stock: 5 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/bKash payout number on file/i);

      // Confirm no listing row was actually written for this rejected attempt.
      // Post-Phase-2: the price field lives on the variant, not the listing,
      // so check that the rejection produced NO variant priced at 700 (the
      // rejected body) by joining listings to variants and filtering on the
      // variant's price. If you instead queried `sellerListingsTable.price`,
      // you'd hit a TS2339 because that column no longer exists.
      const rows = await db
        .select({
          listingId: sellerListingsTable.id,
          price: sellerListingVariantsTable.price,
        })
        .from(sellerListingsTable)
        .leftJoin(
          sellerListingVariantsTable,
          eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id),
        )
        .where(eq(sellerListingsTable.sellerId, unverifiedSellerId));
      expect(rows.every((r) => r.price !== "700.00")).toBe(true);
    });

    it("POST /api/seller-listings rejects paymentMethod='both' the same way", async () => {
      const res = await request(app)
        .post("/api/seller-listings")
        .set(authHeader(unverifiedSellerClerkId, "listings-unverified-seller@test.example"))
        .send({ productId, price: "701.00", paymentMethod: "both", stock: 5 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/bKash payout number on file/i);
    });

    it("PUT /api/seller-listings/:id also rejects switching an existing COD listing to 'advance' with no payout account", async () => {
      const createRes = await request(app)
        .post("/api/seller-listings")
        .set(authHeader(unverifiedSellerClerkId, "listings-unverified-seller@test.example"))
        .send({ productId, price: "300.00", paymentMethod: "cod", stock: 5 });
      expect(createRes.status).toBe(201);
      const listingId = createRes.body.id;

      const updateRes = await request(app)
        .put(`/api/seller-listings/${listingId}`)
        .set(authHeader(unverifiedSellerClerkId, "listings-unverified-seller@test.example"))
        .send({ paymentMethod: "advance" });

      expect(updateRes.status).toBe(400);
      expect(updateRes.body.error).toMatch(/bKash payout number on file/i);

      const rows = await db
        .select()
        .from(sellerListingsTable)
        .where(eq(sellerListingsTable.id, listingId));
      expect(rows[0].paymentMethod).toBe("cod"); // unchanged
    });

    it("PUT /api/seller-listings/:id allows switching to 'advance' once the seller has a payout account", async () => {
      const createRes = await request(app)
        .post("/api/seller-listings")
        .set(authHeader(unverifiedSellerClerkId, "listings-unverified-seller@test.example"))
        .send({ productId, price: "301.00", paymentMethod: "cod", stock: 5 });
      expect(createRes.status).toBe(201);
      const listingId = createRes.body.id;

      // Grant this seller a payout account now, and confirm the SAME
      // route immediately reflects it (no caching of the earlier rejection).
      await seedSellerPayoutAccount(unverifiedSellerId);
      try {
        const updateRes = await request(app)
          .put(`/api/seller-listings/${listingId}`)
          .set(authHeader(unverifiedSellerClerkId, "listings-unverified-seller@test.example"))
          .send({ paymentMethod: "advance" });

        expect(updateRes.status).toBe(200);
        expect(updateRes.body.paymentMethod).toBe("advance");
      } finally {
        // Roll this seller back to "no payout account" so later tests in
        // this file that assume unverifiedSellerId has no payout still hold.
        const { sellerPayoutAccountsTable } = await import("@workspace/db/schema");
        await db
          .delete(sellerPayoutAccountsTable)
          .where(eq(sellerPayoutAccountsTable.sellerId, unverifiedSellerId));
      }
    });

    it("ownership check: a seller cannot PUT another seller's listing", async () => {
      const createRes = await request(app)
        .post("/api/seller-listings")
        .set(authHeader(activeSellerClerkId, "listings-active-seller@test.example"))
        .send({ productId, price: "999.00", paymentMethod: "cod", stock: 5 });
      const listingId = createRes.body.id;

      const res = await request(app)
        .put(`/api/seller-listings/${listingId}`)
        .set(authHeader(unverifiedSellerClerkId, "listings-unverified-seller@test.example"))
        .send({ price: "1.00" });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/don't own this listing/i);
    });
  });
});
