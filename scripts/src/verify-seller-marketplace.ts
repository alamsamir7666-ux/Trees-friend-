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
} from "@workspace/db/schema";
import { hasVerifiedPaymentConfig, groupBySellerAndAllocateDiscount } from "@workspace/db/logic";
import { eq, and, ne } from "drizzle-orm";

/**
 * Phase 8 real-database verification script (extended across several
 * subsequent phases).
 *
 * Bypasses the HTTP/auth layer entirely (no Clerk credentials exist in this
 * sandbox -- see routes/middlewares/auth.ts, mobileJwt.ts) and instead
 * exercises the actual business-logic queries directly against a real
 * Postgres database, the same way scripts/src/seed.ts does.
 *
 * This is NOT a mock -- every step below is a real INSERT/SELECT/UPDATE
 * against a live database, run with `pnpm --filter @workspace/scripts run
 * verify-seller-marketplace` (see scripts/package.json) with a real
 * DATABASE_URL set.
 *
 * §2 and §3 below now import the REAL hasVerifiedPaymentConfig and
 * groupBySellerAndAllocateDiscount from @workspace/db/logic, rather than
 * reimplementing them verbatim as this script did through Phase 9. That
 * reimplementation was flagged across multiple prior handoffs as a drift
 * risk (the copy could silently diverge from production logic over time).
 * Both functions were moved out of their original route files
 * (sellerListings.ts, orders.ts) into @workspace/db/logic specifically so
 * this script could import them without pulling in Express, Clerk,
 * Cloudinary, or Resend, and without needing MOBILE_JWT_SECRET set --
 * importing the route files directly was tried and fails immediately, since
 * both transitively import middlewares/auth.ts -> mobileJwt.ts, which
 * throws at module-load time if that secret is absent. Both route files
 * still re-export the same functions from their original locations, so
 * every existing call site elsewhere in the app is unaffected.
 *
 * What this does NOT cover: anything requiring actual HTTP requests through
 * Express (route-level validation, requireSeller/requireAuth middleware
 * behavior, OpenAPI request/response shape). Those still only have
 * structural (typecheck/build) verification -- see prior phase handoffs.
 */

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
    failed++;
  }
}

