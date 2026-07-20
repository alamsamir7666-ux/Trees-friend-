import { db } from "@workspace/db";
import {
  usersTable,
  sellersTable,
  categoriesTable,
  productsTable,
  sellerListingsTable,
  sellerPaymentConfigsTable,
  sellerCourierConfigsTable,
  cartItemsTable,
  ordersTable,
  orderShipmentsTable,
} from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";
import { encryptCredential } from "../src/lib/credentialEncryption";

/**
 * Fixture strategy: dedicated test database + a fixed marker prefix,
 * truncate-by-marker before and after each test file.
 *
 * Why not transactions-per-test with rollback: several of the flows under
 * test (book-courier's concurrent-request race, in particular) need two
 * REAL concurrent HTTP requests to actually race against each other inside
 * the SAME committed transaction-visibility window as the running server.
 * Wrapping each test in an outer transaction that's rolled back afterwards
 * would mean the two concurrent requests are either (a) two separate
 * connections that can't see each other's uncommitted inserts, which
 * defeats the point of testing a race at all, or (b) forced onto one
 * connection/transaction, which serializes them and cannot reproduce the
 * race either. A real commit-per-request against a real, shared connection
 * pool -- exactly what the running server does in production -- is
 * required for that specific test to mean anything. Once real commits are
 * in play for one test, per-test rollback isn't an option for the rest of
 * the suite either (test order and commit visibility would get confusing
 * fast), so this file uses one consistent strategy everywhere: real
 * commits, cleaned up by a marker.
 *
 * Why not a full schema drop/recreate per test file: this project already
 * has a fast, idempotent "delete by known marker" pattern in
 * scripts/src/verify-seller-marketplace.ts; reusing that convention here
 * (rather than inventing schema-recreation machinery) keeps the two test
 * layers consistent and keeps each test file fast (no drizzle-kit push
 * per file).
 *
 * Every row this test suite creates is tagged so cleanup can find it
 * unambiguously and rerun safely even after a crashed previous run:
 *   - users.clerkId always starts with TEST_MARKER
 *   - categories.slug / products.slug always start with TEST_MARKER
 * Deleting matching `users` rows cascades (onDelete: "cascade") through
 * sellers -> seller_listings / seller_payment_configs / seller_courier_configs,
 * and through cart_items / orders (orders.userId is NOT a FK -- see
 * cleanupAll's explicit orders delete below). Deleting matching `products`
 * rows cascades through seller_listings referencing them.
 */
export const TEST_MARKER = "httptest_";

/**
 * IMPORTANT: every clerkId used to sign a mobile JWT in this suite (via
 * authHeader/mintMobileJwt in authHelper.ts) MUST be the exact, already-
 * prefixed clerkId returned by a seed* function below (e.g. `user.clerkId`,
 * `seller.user.clerkId`) -- never the raw clerkIdSuffix string passed
 * into seedUser/seedSeller. seedUser/seedSeller apply TEST_MARKER
 * internally so cleanupAll() can find every row this suite creates; if a
 * test signs a JWT for the raw suffix instead of the returned clerkId, the
 * token's clerkId claim won't match any seeded row, resolveIdentity's
 * "no existing user -> auto-create" path in requireAuth will silently
 * create an UNMARKED users row for it, and requireSeller will then 403
 * with "You don't have a seller account" even though a seller row exists
 * under the correctly-marked clerkId. That auto-created row also won't be
 * caught by cleanupAll's marker-prefix delete, leaking state between runs.
 */
export function markerId(suffix: string): string {
  return `${TEST_MARKER}${suffix}`;
}

/** Deletes every row this suite could have created, in FK-safe order. Safe to call before AND after a run. */
export async function cleanupAll(): Promise<void> {
  // orders.userId is a free-text clerkId column, not an FK -- must clean
  // explicitly by prefix rather than relying on a users-row cascade.
  const staleOrders = await db.select({ id: ordersTable.id }).from(ordersTable).where(like(ordersTable.userId, `${TEST_MARKER}%`));
  for (const o of staleOrders) {
    await db.delete(orderShipmentsTable).where(eq(orderShipmentsTable.orderId, o.id));
    await db.delete(ordersTable).where(eq(ordersTable.id, o.id));
  }

  const staleUsers = await db.select({ id: usersTable.id, clerkId: usersTable.clerkId }).from(usersTable).where(like(usersTable.clerkId, `${TEST_MARKER}%`));
  for (const u of staleUsers) {
    // Cascades: sellers -> seller_listings, seller_payment_configs, seller_courier_configs.
    // cart_items.userId is also free-text (clerkId), clean explicitly too.
    await db.delete(cartItemsTable).where(eq(cartItemsTable.userId, u.clerkId));
    await db.delete(usersTable).where(eq(usersTable.id, u.id));
  }

  await db.delete(productsTable).where(like(productsTable.slug, `${TEST_MARKER}%`));
  await db.delete(categoriesTable).where(like(categoriesTable.slug, `${TEST_MARKER}%`));
}

let categoryCounter = 0;
let productCounter = 0;

/** Creates a category (subcategory, parentId null is fine -- productsTable.categoryId doesn't enforce level-2-only at the DB layer). */
export async function seedCategory() {
  categoryCounter += 1;
  const [category] = await db
    .insert(categoriesTable)
    .values({
      name: `Test Category ${categoryCounter}`,
      slug: markerId(`category-${categoryCounter}-${Date.now()}`),
    })
    .returning();
  return category;
}

