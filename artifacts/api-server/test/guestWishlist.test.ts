import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import { guestOtpsTable, wishlistTable } from "@workspace/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { cleanupAll, seedCategory, seedProduct, seedSeller, seedListing } from "./testDb";
import { generateAndSend } from "../src/lib/guestOtp";

/**
 * Guest wishlist HTTP tests — extends the Daraz-style guest checkout
 * (Parts 2/3/4 already covered cart + orders + account claim) to the
 * wishlist table.
 *
 * Verifies that a phone-verified guest can:
 *   1. Add product and seller-listing-variant items to wishlist
 *   2. Fetch their wishlist via GET /wishlist (scoped by guest_<phone>)
 *   3. Remove items from wishlist
 *   4. Merge a localStorage-shaped wishlist payload via POST /wishlist/merge
 *   5. Have their wishlist isolated from other guests (different phone)
 *
 * Flow:
 *   1. Verify a guest phone → get guest JWT
 *   2. Add items via POST /wishlist/:productId and POST /wishlist/seller-listing-variant/:variantId
 *   3. Verify GET /wishlist returns them
 *   4. Verify POST /wishlist/merge is idempotent (re-merge = no-op)
 *   5. Verify a second guest's wishlist doesn't leak into the first's
 */

const TEST_PHONE_A = "01700123456";
const TEST_PHONE_B = "01700654321";

