import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import {
  sellersTable,
  sellerPaymentConfigsTable,
  sellerCourierConfigsTable,
  sellerListingsTable,
} from "@workspace/db/schema";
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
  seedVerifiedCourierConfig,
} from "./testDb";

/**
 * HTTP-level coverage for routes/adminSellers.ts, which had none before
 * this file: every existing test (this suite's other files AND
 * scripts/src/verify-seller-marketplace.ts) seeds isVerified/status
 * directly via the DB, bypassing these routes entirely. That means the
 * actual admin-facing verification/approval workflow -- the thing Part 1's
 * hasVerifiedPaymentConfig and Part 2's order_shipments fix both assume
 * gets triggered through a real admin action -- had never actually been
 * driven through a real request before this file existed.
 *
 * Admin identity: requireAdmin checks req.dbUser.role === "admin" (see
 * middlewares/auth.ts's requireAdmin/requireAuth). The mobile-JWT auth path
 * only ever promotes a user to "admin" automatically via the hardcoded
 * ADMIN_EMAILS allowlist, which this suite deliberately does NOT rely on
 * (asserting against a hardcoded production email would be fragile and
 * wrong to depend on in a test). Instead this suite seeds a users row with
 * role: "admin" directly (seedUser's documented role option) -- requireAuth
 * only overwrites an existing user's role when a Clerk-claims-derived role
 * is present, which a mobile JWT never provides, so a directly-seeded
 * "admin" role is preserved end-to-end through the real middleware chain.
 */
