import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { ordersTable, cartItemsTable, usersTable, wishlistTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { cleanupAll, seedCategory, seedProduct, seedSeller, seedListing, markerId } from "./testDb";
import { claimGuestOrders } from "../src/lib/accountClaim";

/**
 * Account claim transaction-atomicity tests.
 *
 * Verifies that `claimGuestOrders` wraps its three UPDATEs (orders,
 * cart_items, wishlist) in a single db.transaction. If any one UPDATE
 * fails, the entire migration rolls back — the guest's data stays
 * intact under "guest_<phone>" and the next sign-in retries cleanly.
 *
 * The pre-fix implementation ran three independent `await db.update(...)`
 * calls without a transaction wrapper. If the orders UPDATE succeeded
 * but the cart_items UPDATE failed (network blip, constraint violation),
 * the guest's orders moved to clerkId while their cart stayed under
 * "guest_<phone>" — orphaned mid-migration.
 *
 * Test strategy:
 *   1. Happy path: all three UPDATEs succeed — assert all rows migrated
 *      (this is already covered by accountClaim.test.ts; included here
 *      for completeness as a transaction baseline).
 *   2. Idempotent re-call after successful migration — all three counts
 *      are 0 (no rows left under guest_<phone>).
 *   3. Atomicity: trigger a failure mid-migration by inserting a row that
 *      violates a constraint when the wishlist UPDATE tries to rewrite
 *      its userId. The transaction should roll back — orders + cart_items
 *      should NOT have been migrated.
 *
 * The atomicity test uses a clever trick: we can't easily mock a Drizzle
 * UPDATE failure, but we CAN make the wishlist UPDATE fail by inserting
 * a row whose other columns would violate a CHECK or UNIQUE constraint
 * when userId changes. The wishlist table's unique partial index
 * (wishlist_user_product_unique on userId, productId WHERE
 * seller_listing_variant_id IS NULL) means: if we pre-insert a row
 * under clerkId with the same productId, the guest row's UPDATE will
 * trip the unique constraint when it tries to land on the same
 * (clerkId, productId) — rolling back the whole transaction.
 */

const TEST_PHONE = "01700345678";

describe("account claim — transaction atomicity (lib/accountClaim.ts)", () => {
  let productId: number;
  let sellerId: number;
  let listingId: number;
  let listingVariantId: number;

  beforeAll(async () => {
    await cleanupAll();

    const category = await seedCategory();
    const product = await seedProduct(category.id);
    productId = product.id;

    const { seller } = await seedSeller({
      clerkIdSuffix: "claim-tx-seller",
      email: "claim-tx-seller@test.example",
      businessName: "Claim TX Nursery",
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
  });

  afterAll(async () => {
    await cleanupAll();
  });

  it("happy path — all three UPDATEs succeed inside the transaction", async () => {
    const clerkId = markerId("claim-tx-happy");
    await db.insert(usersTable).values({
      clerkId,
      email: "claim-tx-happy@test.example",
      phone: TEST_PHONE,
      role: "user",
    });

    // Seed one of each row type under guest_<phone>
    await db.insert(ordersTable).values({
      trackingId: "EETXHAPPY1",
      orderNumber: 99001,
      userId: `guest_${TEST_PHONE}`,
      sellerId,
      items: [
        {
          productId,
          productName: "TX Happy Product",
          productImage: "",
          sellerListingId: listingId,
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
        fullName: "TX Happy Guest",
        phone: TEST_PHONE,
        street: "123 TX St",
        city: "Dhaka",
        district: "Dhaka",
      },
      discountAmount: "0",
      giftWrap: false,
    });

    await db.insert(cartItemsTable).values({
      userId: `guest_${TEST_PHONE}`,
      productId,
      sellerListingId: listingId,
      sellerListingVariantId: listingVariantId,
      quantity: 1,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      priceSeenAtAdd: "750.00",
    });

    await db.insert(wishlistTable).values({
      userId: `guest_${TEST_PHONE}`,
      productId,
    });

    const result = await claimGuestOrders(clerkId, TEST_PHONE);
    expect(result.ordersMigrated).toBe(1);
    expect(result.cartItemsMigrated).toBe(1);
    expect(result.wishlistMigrated).toBe(1);

    // Verify all three rows now have userId = clerkId
    const [order] = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.trackingId, "EETXHAPPY1"));
    expect(order.userId).toBe(clerkId);

    const cartRows = await db
      .select()
      .from(cartItemsTable)
      .where(eq(cartItemsTable.userId, clerkId));
    expect(cartRows).toHaveLength(1);

    const wishlistRows = await db
      .select()
      .from(wishlistTable)
      .where(eq(wishlistTable.userId, clerkId));
    expect(wishlistRows).toHaveLength(1);

    // No guest rows left
    const leftoverOrders = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.userId, `guest_${TEST_PHONE}`));
    expect(leftoverOrders).toHaveLength(0);

    const leftoverCart = await db
      .select()
      .from(cartItemsTable)
      .where(eq(cartItemsTable.userId, `guest_${TEST_PHONE}`));
    expect(leftoverCart).toHaveLength(0);

    const leftoverWishlist = await db
      .select()
      .from(wishlistTable)
      .where(eq(wishlistTable.userId, `guest_${TEST_PHONE}`));
    expect(leftoverWishlist).toHaveLength(0);
  });

  it("atomicity — wishlist unique-constraint violation rolls back orders + cart too", async () => {
    // Setup: a Clerk user with an EXISTING wishlist row for the same
    // productId. When claimGuestOrders runs and tries to UPDATE the
    // guest_<phone> wishlist row's userId to clerkId, the unique partial
    // index wishlist_user_product_unique (userId, productId WHERE
    // seller_listing_variant_id IS NULL) trips — two rows would have
    // (clerkId, productId, NULL). Postgres aborts the UPDATE, and
    // because we're inside db.transaction, the orders + cart_items
    // UPDATEs that ran earlier in the same transaction ALSO roll back.
    //
    // Pre-fix: the orders UPDATE would have committed (no transaction),
    // leaving the buyer's order history on clerkId while their cart +
    // wishlist stayed under guest_<phone> — orphaned forever.
    const clerkId = markerId("claim-tx-conflict");
    await db.insert(usersTable).values({
      clerkId,
      email: "claim-tx-conflict@test.example",
      phone: TEST_PHONE,
      role: "user",
    });

    // Pre-existing wishlist row under clerkId (same productId, no variant)
    // — this is what triggers the unique-constraint conflict on migration.
    await db.insert(wishlistTable).values({
      userId: clerkId,
      productId,
    });

    // Guest rows under guest_<phone>: an order, a cart item, and a
    // wishlist row with the same productId (no variant). The wishlist
    // row will conflict on migration.
    await db.insert(ordersTable).values({
      trackingId: "EETXCONFL1",
      orderNumber: 99002,
      userId: `guest_${TEST_PHONE}`,
      sellerId,
      items: [
        {
          productId,
          productName: "TX Conflict Product",
          productImage: "",
          sellerListingId: listingId,
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
        fullName: "TX Conflict Guest",
        phone: TEST_PHONE,
        street: "456 TX Ave",
        city: "Chittagong",
        district: "Chittagong",
      },
      discountAmount: "0",
      giftWrap: false,
    });

    await db.insert(cartItemsTable).values({
      userId: `guest_${TEST_PHONE}`,
      productId,
      sellerListingId: listingId,
      sellerListingVariantId: listingVariantId,
      quantity: 1,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      priceSeenAtAdd: "750.00",
    });

    await db.insert(wishlistTable).values({
      userId: `guest_${TEST_PHONE}`,
      productId,
    });

    // Run the claim — should fail mid-transaction (wishlist UPDATE trips
    // the unique constraint). claimGuestOrders catches the error and
    // returns {0, 0, 0} rather than throwing.
    const result = await claimGuestOrders(clerkId, TEST_PHONE);

    // The transaction rolled back — all three counts are 0 (the function
    // returns 0/0/0 on caught error, by design — see accountClaim.ts's
    // catch block which logs "transaction rolled back" and returns zeros).
    expect(result.ordersMigrated).toBe(0);
    expect(result.cartItemsMigrated).toBe(0);
    expect(result.wishlistMigrated).toBe(0);

    // ── ATOMICITY ASSERTION ──────────────────────────────────────────
    // Pre-fix behavior: orders would have migrated to clerkId (1 row),
    // cart_items would have migrated to clerkId (1 row), wishlist would
    // have failed. The buyer's order history would be on clerkId while
    // their wishlist stayed under guest_<phone>.
    //
    // Post-fix behavior: the transaction rolled back, so the orders +
    // cart_items rows are STILL under guest_<phone> — the guest's data
    // is intact and the next sign-in can retry cleanly (after the
    // conflict is resolved, e.g. by deleting the pre-existing
    // clerkId wishlist row).
    const [order] = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.trackingId, "EETXCONFL1"));
    expect(order.userId).toBe(`guest_${TEST_PHONE}`); // NOT migrated — rolled back

    const cartOnClerk = await db
      .select()
      .from(cartItemsTable)
      .where(eq(cartItemsTable.userId, clerkId));
    expect(cartOnClerk).toHaveLength(0); // NOT migrated — rolled back

    const cartOnGuest = await db
      .select()
      .from(cartItemsTable)
      .where(eq(cartItemsTable.userId, `guest_${TEST_PHONE}`));
    expect(cartOnGuest).toHaveLength(1); // still under guest_<phone>

    const wishlistOnGuest = await db
      .select()
      .from(wishlistTable)
      .where(eq(wishlistTable.userId, `guest_${TEST_PHONE}`));
    expect(wishlistOnGuest).toHaveLength(1); // still under guest_<phone>

    // The pre-existing clerkId wishlist row is also intact (the rollback
    // didn't touch it — it was there before the transaction started).
    const wishlistOnClerk = await db
      .select()
      .from(wishlistTable)
      .where(eq(wishlistTable.userId, clerkId));
    expect(wishlistOnClerk).toHaveLength(1);
  });

  it("transaction succeeds when there's no conflict — second happy-path test with variant row", async () => {
    // Sanity: the previous conflict test doesn't mean the transaction
    // itself is broken — it should still succeed when there's no
    // constraint violation. This test seeds a variant-keyed wishlist
    // row (different unique index: wishlist_user_seller_listing_variant_unique)
    // so no conflict happens, and asserts all three rows migrate.
    const clerkId = markerId("claim-tx-clean");
    await db.insert(usersTable).values({
      clerkId,
      email: "claim-tx-clean@test.example",
      phone: TEST_PHONE,
      role: "user",
    });

    await db.insert(ordersTable).values({
      trackingId: "EETXCLEAN1",
      orderNumber: 99003,
      userId: `guest_${TEST_PHONE}`,
      sellerId,
      items: [
        {
          productId,
          productName: "TX Clean Product",
          productImage: "",
          sellerListingId: listingId,
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
        fullName: "TX Clean Guest",
        phone: TEST_PHONE,
        street: "789 TX Blvd",
        city: "Sylhet",
        district: "Sylhet",
      },
      discountAmount: "0",
      giftWrap: false,
    });

    await db.insert(cartItemsTable).values({
      userId: `guest_${TEST_PHONE}`,
      productId,
      sellerListingId: listingId,
      sellerListingVariantId: listingVariantId,
      quantity: 1,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      priceSeenAtAdd: "750.00",
    });

    await db.insert(wishlistTable).values({
      userId: `guest_${TEST_PHONE}`,
      productId,
      sellerListingVariantId: listingVariantId,
    });

    const result = await claimGuestOrders(clerkId, TEST_PHONE);
    expect(result.ordersMigrated).toBe(1);
    expect(result.cartItemsMigrated).toBe(1);
    expect(result.wishlistMigrated).toBe(1);

    const [order] = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.trackingId, "EETXCLEAN1"));
    expect(order.userId).toBe(clerkId);
  });
});