describe("guest wishlist (HTTP)", () => {
  let guestTokenA: string;
  let guestTokenB: string;
  let productId: number;
  let sellerAId: number;
  let listingVariantAId: number;
  let listingVariantBId: number;
  let sellerBId: number;

  beforeAll(async () => {
    await cleanupAll();

    const category = await seedCategory();
    const product = await seedProduct(category.id);
    productId = product.id;

    const { seller: sellerA } = await seedSeller({
      clerkIdSuffix: "guest-wishlist-seller-a",
      email: "guest-wishlist-a@test.example",
      businessName: "Guest Wishlist Nursery A",
    });
    sellerAId = sellerA.id;

    const { seller: sellerB } = await seedSeller({
      clerkIdSuffix: "guest-wishlist-seller-b",
      email: "guest-wishlist-b@test.example",
      businessName: "Guest Wishlist Nursery B",
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

    // Verify both guest phones and get JWTs.
    const { code: codeA } = await generateAndSend(TEST_PHONE_A);
    const verifyResA = await request(app)
      .post("/api/auth/guest-otp/verify")
      .send({ phone: TEST_PHONE_A, code: codeA });
    guestTokenA = verifyResA.body.guestToken;

    const { code: codeB } = await generateAndSend(TEST_PHONE_B);
    const verifyResB = await request(app)
      .post("/api/auth/guest-otp/verify")
      .send({ phone: TEST_PHONE_B, code: codeB });
    guestTokenB = verifyResB.body.guestToken;
  });

  afterAll(async () => {
    await cleanupAll();
  });

  beforeEach(async () => {
    // Clean wishlist + OTP rows between tests
    await db.delete(wishlistTable).where(eq(wishlistTable.userId, `guest_${TEST_PHONE_A}`));
    await db.delete(wishlistTable).where(eq(wishlistTable.userId, `guest_${TEST_PHONE_B}`));
    await db.delete(guestOtpsTable).where(eq(guestOtpsTable.phone, TEST_PHONE_A));
    await db.delete(guestOtpsTable).where(eq(guestOtpsTable.phone, TEST_PHONE_B));
  });

  it("rejects wishlist mutations without a guest JWT or Clerk token", async () => {
    const res = await request(app).post(`/api/wishlist/${productId}`).send({});
    expect(res.status).toBe(401);
  });

  it("guest adds a product to wishlist via POST /wishlist/:productId", async () => {
    const res = await request(app)
      .post(`/api/wishlist/${productId}`)
      .set("Authorization", `Bearer ${guestTokenA}`);
    expect(res.status).toBe(200);

    // Verify the row landed under guest_<phone>
    const [row] = await db
      .select()
      .from(wishlistTable)
      .where(
        and(
          eq(wishlistTable.userId, `guest_${TEST_PHONE_A}`),
          eq(wishlistTable.productId, productId),
          isNull(wishlistTable.sellerListingVariantId),
        ),
      );
    expect(row).toBeDefined();
    expect(row?.userId).toBe(`guest_${TEST_PHONE_A}`);
    expect(row?.productId).toBe(productId);
    expect(row?.sellerListingVariantId).toBeNull();
  });

  it("guest adds a seller-listing variant to wishlist via POST /wishlist/seller-listing-variant/:variantId", async () => {
    const res = await request(app)
      .post(`/api/wishlist/seller-listing-variant/${listingVariantAId}`)
      .set("Authorization", `Bearer ${guestTokenA}`);
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(wishlistTable)
      .where(
        and(
          eq(wishlistTable.userId, `guest_${TEST_PHONE_A}`),
          eq(wishlistTable.sellerListingVariantId, listingVariantAId),
        ),
      );
    expect(row).toBeDefined();
    expect(row?.productId).toBe(productId);
    expect(row?.sellerListingVariantId).toBe(listingVariantAId);
  });

  it("guest fetches their wishlist via GET /wishlist", async () => {
    // Seed two rows directly: one product, one seller-listing variant
    await db.insert(wishlistTable).values({
      userId: `guest_${TEST_PHONE_A}`,
      productId,
    });
    await db.insert(wishlistTable).values({
      userId: `guest_${TEST_PHONE_A}`,
      productId,
      sellerListingVariantId: listingVariantAId,
    });

    const res = await request(app)
      .get("/api/wishlist")
      .set("Authorization", `Bearer ${guestTokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].productId).toBe(productId);
    expect(res.body.sellerListings).toHaveLength(1);
    expect(res.body.sellerListings[0].sellerListingVariantId).toBe(listingVariantAId);
  });

  it("guest removes a product wishlist row via DELETE /wishlist/:productId", async () => {
    await db.insert(wishlistTable).values({
      userId: `guest_${TEST_PHONE_A}`,
      productId,
    });

    const res = await request(app)
      .delete(`/api/wishlist/${productId}`)
      .set("Authorization", `Bearer ${guestTokenA}`);
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(wishlistTable)
      .where(
        and(
          eq(wishlistTable.userId, `guest_${TEST_PHONE_A}`),
          eq(wishlistTable.productId, productId),
          isNull(wishlistTable.sellerListingVariantId),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("guest removes a seller-listing variant wishlist row via DELETE /wishlist/seller-listing-variant/:variantId", async () => {
    await db.insert(wishlistTable).values({
      userId: `guest_${TEST_PHONE_A}`,
      productId,
      sellerListingVariantId: listingVariantAId,
    });

    const res = await request(app)
      .delete(`/api/wishlist/seller-listing-variant/${listingVariantAId}`)
      .set("Authorization", `Bearer ${guestTokenA}`);
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(wishlistTable)
      .where(eq(wishlistTable.sellerListingVariantId, listingVariantAId));
    expect(rows).toHaveLength(0);
  });

  it("POST /wishlist/merge merges products + variants, is idempotent on re-merge", async () => {
    // Empty merge: no-op
    const emptyRes = await request(app)
      .post("/api/wishlist/merge")
      .set("Authorization", `Bearer ${guestTokenA}`)
      .send({ products: [], sellerListingVariants: [] });
    expect(emptyRes.status).toBe(200);
    expect(emptyRes.body.merged).toBe(0);
    expect(emptyRes.body.skipped).toEqual([]);

    // First merge: 1 product + 1 variant
    const firstRes = await request(app)
      .post("/api/wishlist/merge")
      .set("Authorization", `Bearer ${guestTokenA}`)
      .send({
        products: [{ productId }],
        sellerListingVariants: [{ sellerListingVariantId: listingVariantAId }],
      });
    expect(firstRes.status).toBe(200);
    expect(firstRes.body.merged).toBe(2);
    expect(firstRes.body.skipped).toEqual([]);

    // Re-merge the same payload: should be a no-op (idempotent via ON
    // CONFLICT DO NOTHING on the unique partial indexes).
    const secondRes = await request(app)
      .post("/api/wishlist/merge")
      .set("Authorization", `Bearer ${guestTokenA}`)
      .send({
        products: [{ productId }],
        sellerListingVariants: [{ sellerListingVariantId: listingVariantAId }],
      });
    expect(secondRes.status).toBe(200);
    expect(secondRes.body.merged).toBe(0);
    expect(secondRes.body.skipped).toEqual([]);
  });

  it("POST /wishlist/merge skips deleted products / variants in skipped[]", async () => {
    const res = await request(app)
      .post("/api/wishlist/merge")
      .set("Authorization", `Bearer ${guestTokenA}`)
      .send({
        products: [{ productId: 9999999 }], // doesn't exist
        sellerListingVariants: [{ sellerListingVariantId: 9999999 }], // doesn't exist
      });
    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(0);
    expect(res.body.skipped).toHaveLength(2);
    expect(res.body.skipped[0].reason).toContain("no longer exists");
    expect(res.body.skipped[1].reason).toContain("no longer exists");
  });

  it("two guests have isolated wishlists (guest A's items not visible to guest B)", async () => {
    // Guest A wishlists a product
    await request(app)
      .post(`/api/wishlist/${productId}`)
      .set("Authorization", `Bearer ${guestTokenA}`);
    // Guest B wishlists a different seller's variant
    await request(app)
      .post(`/api/wishlist/seller-listing-variant/${listingVariantBId}`)
      .set("Authorization", `Bearer ${guestTokenB}`);

    // Guest A sees only their own product row
    const resA = await request(app)
      .get("/api/wishlist")
      .set("Authorization", `Bearer ${guestTokenA}`);
    expect(resA.body.products).toHaveLength(1);
    expect(resA.body.products[0].productId).toBe(productId);
    expect(resA.body.sellerListings).toHaveLength(0);

    // Guest B sees only their own variant row
    const resB = await request(app)
      .get("/api/wishlist")
      .set("Authorization", `Bearer ${guestTokenB}`);
    expect(resB.body.products).toHaveLength(0);
    expect(resB.body.sellerListings).toHaveLength(1);
    expect(resB.body.sellerListings[0].sellerListingVariantId).toBe(listingVariantBId);
  });

  it("rejects an invalid guest JWT", async () => {
    const res = await request(app)
      .get("/api/wishlist")
      .set("Authorization", "Bearer not-a-real-jwt");
    expect(res.status).toBe(401);
  });
});
