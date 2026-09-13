import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { ordersTable, cartItemsTable, usersTable, wishlistTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { cleanupAll, seedCategory, seedProduct, seedSeller, seedListing, markerId } from "./testDb";
import { claimGuestOrders } from "../src/lib/accountClaim";

/**
 * Account claim tests — Part 4 of the Daraz-style guest checkout.
 *
 * Verifies that when a guest who previously placed orders (stored under
 * userId = "guest_<phone>") signs up with a Clerk account that has the
 * same phone number, their guest rows are migrated to the new clerkId.
 *
 * Now covers wishlist migration too (added alongside cart + orders).
 *
 * These tests call the `claimGuestOrders` library function directly
 * (bypassing the auth middleware, since simulating a real Clerk sign-in
 * in the test environment requires fake Clerk credentials). The auth
 * middleware calls the same function — this just tests the migration
 * logic in isolation.
 *
 * Flow:
 *   1. Create a guest order (userId = "guest_<phone>")
 *   2. Create a guest cart item (userId = "guest_<phone>")
 *   3. Create a guest wishlist row (userId = "guest_<phone>")
 *   4. Call claimGuestOrders(clerkId, phone)
 *   5. Verify the order's userId is now clerkId (not "guest_...")
 *   6. Verify the cart item's userId is now clerkId
 *   7. Verify the wishlist row's userId is now clerkId
 *   8. Verify idempotency: calling again is a no-op
 */

const TEST_PHONE = "01700345678";

describe("account claim (lib/accountClaim.ts)", () => {
  let productId: number;
  let sellerId: number;
  let listingId: number;
  let listingVariantId: number;
  let guestOrderTrackingId: string;

  beforeAll(async () => {
    await cleanupAll();

    const category = await seedCategory();
    const product = await seedProduct(category.id);
    productId = product.id;

    const { seller } = await seedSeller({
      clerkIdSuffix: "claim-seller",
      email: "claim-seller@test.example",
      businessName: "Claim Test Nursery",
    });
    sellerId = seller.id;

    const listing = await seedListing({
      productId,
      sellerId,
      price: "750.00",
      availableQuantity: 20,
    });
    listingId = listing.id;
    listingVariantId = listing._firstVariant.id;

    // Create a guest order directly in the DB (bypassing checkout) so we
    // have something to migrate. Use the guest_<phone> userId pattern.
    guestOrderTrackingId = "EECLAIM01";
    await db.insert(ordersTable).values({
      trackingId: guestOrderTrackingId,
      orderNumber: 99001,
      userId: `guest_${TEST_PHONE}`,
      sellerId,
      items: [
        {
          productId,
          productName: "Claim Test Product",
          productImage: "",
          sellerListingId: listing.id,
          sellerListingVariantId: listingVariantId,
          sellerId,
          quantity: 1,
          price: 750,
          deliveryCharge: 0,
        },
      ],
      totalAmount: "750.00",
      paymentMethod: "cod",
      paymentStatus: "pending",
      orderStatus: "pending",
      shippingAddress: {
        fullName: "Claim Test Guest",
        phone: TEST_PHONE,
        street: "123 Claim St",
        city: "Dhaka",
        district: "Dhaka",
      },
      discountAmount: "0",
      giftWrap: false,
    });

    // Create a guest cart item directly in the DB
    await db.insert(cartItemsTable).values({
      userId: `guest_${TEST_PHONE}`,
      productId,
      sellerListingId: listing.id,
      sellerListingVariantId: listingVariantId,
      quantity: 2,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      priceSeenAtAdd: "750.00",
    });

    // Create a guest wishlist row directly in the DB. Two rows: one
    // product-only (no seller-listing-variant) and one seller-listing-
    // variant — both must migrate to the new clerkId. Migration 0015
    // dropped the FK on wishlist.user_id, so this guest-scoped insert
    // lands cleanly (mirror of the cart_items pattern).
    await db.insert(wishlistTable).values({
      userId: `guest_${TEST_PHONE}`,
      productId,
    });
    await db.insert(wishlistTable).values({
      userId: `guest_${TEST_PHONE}`,
      productId,
      sellerListingVariantId: listingVariantId,
    });
  });

  afterAll(async () => {
    await cleanupAll();
  });

  it("migrates guest orders to the new clerkId", async () => {
    const clerkId = markerId("claim-user-1");

    // Create the user row (simulating what authenticate() does on first sign-in)
    await db.insert(usersTable).values({
      clerkId,
      email: "claim-user-1@test.example",
      phone: TEST_PHONE,
      role: "user",
    });

    // Run the claim
    const result = await claimGuestOrders(clerkId, TEST_PHONE);
    expect(result.ordersMigrated).toBe(1);
    expect(result.cartItemsMigrated).toBe(1);
    expect(result.wishlistMigrated).toBe(2);

    // Verify the order's userId is now the clerkId
    const [order] = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.trackingId, guestOrderTrackingId));
    expect(order.userId).toBe(clerkId);
    expect(order.userId).not.toBe(`guest_${TEST_PHONE}`);

    // Verify the cart item's userId is now the clerkId
    const [cartItem] = await db
      .select()
      .from(cartItemsTable)
      .where(eq(cartItemsTable.userId, clerkId));
    expect(cartItem).toBeDefined();
    expect(cartItem.productId).toBe(productId);
    expect(cartItem.quantity).toBe(2);

    // Verify both wishlist rows migrated to the clerkId (one product-only,
    // one seller-listing-variant). The userId was rewritten in place —
    // same row, same primary key, just a different userId value.
    const wishlistRows = await db
      .select()
      .from(wishlistTable)
      .where(eq(wishlistTable.userId, clerkId));
    expect(wishlistRows).toHaveLength(2);
    expect(wishlistRows.some((r) => r.sellerListingVariantId == null)).toBe(true);
    expect(wishlistRows.some((r) => r.sellerListingVariantId === listingVariantId)).toBe(true);

    // And no guest-scoped wishlist rows remain for this phone
    const leftoverGuestWishlist = await db
      .select()
      .from(wishlistTable)
      .where(eq(wishlistTable.userId, `guest_${TEST_PHONE}`));
    expect(leftoverGuestWishlist).toHaveLength(0);
  });

  it("is idempotent — calling again migrates 0 orders", async () => {
    const clerkId = markerId("claim-user-1"); // same clerkId as above

    // The orders have already been migrated — should be a no-op
    const result = await claimGuestOrders(clerkId, TEST_PHONE);
    expect(result.ordersMigrated).toBe(0);
    expect(result.cartItemsMigrated).toBe(0);
    expect(result.wishlistMigrated).toBe(0);
  });

  it("returns 0 migrations when no guest orders exist for the phone", async () => {
    const clerkId = markerId("claim-user-2");
    await db.insert(usersTable).values({
      clerkId,
      email: "claim-user-2@test.example",
      phone: "01700999888", // a phone with no guest orders
      role: "user",
    });

    const result = await claimGuestOrders(clerkId, "01700999888");
    expect(result.ordersMigrated).toBe(0);
    expect(result.cartItemsMigrated).toBe(0);
    expect(result.wishlistMigrated).toBe(0);
  });

  it("returns 0 migrations when phone is null", async () => {
    const clerkId = markerId("claim-user-3");
    const result = await claimGuestOrders(clerkId, null);
    expect(result.ordersMigrated).toBe(0);
    expect(result.cartItemsMigrated).toBe(0);
    expect(result.wishlistMigrated).toBe(0);
  });

  it("returns 0 migrations when phone is undefined", async () => {
    const clerkId = markerId("claim-user-4");
    const result = await claimGuestOrders(clerkId, undefined);
    expect(result.ordersMigrated).toBe(0);
    expect(result.cartItemsMigrated).toBe(0);
    expect(result.wishlistMigrated).toBe(0);
  });

  it("migrates multiple guest orders at once", async () => {
    // Create a second guest order for the same phone (different tracking ID)
    const secondTrackingId = "EECLAIM02";
    await db.insert(ordersTable).values({
      trackingId: secondTrackingId,
      orderNumber: 99002,
      userId: `guest_${TEST_PHONE}`,
      sellerId,
      items: [
        {
          productId,
          productName: "Claim Test Product",
          productImage: "",
          sellerListingId: listingId,
          sellerListingVariantId: listingVariantId,
          sellerId,
          quantity: 3,
          price: 750,
          deliveryCharge: 0,
        },
      ],
      totalAmount: "2250.00",
      paymentMethod: "cod",
      paymentStatus: "pending",
      orderStatus: "pending",
      shippingAddress: {
        fullName: "Claim Test Guest 2",
        phone: TEST_PHONE,
        street: "456 Claim Ave",
        city: "Chittagong",
        district: "Chittagong",
      },
      discountAmount: "0",
      giftWrap: false,
    });

    // Use a new clerkId for this test (the first test already claimed
    // the original order)
    const clerkId = markerId("claim-user-5");
    await db.insert(usersTable).values({
      clerkId,
      email: "claim-user-5@test.example",
      phone: TEST_PHONE,
      role: "user",
    });

    // Re-insert a guest cart item (the first test already migrated the original)
    await db.insert(cartItemsTable).values({
      userId: `guest_${TEST_PHONE}`,
      productId,
      sellerListingId: listingId,
      sellerListingVariantId: listingVariantId,
      quantity: 1,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      priceSeenAtAdd: "750.00",
    });

    // Re-insert a guest wishlist row (the first test already migrated the
    // originals). Reuses productId-only shape — the variant-row migration
    // was already asserted in the first test.
    await db.insert(wishlistTable).values({
      userId: `guest_${TEST_PHONE}`,
      productId,
    });

    const result = await claimGuestOrders(clerkId, TEST_PHONE);
    // Should migrate 1 order + 1 cart item + 1 wishlist row (the second batch)
    expect(result.ordersMigrated).toBe(1);
    expect(result.cartItemsMigrated).toBe(1);
    expect(result.wishlistMigrated).toBe(1);

    // Verify the second order migrated
    const [order] = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.trackingId, secondTrackingId));
    expect(order.userId).toBe(clerkId);
  });
});