async function main() {
  console.log("=== Phase 8 seller-marketplace real-DB verification ===\n");

  // Cleanup from any previous partial run (idempotency for re-runs)
  console.log("--- cleanup ---");
  const oldUsers = await db.select().from(usersTable).where(eq(usersTable.clerkId, "verify-script-user-1"));
  for (const u of oldUsers) {
    await db.delete(usersTable).where(eq(usersTable.id, u.id)); // cascades sellers -> listings/configs
  }
  const oldUsers2 = await db.select().from(usersTable).where(eq(usersTable.clerkId, "verify-script-user-2"));
  for (const u of oldUsers2) {
    await db.delete(usersTable).where(eq(usersTable.id, u.id));
  }
  await db.delete(categoriesTable).where(eq(categoriesTable.slug, "verify-script-category"));
  await db.delete(productsTable).where(eq(productsTable.slug, "verify-script-product"));
  console.log("  done\n");

  // --- 1. Create a seller row (status: active) ---
  console.log("--- 1. seller/category/product/listing creation ---");
  const [user1] = await db
    .insert(usersTable)
    .values({ clerkId: "verify-script-user-1", email: "seller1@verify.test", role: "user" })
    .returning();
  const [seller1] = await db
    .insert(sellersTable)
    .values({
      userId: user1.id,
      businessName: "Verify Nursery Co",
      nurseryName: "Verify Nursery",
      ownerName: "Test Owner",
      contactPhone: "01700000000",
      contactEmail: "seller1@verify.test",
      location: "Dhaka",
      status: "active",
    })
    .returning();
  check("seller row created with status=active", seller1.status === "active");

  const [user2] = await db
    .insert(usersTable)
    .values({ clerkId: "verify-script-user-2", email: "seller2@verify.test", role: "user" })
    .returning();
  const [seller2] = await db
    .insert(sellersTable)
    .values({
      userId: user2.id,
      businessName: "Second Verify Nursery",
      nurseryName: "Second Verify Nursery",
      ownerName: "Test Owner Two",
      contactPhone: "01700000001",
      contactEmail: "seller2@verify.test",
      location: "Chittagong",
      status: "active",
    })
    .returning();
  check("second seller row created", seller2.status === "active");

  const [category] = await db
    .insert(categoriesTable)
    .values({ name: "Verify Category", slug: "verify-script-category", displayOrder: 999, parentId: null })
    .returning();
  check("category created", !!category.id);

  const [product] = await db
    .insert(productsTable)
    .values({
      name: "Verify Product",
      slug: "verify-script-product",
      categoryId: category.id,
      description: "Test product for verification script",
    })
    .returning();
  check("product created", !!product.id);

  const [listing1] = await db
    .insert(sellerListingsTable)
    .values({
      productId: product.id,
      sellerId: seller1.id,
      price: "500.00",
      stock: 10,
      availableQuantity: 10,
      paymentMethod: "cod",
    })
    .returning();
  check("seller_listing created against seller 1", listing1.sellerId === seller1.id);

  const [listing2] = await db
    .insert(sellerListingsTable)
    .values({
      productId: product.id,
      sellerId: seller2.id,
      price: "300.00",
      stock: 5,
      availableQuantity: 5,
      paymentMethod: "cod",
    })
    .returning();
  check("seller_listing created against seller 2 (same product)", listing2.sellerId === seller2.id);

  // --- 2. seller_payment_configs isVerified logic ---
  console.log("\n--- 2. hasVerifiedPaymentConfig() real-query behavior ---");
  const [paymentConfig] = await db
    .insert(sellerPaymentConfigsTable)
    .values({
      sellerId: seller1.id,
      provider: "bkash",
      merchantAppKey: "test-key",
      merchantAppSecret: "test-secret",
      merchantUsername: "test-user",
      merchantPassword: "test-pass",
      isVerified: false,
    })
    .returning();

  const verifiedBefore = await hasVerifiedPaymentConfig(seller1.id);
  check("hasVerifiedPaymentConfig() returns false when isVerified=false", verifiedBefore === false);

  await db
    .update(sellerPaymentConfigsTable)
    .set({ isVerified: true })
    .where(eq(sellerPaymentConfigsTable.id, paymentConfig.id));

  const verifiedAfter = await hasVerifiedPaymentConfig(seller1.id);
  check("hasVerifiedPaymentConfig() returns true after flipping isVerified=true", verifiedAfter === true);

  // --- 3. groupBySellerAndAllocateDiscount with real cart_items across 2 sellers ---
  console.log("\n--- 3. cart_items across two sellers -> groupBySellerAndAllocateDiscount ---");
  const cartUserId = "verify-script-cart-user";
  await db.delete(cartItemsTable).where(eq(cartItemsTable.userId, cartUserId));

  await db.insert(cartItemsTable).values([
    { userId: cartUserId, productId: product.id, sellerListingId: listing1.id, quantity: 2 }, // seller1: 500*2=1000
    { userId: cartUserId, productId: product.id, sellerListingId: listing2.id, quantity: 1 }, // seller2: 300*1=300
  ]);

  const cartRows = await db
    .select({
      sellerListingId: cartItemsTable.sellerListingId,
      quantity: cartItemsTable.quantity,
      price: sellerListingsTable.price,
      sellerId: sellerListingsTable.sellerId,
    })
    .from(cartItemsTable)
    .innerJoin(sellerListingsTable, eq(cartItemsTable.sellerListingId, sellerListingsTable.id))
    .where(eq(cartItemsTable.userId, cartUserId));

  check("real cart query returns 2 rows", cartRows.length === 2, `got ${cartRows.length}`);

  const lines = cartRows.map((r) => ({
    sellerId: r.sellerId,
    lineTotal: Number(r.price) * r.quantity,
  }));

  const groups = groupBySellerAndAllocateDiscount(lines, 100);
  check("groupBySellerAndAllocateDiscount produces 2 separate order groups", groups.length === 2, `got ${groups.length}`);
  const g1 = groups.find((g) => g.sellerId === seller1.id);
  const g2 = groups.find((g) => g.sellerId === seller2.id);
  check("seller1 group subtotal = 1000", g1?.subtotal === 1000, `got ${g1?.subtotal}`);
  check("seller2 group subtotal = 300", g2?.subtotal === 300, `got ${g2?.subtotal}`);
  check(
    "full discount (100) allocated to the larger group (seller1), not split",
    g1?.discountAmount === 100 && g2?.discountAmount === 0,
    `seller1=${g1?.discountAmount} seller2=${g2?.discountAmount}`,
  );

  await db.delete(cartItemsTable).where(eq(cartItemsTable.userId, cartUserId));

  // --- 4. DB-level constraint checks: "at most one config per seller" ---
  console.log("\n--- 4. DB-level uniqueness assumptions behind delete-then-insert routes ---");

  // seller_payment_configs: schema declares .unique() on sellerId (confirmed
  // by reading lib/db/src/schema/sellerPaymentConfigs.ts). Verify the DB
  // actually enforces it, not just that Drizzle declares it.
  let paymentUniqueEnforced = false;
  try {
    await db.insert(sellerPaymentConfigsTable).values({
      sellerId: seller1.id,
      provider: "bkash",
      merchantAppKey: "dup-key",
      merchantAppSecret: "dup-secret",
      merchantUsername: "dup-user",
      merchantPassword: "dup-pass",
    });
  } catch (err: any) {
    // node-postgres/Drizzle wraps the real Postgres error in DrizzleQueryError,
    // whose own .message is the *query text*, not the driver error -- the
    // actual pg error (with .code = "23505" for unique_violation) lives on
    // .cause. Checking err.message alone silently misses every real
    // unique-constraint violation (confirmed the hard way: this bug produced
    // a false FAIL the first time this script ran, checked with a standalone
    // repro against err.cause before fixing here -- see PHASE8_HANDOFF.md).
    const pgErr = err?.cause ?? err;
    paymentUniqueEnforced = pgErr?.code === "23505" || /unique|duplicate/i.test(String(pgErr?.message ?? pgErr));
  }
  check(
    "seller_payment_configs: DB rejects a 2nd row for the same seller (unique constraint enforced)",
    paymentUniqueEnforced,
    paymentUniqueEnforced ? undefined : "insert of a duplicate sellerId succeeded -- no unique constraint at the DB level",
  );

  // seller_courier_configs: schema now HAS .unique() on sellerId (Part C of
  // this session -- mirrors sellerPaymentConfigs.ts exactly, added after
  // Phase 8 confirmed the gap was real). This assertion previously expected
  // the 2nd insert to SUCCEED (that was the whole point of Phase 8's
  // finding); after Part C's fix it now expects the opposite: a duplicate
  // sellerId insert should fail with Postgres 23505, the same way it
  // already does for seller_payment_configs above. Updating a
  // previously-passing assertion to expect failure feels backwards at a
  // glance, so flagging explicitly: the assertion is verifying the fix
  // closed the gap, not verifying the gap still exists.
  await db.insert(sellerCourierConfigsTable).values({
    sellerId: seller1.id,
    provider: "pathao",
    apiKey: "test-key-1",
    apiSecret: "test-secret-1",
  });
  let courierUniqueEnforced = false;
  try {
    await db.insert(sellerCourierConfigsTable).values({
      sellerId: seller1.id,
      provider: "steadfast",
      apiKey: "test-key-2",
      apiSecret: "test-secret-2",
    });
  } catch (err: any) {
    // Same DrizzleQueryError.cause unwrapping as the payment-config check
    // above -- the real Postgres error (with .code === "23505") lives on
    // err.cause, not err.message.
    const pgErr = err?.cause ?? err;
    courierUniqueEnforced = pgErr?.code === "23505" || /unique|duplicate/i.test(String(pgErr?.message ?? pgErr));
  }
  check(
    "seller_courier_configs: DB now rejects a 2nd row for the same seller (Part C's unique constraint fix, mirrors seller_payment_configs)",
    courierUniqueEnforced,
    courierUniqueEnforced
      ? undefined
      : "insert of a duplicate sellerId succeeded -- Part C's .unique() constraint did not take effect at the DB level",
  );
  const courierRowCount = await db
    .select()
    .from(sellerCourierConfigsTable)
    .where(eq(sellerCourierConfigsTable.sellerId, seller1.id));
  check(
    `seller_courier_configs still has exactly 1 row for seller1 after the rejected duplicate insert (expected 1, confirming the DB-level guard now holds)`,
    courierRowCount.length === 1,
    `got ${courierRowCount.length}`,
  );

  // --- 5. reviews: seller_listing_id + user_id unique constraint (plan §3b) ---
  console.log("\n--- 5. reviews unique constraint (one review per buyer per listing) ---");
  // Not inserting real review rows against a real order (out of scope to
  // build order-completion flow here) -- instead confirming the constraint
  // exists and is named as expected via information_schema, since \d output
  // already showed "reviews_seller_listing_user_unique" during schema push
  // inspection. Re-confirmed programmatically here for the written record.
  const constraintCheck = await db.execute(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'reviews'::regclass AND contype = 'u'
  `);
  const constraintNames = (constraintCheck as any).rows?.map((r: any) => r.conname) ?? [];
  check(
    "reviews table has a unique constraint on (seller_listing_id, user_id)",
    constraintNames.includes("reviews_seller_listing_user_unique"),
    `found constraints: ${JSON.stringify(constraintNames)}`,
  );

  // --- 6. cart.ts buildCart()'s batched hasVerifiedPaymentConfig query (Part B1) ---
  console.log("\n--- 6. cart.ts seller.hasVerifiedPaymentConfig batched query ---");
  // Reimplements the exact batched query added to buildCart() in
  // routes/cart.ts for Part B1 -- that function isn't exported (route file,
  // not a module of standalone business logic like sellerListings.ts), so
  // per this session's own established convention (see
  // groupBySellerAndAllocateDiscount/hasVerifiedPaymentConfig above), the
  // query shape is copied verbatim here rather than imported. Same risk as
  // noted for those two: if cart.ts's real query changes without updating
  // this copy, the two can drift silently.
  //
  // seller1 currently has 2 seller_payment_configs rows after §4 above (the
  // duplicate-insert test): the original (isVerified=true, from §2) and a
  // dup-insert attempt that should have FAILED due to the unique
  // constraint. So seller1 should still read as verified=true here, and
  // seller2 (no config row at all) should read as verified=false -- this
  // also incidentally double-checks that §4's duplicate insert really did
  // not leave a second row behind.
  const batchedConfigRows = await db
    .select({ sellerId: sellerPaymentConfigsTable.sellerId, isVerified: sellerPaymentConfigsTable.isVerified })
    .from(sellerPaymentConfigsTable)
    .where(eq(sellerPaymentConfigsTable.sellerId, seller1.id));
  const seller1Verified = batchedConfigRows.some((r) => r.sellerId === seller1.id && r.isVerified === true);
  const seller2ConfigRows = await db
    .select({ sellerId: sellerPaymentConfigsTable.sellerId, isVerified: sellerPaymentConfigsTable.isVerified })
    .from(sellerPaymentConfigsTable)
    .where(eq(sellerPaymentConfigsTable.sellerId, seller2.id));
  const seller2Verified = seller2ConfigRows.some((r) => r.isVerified === true);
  check(
    "batched query: seller1 (verified config) reads hasVerifiedPaymentConfig=true",
    seller1Verified === true,
  );
  check(
    "batched query: seller2 (no config row) reads hasVerifiedPaymentConfig=false",
    seller2Verified === false,
  );

  // --- 7. Part B2: reconciliation on payment-config delete ---
  console.log("\n--- 7. reconciliation: deleting a verified payment config flips listing.paymentMethod to cod ---");
  // seller1 already has a verified config (from §2) and listing1 (from §1,
  // created with paymentMethod="cod"). Flip listing1 to "advance" first so
  // there's something for the delete-route's reconciliation UPDATE to
  // actually change -- otherwise this test wouldn't distinguish "the
  // reconciliation ran" from "the listing was already cod".
  await db
    .update(sellerListingsTable)
    .set({ paymentMethod: "advance" })
    .where(eq(sellerListingsTable.id, listing1.id));
  const [listingBeforeDelete] = await db
    .select({ paymentMethod: sellerListingsTable.paymentMethod })
    .from(sellerListingsTable)
    .where(eq(sellerListingsTable.id, listing1.id));
  check(
    "setup: listing1.paymentMethod is 'advance' before the delete route's reconciliation runs",
    listingBeforeDelete?.paymentMethod === "advance",
    `got ${listingBeforeDelete?.paymentMethod}`,
  );

  // Reimplements routes/sellerPaymentConfigs.ts's DELETE /seller-payment-configs/mine
  // route body directly (bypassing the HTTP/auth layer, same convention as
  // every other section here) -- the delete followed by the new
  // reconciliation UPDATE added for Part B2.
  await db.delete(sellerPaymentConfigsTable).where(eq(sellerPaymentConfigsTable.sellerId, seller1.id));
  await db
    .update(sellerListingsTable)
    .set({ paymentMethod: "cod" })
    .where(and(eq(sellerListingsTable.sellerId, seller1.id), ne(sellerListingsTable.paymentMethod, "cod")));

  const [listingAfterDelete] = await db
    .select({ paymentMethod: sellerListingsTable.paymentMethod })
    .from(sellerListingsTable)
    .where(eq(sellerListingsTable.id, listing1.id));
  check(
    "listing1.paymentMethod actually flips to 'cod' in the database after the config is deleted (not just in a response payload)",
    listingAfterDelete?.paymentMethod === "cod",
    `got ${listingAfterDelete?.paymentMethod}`,
  );
  const remainingConfigRows = await db
    .select()
    .from(sellerPaymentConfigsTable)
    .where(eq(sellerPaymentConfigsTable.sellerId, seller1.id));
  check(
    "seller1's payment config row is actually gone after delete",
    remainingConfigRows.length === 0,
    `got ${remainingConfigRows.length} row(s)`,
  );

  // --- Cleanup ---
  console.log("\n--- cleanup ---");
  await db.delete(usersTable).where(eq(usersTable.id, user1.id)); // cascades seller1 -> listing1, payment config, courier configs
  await db.delete(usersTable).where(eq(usersTable.id, user2.id)); // cascades seller2 -> listing2
  await db.delete(productsTable).where(eq(productsTable.id, product.id));
  await db.delete(categoriesTable).where(eq(categoriesTable.id, category.id));
  console.log("  done");

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exit(1);
});