describe("admin-sellers routes (HTTP)", () => {
  let adminClerkId: string;
  let buyerClerkId: string;
  let nonAdminSellerClerkId: string;
  let productId: number;

  beforeAll(async () => {
    await cleanupAll();
    const category = await seedCategory();
    const product = await seedProduct(category.id);
    productId = product.id;

    const admin = await seedUser({ clerkIdSuffix: "adminsellers-admin", email: "adminsellers-admin@test.example", role: "admin" });
    adminClerkId = admin.clerkId;

    const buyer = await seedUser({ clerkIdSuffix: "adminsellers-buyer", email: "adminsellers-buyer@test.example" });
    buyerClerkId = buyer.clerkId;

    const { user: nonAdminSellerUser } = await seedSeller({
      clerkIdSuffix: "adminsellers-nonadmin-seller",
      email: "adminsellers-nonadmin-seller@test.example",
      businessName: "Non-Admin Seller Nursery",
    });
    nonAdminSellerClerkId = nonAdminSellerUser.clerkId;
  });

  afterAll(async () => {
    await cleanupAll();
  });

  const adminAuth = () => authHeader(adminClerkId, "adminsellers-admin@test.example");
  const buyerAuth = () => authHeader(buyerClerkId, "adminsellers-buyer@test.example");
  const nonAdminSellerAuth = () => authHeader(nonAdminSellerClerkId, "adminsellers-nonadmin-seller@test.example");

  describe("401/403 gating on every route in this file", () => {
    it("401s GET /api/admin/sellers with no auth", async () => {
      const res = await request(app).get("/api/admin/sellers");
      expect(res.status).toBe(401);
    });

    it("403s GET /api/admin/sellers for a regular buyer", async () => {
      const res = await request(app).get("/api/admin/sellers").set(buyerAuth());
      expect(res.status).toBe(403);
    });

    it("403s GET /api/admin/sellers for a non-admin seller", async () => {
      const res = await request(app).get("/api/admin/sellers").set(nonAdminSellerAuth());
      expect(res.status).toBe(403);
    });

    it("401/403s the approve/reject/suspend routes for no-auth and non-admin", async () => {
      // Use an id guaranteed never to exist (negative) rather than a
      // literal like 1 -- gating must 401/403 before the route ever looks
      // up a row, so this loop shouldn't depend on (or collide with)
      // another test's fixture data.
      for (const { method, path } of [
        { method: "put" as const, path: "/api/admin/sellers/-1/approve" },
        { method: "put" as const, path: "/api/admin/sellers/-1/reject" },
        { method: "put" as const, path: "/api/admin/sellers/-1/suspend" },
      ]) {
        const noAuth = await request(app)[method](path);
        expect(noAuth.status).toBe(401);
        const buyerRes = await request(app)[method](path).set(buyerAuth());
        expect(buyerRes.status).toBe(403);
        const nonAdminRes = await request(app)[method](path).set(nonAdminSellerAuth());
        expect(nonAdminRes.status).toBe(403);
      }
    }, 45000);

    it("401/403s the payment/courier config list + verify + unverify routes for no-auth and non-admin", async () => {
      for (const { method, path } of [
        { method: "get" as const, path: "/api/admin/seller-payment-configs" },
        { method: "put" as const, path: "/api/admin/seller-payment-configs/-1/verify" },
        { method: "put" as const, path: "/api/admin/seller-payment-configs/-1/unverify" },
        { method: "get" as const, path: "/api/admin/seller-courier-configs" },
        { method: "put" as const, path: "/api/admin/seller-courier-configs/-1/verify" },
        { method: "put" as const, path: "/api/admin/seller-courier-configs/-1/unverify" },
      ]) {
        const noAuth = await request(app)[method](path);
        expect(noAuth.status).toBe(401);
        const buyerRes = await request(app)[method](path).set(buyerAuth());
        expect(buyerRes.status).toBe(403);
        const nonAdminRes = await request(app)[method](path).set(nonAdminSellerAuth());
        expect(nonAdminRes.status).toBe(403);
      }
    }, 45000);
  });

  describe("seller approval-status routes: approve / reject / suspend", () => {
    it("approve: real admin HTTP call flips a pending_verification seller to active in the DB", async () => {
      const { seller } = await seedSeller({
        clerkIdSuffix: "approve-target",
        email: "approve-target@test.example",
        businessName: "Approve Target Nursery",
        status: "pending_verification",
      });

      const res = await request(app).put(`/api/admin/sellers/${seller.id}/approve`).set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("active");

      const [refetched] = await db.select().from(sellersTable).where(eq(sellersTable.id, seller.id));
      expect(refetched.status).toBe("active");
    });

    it("400s approving a seller that isn't pending_verification", async () => {
      const { seller } = await seedSeller({
        clerkIdSuffix: "approve-already-active",
        email: "approve-already-active@test.example",
        businessName: "Already Active Nursery",
        status: "active",
      });
      const res = await request(app).put(`/api/admin/sellers/${seller.id}/approve`).set(adminAuth());
      expect(res.status).toBe(400);
    });

    it("404s approving a seller id that doesn't exist", async () => {
      const res = await request(app).put("/api/admin/sellers/999999999/approve").set(adminAuth());
      expect(res.status).toBe(404);
    });

    it("reject: real admin HTTP call deletes a pending_verification seller row", async () => {
      const { seller } = await seedSeller({
        clerkIdSuffix: "reject-target",
        email: "reject-target@test.example",
        businessName: "Reject Target Nursery",
        status: "pending_verification",
      });

      const res = await request(app)
        .put(`/api/admin/sellers/${seller.id}/reject`)
        .set(adminAuth())
        .send({ reason: "Incomplete documents" });
      expect(res.status).toBe(200);

      const rows = await db.select().from(sellersTable).where(eq(sellersTable.id, seller.id));
      expect(rows).toHaveLength(0);
    });

    /**
     * Deliberately sends NO body (no .send() call) rather than {} or
     * { reason: ... } -- this test originally caught a real bug: the route
     * destructured `req.body` unconditionally, and express.json() leaves
     * req.body as `undefined` (not `{}`) when a request has no body at
     * all. Any admin client that PUTs /reject with no body (a plausible
     * real interaction -- reason is optional) 500'd instead of 400ing.
     * Fixed minimally in adminSellers.ts (`req.body ?? {}`) and verified
     * independently: with the fix reverted, this exact test failed with a
     * 500 (`Cannot destructure property 'reason' of 'req.body' as it is
     * undefined`); with the fix restored, it passes. See PART4A_HANDOFF.md.
     */
    it("400s rejecting a seller that isn't pending_verification", async () => {
      const { seller } = await seedSeller({
        clerkIdSuffix: "reject-active",
        email: "reject-active@test.example",
        businessName: "Reject Active Nursery",
        status: "active",
      });
      const res = await request(app).put(`/api/admin/sellers/${seller.id}/reject`).set(adminAuth());
      expect(res.status).toBe(400);
    });

    it("suspend: real admin HTTP call flips an active seller to suspended, and this has a real buyer-facing effect (listing becomes invisible)", async () => {
      const { seller } = await seedSeller({
        clerkIdSuffix: "suspend-target",
        email: "suspend-target@test.example",
        businessName: "Suspend Target Nursery",
        status: "active",
      });
      const listing = await seedListing({ productId, sellerId: seller.id });

      // Confirm the listing is visible to buyers BEFORE suspension, so the
      // "becomes invisible" assertion below is proven by a real before/after
      // state change through the real buyer-facing route, not assumed.
      const beforeRes = await request(app).get(`/api/products/${productId}/seller-listings`);
      expect(beforeRes.status).toBe(200);
      expect(beforeRes.body.some((r: any) => r.listing?.id === listing.id || r.id === listing.id)).toBe(true);

      const suspendRes = await request(app).put(`/api/admin/sellers/${seller.id}/suspend`).set(adminAuth());
      expect(suspendRes.status).toBe(200);
      expect(suspendRes.body.status).toBe("suspended");

      const [refetched] = await db.select().from(sellersTable).where(eq(sellersTable.id, seller.id));
      expect(refetched.status).toBe("suspended");

      const afterRes = await request(app).get(`/api/products/${productId}/seller-listings`);
      expect(afterRes.status).toBe(200);
      expect(afterRes.body.some((r: any) => r.listing?.id === listing.id || r.id === listing.id)).toBe(false);
    });

    it("400s suspending a seller that isn't active", async () => {
      const { seller } = await seedSeller({
        clerkIdSuffix: "suspend-pending",
        email: "suspend-pending@test.example",
        businessName: "Suspend Pending Nursery",
        status: "pending_verification",
      });
      const res = await request(app).put(`/api/admin/sellers/${seller.id}/suspend`).set(adminAuth());
      expect(res.status).toBe(400);
    });
  });

  describe("seller-payment-configs verify/unverify routes", () => {
    it("verify: real admin HTTP call actually flips isVerified to true in the DB (not a direct insert standing in for it)", async () => {
      const { seller } = await seedSeller({
        clerkIdSuffix: "payverify-seller",
        email: "payverify-seller@test.example",
        businessName: "Pay Verify Nursery",
      });
      const [config] = await db
        .insert(sellerPaymentConfigsTable)
        .values({
          sellerId: seller.id,
          provider: "bkash",
          merchantAppKey: "k",
          merchantAppSecret: "s",
          merchantUsername: "u",
          merchantPassword: "p",
          isVerified: false,
        })
        .returning();

      const res = await request(app).put(`/api/admin/seller-payment-configs/${config.id}/verify`).set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.isVerified).toBe(true);

      const [refetched] = await db.select().from(sellerPaymentConfigsTable).where(eq(sellerPaymentConfigsTable.id, config.id));
      expect(refetched.isVerified).toBe(true);
    });

    it("400s verifying a payment config that's already verified", async () => {
      const { seller } = await seedSeller({
        clerkIdSuffix: "payverify-dup",
        email: "payverify-dup@test.example",
        businessName: "Pay Verify Dup Nursery",
      });
      const config = await seedVerifiedPaymentConfig(seller.id);
      const res = await request(app).put(`/api/admin/seller-payment-configs/${config.id}/verify`).set(adminAuth());
      expect(res.status).toBe(400);
    });

    it("404s verifying a payment config id that doesn't exist", async () => {
      const res = await request(app).put("/api/admin/seller-payment-configs/999999999/verify").set(adminAuth());
      expect(res.status).toBe(404);
    });

    /**
     * Mutation-tested per the session brief's core lesson (from Part 3's own
     * fixed race test): a test asserting a specific behavior is not proof
     * of that behavior unless it's been shown to fail when that behavior is
     * removed. This test asserts the unverify route's listing reconciliation
     * (advance/both -> cod) actually fires when triggered through the real
     * HTTP route, not via a direct DB update standing in for it.
     *
     * Mutation-test proof (see PART4A_HANDOFF.md for the full transcript):
     * with the reconciliation UPDATE in adminSellers.ts's unverify-payment-
     * config route commented out, this exact test was re-run and FAILED
     * (`expected 'advance' to be 'cod'` -- the seeded advance listing kept
     * its original paymentMethod instead of being reconciled). The
     * reconciliation was then restored and this test was re-confirmed
     * passing (27/27).
     */
    it("unverify: real admin HTTP call flips isVerified false AND reconciles this seller's advance/both listings back to cod", async () => {
      const { seller } = await seedSeller({
        clerkIdSuffix: "payunverify-seller",
        email: "payunverify-seller@test.example",
        businessName: "Pay Unverify Nursery",
      });
      const config = await seedVerifiedPaymentConfig(seller.id);
      const advanceListing = await seedListing({ productId, sellerId: seller.id, paymentMethod: "advance" });
      const bothListing = await seedListing({ productId, sellerId: seller.id, paymentMethod: "both" });
      const codListing = await seedListing({ productId, sellerId: seller.id, paymentMethod: "cod" });

      const res = await request(app).put(`/api/admin/seller-payment-configs/${config.id}/unverify`).set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.isVerified).toBe(false);

      const [refetchedConfig] = await db.select().from(sellerPaymentConfigsTable).where(eq(sellerPaymentConfigsTable.id, config.id));
      expect(refetchedConfig.isVerified).toBe(false);

      const [refetchedAdvance] = await db.select().from(sellerListingsTable).where(eq(sellerListingsTable.id, advanceListing.id));
      expect(refetchedAdvance.paymentMethod).toBe("cod");

      const [refetchedBoth] = await db.select().from(sellerListingsTable).where(eq(sellerListingsTable.id, bothListing.id));
      expect(refetchedBoth.paymentMethod).toBe("cod");

      // A listing that was already "cod" should be untouched (not a
      // meaningful mutation-catch on its own, but confirms the WHERE
      // clause's ne(paymentMethod, 'cod') scoping isn't accidentally
      // touching rows it shouldn't).
      const [refetchedCod] = await db.select().from(sellerListingsTable).where(eq(sellerListingsTable.id, codListing.id));
      expect(refetchedCod.paymentMethod).toBe("cod");
    });

    it("400s unverifying a payment config that isn't currently verified", async () => {
      const { seller } = await seedSeller({
        clerkIdSuffix: "payunverify-notverified",
        email: "payunverify-notverified@test.example",
        businessName: "Pay Unverify Not Verified Nursery",
      });
      const [config] = await db
        .insert(sellerPaymentConfigsTable)
        .values({
          sellerId: seller.id,
          provider: "bkash",
          merchantAppKey: "k",
          merchantAppSecret: "s",
          merchantUsername: "u",
          merchantPassword: "p",
          isVerified: false,
        })
        .returning();
      const res = await request(app).put(`/api/admin/seller-payment-configs/${config.id}/unverify`).set(adminAuth());
      expect(res.status).toBe(400);
    });

    it("list route: ?verified=true / default (unverified) return the right rows", async () => {
      const { seller } = await seedSeller({
        clerkIdSuffix: "paylist-seller",
        email: "paylist-seller@test.example",
        businessName: "Pay List Nursery",
      });
      const verifiedConfig = await seedVerifiedPaymentConfig(seller.id);

      const verifiedRes = await request(app).get("/api/admin/seller-payment-configs?verified=true").set(adminAuth());
      expect(verifiedRes.status).toBe(200);
      expect(verifiedRes.body.some((c: any) => c.id === verifiedConfig.id)).toBe(true);

      const unverifiedRes = await request(app).get("/api/admin/seller-payment-configs").set(adminAuth());
      expect(unverifiedRes.status).toBe(200);
      expect(unverifiedRes.body.some((c: any) => c.id === verifiedConfig.id)).toBe(false);
    });
  });

  describe("seller-courier-configs verify/unverify routes", () => {
    it("verify: real admin HTTP call actually flips isVerified to true in the DB", async () => {
      const { seller } = await seedSeller({
        clerkIdSuffix: "courverify-seller",
        email: "courverify-seller@test.example",
        businessName: "Cour Verify Nursery",
      });
      const [config] = await db
        .insert(sellerCourierConfigsTable)
        .values({
          sellerId: seller.id,
          provider: "steadfast",
          apiKey: "encrypted-placeholder",
          apiSecret: "encrypted-placeholder",
          storeId: null,
          isVerified: false,
        })
        .returning();

      const res = await request(app).put(`/api/admin/seller-courier-configs/${config.id}/verify`).set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.isVerified).toBe(true);

      const [refetched] = await db.select().from(sellerCourierConfigsTable).where(eq(sellerCourierConfigsTable.id, config.id));
      expect(refetched.isVerified).toBe(true);
    });

    it("400s verifying a courier config that's already verified", async () => {
      const { seller } = await seedSeller({
        clerkIdSuffix: "courverify-dup",
        email: "courverify-dup@test.example",
        businessName: "Cour Verify Dup Nursery",
      });
      const config = await seedVerifiedCourierConfig(seller.id);
      const res = await request(app).put(`/api/admin/seller-courier-configs/${config.id}/verify`).set(adminAuth());
      expect(res.status).toBe(400);
    });

    it("404s verifying a courier config id that doesn't exist", async () => {
      const res = await request(app).put("/api/admin/seller-courier-configs/999999999/verify").set(adminAuth());
      expect(res.status).toBe(404);
    });

    /**
     * Unlike payment-config unverify, courier config has no listing field
     * to reconcile -- paymentMethod is unrelated to courier setup. What
     * Part 2's fix (and Phase 7's book-courier isVerified gate) actually
     * protects here is: book-courier requires config.isVerified === true
     * at the moment of the HTTP call (routes/orderShipments.ts, checked
     * live on every request, not cached). So the real downstream effect to
     * prove is that unverifying through this real admin route immediately
     * blocks a subsequent real book-courier HTTP call for that seller,
     * exactly as if the config had never been verified -- not just that
     * the DB row's isVerified column flips.
     *
     * Mutation-test proof (see PART4A_HANDOFF.md for the full transcript):
     * two separate mutations were run against this test, restored after
     * each. (1) The unverify route's isVerified update was changed to touch
     * an unrelated field instead (route still returns 200 + a config
     * object) -- test failed on `expected true to be false`, catching a
     * "reports success but doesn't persist" bug before it could even reach
     * the book-courier call. (2) With the DB flip restored correct,
     * orderShipments.ts's own `if (!config.isVerified)` gate in book-courier
     * was disabled -- test failed differently, `expected 502 to be 400`
     * (the route fell through to the real Steadfast network call instead of
     * being blocked), proving the book-courier assertion is independently
     * load-bearing and not redundant with the isVerified-flip assertion.
     * Both mutations were reverted and this exact test re-confirmed passing
     * (27/27) after each restoration.
     */
    it("unverify: real admin HTTP call flips isVerified false, and a subsequent real book-courier HTTP call is blocked by it", async () => {
      const { user, seller } = await seedSeller({
        clerkIdSuffix: "courunverify-seller",
        email: "courunverify-seller@test.example",
        businessName: "Cour Unverify Nursery",
        status: "active",
      });
      const config = await seedVerifiedCourierConfig(seller.id, "steadfast");
      const listing = await seedListing({ productId, sellerId: seller.id });

      const { seedOrder } = await import("./testDb");
      const order = await seedOrder({
        userIdClerk: buyerClerkId,
        sellerId: seller.id,
        listingId: listing.id,
        productId,
      });

      const unverifyRes = await request(app).put(`/api/admin/seller-courier-configs/${config.id}/unverify`).set(adminAuth());
      expect(unverifyRes.status).toBe(200);
      expect(unverifyRes.body.isVerified).toBe(false);

      const [refetchedConfig] = await db.select().from(sellerCourierConfigsTable).where(eq(sellerCourierConfigsTable.id, config.id));
      expect(refetchedConfig.isVerified).toBe(false);

      const sellerAuth = authHeader(user.clerkId, "courunverify-seller@test.example");
      const bookRes = await request(app)
        .post(`/api/seller/orders/${order.id}/book-courier`)
        .set(sellerAuth);
      expect(bookRes.status).toBe(400);
      expect(bookRes.body.error).toMatch(/verified/i);
    });

    it("400s unverifying a courier config that isn't currently verified", async () => {
      const { seller } = await seedSeller({
        clerkIdSuffix: "courunverify-notverified",
        email: "courunverify-notverified@test.example",
        businessName: "Cour Unverify Not Verified Nursery",
      });
      const [config] = await db
        .insert(sellerCourierConfigsTable)
        .values({
          sellerId: seller.id,
          provider: "steadfast",
          apiKey: "encrypted-placeholder",
          apiSecret: "encrypted-placeholder",
          storeId: null,
          isVerified: false,
        })
        .returning();
      const res = await request(app).put(`/api/admin/seller-courier-configs/${config.id}/unverify`).set(adminAuth());
      expect(res.status).toBe(400);
    });

    it("list route: ?verified=true / default (unverified) return the right rows", async () => {
      const { seller } = await seedSeller({
        clerkIdSuffix: "courlist-seller",
        email: "courlist-seller@test.example",
        businessName: "Cour List Nursery",
      });
      const verifiedConfig = await seedVerifiedCourierConfig(seller.id);

      const verifiedRes = await request(app).get("/api/admin/seller-courier-configs?verified=true").set(adminAuth());
      expect(verifiedRes.status).toBe(200);
      expect(verifiedRes.body.some((c: any) => c.id === verifiedConfig.id)).toBe(true);

      const unverifiedRes = await request(app).get("/api/admin/seller-courier-configs").set(adminAuth());
      expect(unverifiedRes.status).toBe(200);
      expect(unverifiedRes.body.some((c: any) => c.id === verifiedConfig.id)).toBe(false);
    });
  });

  describe("ownership/scoping: one admin action never touches a seller not named in the request", () => {
    it("verifying seller A's payment config does not affect seller B's payment config", async () => {
      const { seller: sellerA } = await seedSeller({
        clerkIdSuffix: "scope-pay-a",
        email: "scope-pay-a@test.example",
        businessName: "Scope Pay A Nursery",
      });
      const { seller: sellerB } = await seedSeller({
        clerkIdSuffix: "scope-pay-b",
        email: "scope-pay-b@test.example",
        businessName: "Scope Pay B Nursery",
      });
      const [configA] = await db
        .insert(sellerPaymentConfigsTable)
        .values({ sellerId: sellerA.id, provider: "bkash", merchantAppKey: "k", merchantAppSecret: "s", merchantUsername: "u", merchantPassword: "p", isVerified: false })
        .returning();
      const [configB] = await db
        .insert(sellerPaymentConfigsTable)
        .values({ sellerId: sellerB.id, provider: "bkash", merchantAppKey: "k2", merchantAppSecret: "s2", merchantUsername: "u2", merchantPassword: "p2", isVerified: false })
        .returning();

      const res = await request(app).put(`/api/admin/seller-payment-configs/${configA.id}/verify`).set(adminAuth());
      expect(res.status).toBe(200);

      const [refetchedB] = await db.select().from(sellerPaymentConfigsTable).where(eq(sellerPaymentConfigsTable.id, configB.id));
      expect(refetchedB.isVerified).toBe(false);
    });

    it("unverifying seller A's payment config does not reconcile seller B's listings", async () => {
      const { seller: sellerA } = await seedSeller({
        clerkIdSuffix: "scope-unverify-a",
        email: "scope-unverify-a@test.example",
        businessName: "Scope Unverify A Nursery",
      });
      const { seller: sellerB } = await seedSeller({
        clerkIdSuffix: "scope-unverify-b",
        email: "scope-unverify-b@test.example",
        businessName: "Scope Unverify B Nursery",
      });
      const configA = await seedVerifiedPaymentConfig(sellerA.id);
      await seedVerifiedPaymentConfig(sellerB.id);
      const listingB = await seedListing({ productId, sellerId: sellerB.id, paymentMethod: "advance" });

      const res = await request(app).put(`/api/admin/seller-payment-configs/${configA.id}/unverify`).set(adminAuth());
      expect(res.status).toBe(200);

      const [refetchedListingB] = await db.select().from(sellerListingsTable).where(eq(sellerListingsTable.id, listingB.id));
      expect(refetchedListingB.paymentMethod).toBe("advance");
    });

    it("suspending seller A does not affect seller B's status or listing visibility", async () => {
      const { seller: sellerA } = await seedSeller({
        clerkIdSuffix: "scope-suspend-a",
        email: "scope-suspend-a@test.example",
        businessName: "Scope Suspend A Nursery",
        status: "active",
      });
      const { seller: sellerB } = await seedSeller({
        clerkIdSuffix: "scope-suspend-b",
        email: "scope-suspend-b@test.example",
        businessName: "Scope Suspend B Nursery",
        status: "active",
      });
      const listingB = await seedListing({ productId, sellerId: sellerB.id });

      const res = await request(app).put(`/api/admin/sellers/${sellerA.id}/suspend`).set(adminAuth());
      expect(res.status).toBe(200);

      const [refetchedB] = await db.select().from(sellersTable).where(eq(sellersTable.id, sellerB.id));
      expect(refetchedB.status).toBe("active");

      const listingsRes = await request(app).get(`/api/products/${productId}/seller-listings`);
      expect(listingsRes.body.some((r: any) => r.listing?.id === listingB.id || r.id === listingB.id)).toBe(true);
    });
  });
});