/** Creates a product (variety) under the given category. */
export async function seedProduct(categoryId: number) {
  productCounter += 1;
  const [product] = await db
    .insert(productsTable)
    .values({
      name: `Test Product ${productCounter}`,
      slug: markerId(`product-${productCounter}-${Date.now()}`),
      categoryId,
      description: "Test fixture product",
      images: ["https://example.com/placeholder.jpg"],
    })
    .returning();
  return product;
}

interface SeedUserOptions {
  clerkIdSuffix: string;
  email: string;
  role?: "user" | "admin";
}

/** Creates a plain users row (no sellers row) -- represents a buyer, or a user who hasn't onboarded as a seller. */
export async function seedUser(opts: SeedUserOptions) {
  const [user] = await db
    .insert(usersTable)
    .values({
      clerkId: markerId(opts.clerkIdSuffix),
      email: opts.email,
      role: opts.role ?? "user",
    })
    .returning();
  return user;
}

interface SeedSellerOptions {
  clerkIdSuffix: string;
  email: string;
  businessName: string;
  status?: "pending_verification" | "active" | "suspended" | "vacation";
}

/** Creates a users row + a sellers row for it (the combination requireSeller/requireAuth resolve end-to-end via resolveIdentity -> DB upsert -> role/status resolution). */
export async function seedSeller(opts: SeedSellerOptions) {
  const user = await seedUser({ clerkIdSuffix: opts.clerkIdSuffix, email: opts.email });
  const [seller] = await db
    .insert(sellersTable)
    .values({
      userId: user.id,
      businessName: opts.businessName,
      nurseryName: opts.businessName,
      ownerName: "Test Owner",
      contactPhone: "01700000000",
      contactEmail: opts.email,
      location: "Dhaka",
      status: opts.status ?? "active",
    })
    .returning();
  return { user, seller };
}

/** Inserts a verified seller_payment_configs row directly (bypassing the route, same as verify-seller-marketplace.ts -- admin verification isn't under test here, only its downstream enforcement). */
export async function seedVerifiedPaymentConfig(sellerId: number) {
  const [config] = await db
    .insert(sellerPaymentConfigsTable)
    .values({
      sellerId,
      provider: "bkash",
      merchantAppKey: "test-app-key",
      merchantAppSecret: "test-app-secret",
      merchantUsername: "test-username",
      merchantPassword: "test-password",
      isVerified: true,
    })
    .returning();
  return config;
}

/**
 * Inserts a verified seller_courier_configs row directly for the given
 * provider, with apiKey/apiSecret run through the REAL encryptCredential
 * (not stored as plaintext) -- routes/orderShipments.ts's book-courier
 * calls decryptCredential() on these fields before calling out to the
 * courier adapter, so a plaintext fixture value would throw a "Malformed
 * encrypted credential" error the moment book-courier tried to decrypt it,
 * unrelated to anything this suite is actually testing.
 */
export async function seedVerifiedCourierConfig(sellerId: number, provider: "pathao" | "steadfast" = "steadfast") {
  const [config] = await db
    .insert(sellerCourierConfigsTable)
    .values({
      sellerId,
      provider,
      apiKey: encryptCredential("test-api-key"),
      apiSecret: encryptCredential(provider === "pathao" ? "test-secret|test-user|test-pass" : "test-api-secret"),
      storeId: provider === "pathao" ? "12345" : null,
      isVerified: true,
    })
    .returning();
  return config;
}

interface SeedListingOptions {
  productId: number;
  sellerId: number;
  price?: string;
  stock?: number;
  availableQuantity?: number;
  approvalStatus?: "pending" | "approved" | "rejected";
  visibility?: "public" | "hidden";
  paymentMethod?: "cod" | "advance" | "both";
}

export async function seedListing(opts: SeedListingOptions) {
  const [listing] = await db
    .insert(sellerListingsTable)
    .values({
      productId: opts.productId,
      sellerId: opts.sellerId,
      price: opts.price ?? "500.00",
      stock: opts.stock ?? 10,
      availableQuantity: opts.availableQuantity ?? 10,
      approvalStatus: opts.approvalStatus ?? "approved",
      visibility: opts.visibility ?? "public",
      paymentMethod: opts.paymentMethod ?? "cod",
    })
    .returning();
  return listing;
}

interface SeedOrderOptions {
  userIdClerk: string;
  sellerId: number;
  listingId: number;
  productId: number;
  quantity?: number;
  price?: number;
}

/** Creates an orders row directly shaped like a real marketplace order (one seller, one seller-listing line) -- for tests that need an existing order (shipment routes) without re-driving the full checkout flow. */
export async function seedOrder(opts: SeedOrderOptions) {
  const quantity = opts.quantity ?? 1;
  const price = opts.price ?? 500;
  const [order] = await db
    .insert(ordersTable)
    .values({
      trackingId: markerId(`order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      userId: opts.userIdClerk,
      sellerId: opts.sellerId,
      items: [
        {
          productId: opts.productId,
          productName: "Test Product",
          productImage: "https://example.com/placeholder.jpg",
          sellerListingId: opts.listingId,
          sellerId: opts.sellerId,
          quantity,
          price,
          deliveryCharge: 0,
        },
      ],
      totalAmount: String(price * quantity),
      paymentMethod: "cod",
      shippingAddress: {
        fullName: "Test Buyer",
        phone: "01800000000",
        street: "123 Test Street",
        city: "Dhaka",
        district: "Dhaka",
      },
    })
    .returning();
  return order;
}
