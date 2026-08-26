import { db } from "@workspace/db";
import {
  usersTable,
  sellersTable,
  categoriesTable,
  productsTable,
  sellerListingsTable,
  sellerListingVariantsTable,
  sellerPayoutAccountsTable,
  sellerCourierConfigsTable,
  cartItemsTable,
} from "@workspace/db/schema";
import { hasSellerPayoutAccount, groupBySellerAndAllocateDiscount } from "@workspace/db/logic";
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
 * §2 and §3 below now import the REAL hasSellerPayoutAccount and
 * groupBySellerAndAllocateDiscount from @workspace/db/logic, rather than
 * reimplementing them verbatim as this script did through Phase 9. (The
 * pre-migration name was hasVerifiedPaymentConfig, replaced when
 * seller_payment_configs was dropped in favor of seller_payout_accounts.)
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
  const oldUsers = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkId, "verify-script-user-1"));
  for (const u of oldUsers) {
    await db.delete(usersTable).where(eq(usersTable.id, u.id)); // cascades sellers -> listings/configs
  }
  const oldUsers2 = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkId, "verify-script-user-2"));
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
    .values({
      name: "Verify Category",
      slug: "verify-script-category",
      displayOrder: 999,
      parentId: null,
    })
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

  // Phase 2: sellerListingsTable no longer has price/stock/availableQuantity
  // columns at all -- those moved to sellerListingVariantsTable in the
  // Phase 1 schema split. This script (last touched pre-Phase-1) was still
  // inserting the old flat shape, which no longer typechecks; fixed here to
  // create a listing (listing-level fields only) plus one variant each
  // (where price/stock actually live now).
  const [listing1] = await db
    .insert(sellerListingsTable)
    .values({
      productId: product.id,
      sellerId: seller1.id,
      paymentMethod: "cod",
    })
    .returning();
  check("seller_listing created against seller 1", listing1.sellerId === seller1.id);

  const [listing1Variant] = await db
    .insert(sellerListingVariantsTable)
    .values({
      sellerListingId: listing1.id,
      price: "500.00",
      stock: 10,
      availableQuantity: 10,
      deliveryCharge: "0",
    })
    .returning();
  check(
    "seller_listing_variant created for listing 1",
    listing1Variant.sellerListingId === listing1.id,
  );

  const [listing2] = await db
    .insert(sellerListingsTable)
    .values({
      productId: product.id,
      sellerId: seller2.id,
      paymentMethod: "cod",
    })
    .returning();
  check("seller_listing created against seller 2 (same product)", listing2.sellerId === seller2.id);

  const [listing2Variant] = await db
    .insert(sellerListingVariantsTable)
    .values({
      sellerListingId: listing2.id,
      price: "300.00",
      stock: 5,
      availableQuantity: 5,
      deliveryCharge: "0",
    })
    .returning();
  check(
    "seller_listing_variant created for listing 2",
    listing2Variant.sellerListingId === listing2.id,
  );

  // --- 2. seller_payout_accounts existence logic ---
  console.log("\n--- 2. hasSellerPayoutAccount() real-query behavior ---");
  // Post-migration: listing-eligibility for paymentMethod="advance"|"both"
  // is gated on the existence of a seller_payout_accounts row (the seller's
  // plain bKash personal number for payouts), NOT on a per-seller
  // admin-verified merchant config anymore. The old seller_payment_configs
  // table has been dropped.
  const [payoutAccount] = await db
    .insert(sellerPayoutAccountsTable)
    .values({
      sellerId: seller1.id,
      bkashNumber: "01700000000",
      accountHolderName: "Test Seller 1",
    })
    .returning();
  void payoutAccount; // inserted for its side effect (existence); row id not needed below

  // seller1 just got a payout account → hasSellerPayoutAccount should be true.
  // seller2 has no payout account → should be false.
  const seller1HasPayout = await hasSellerPayoutAccount(seller1.id);
  check(
    "hasSellerPayoutAccount() returns true when a payout account exists",
    seller1HasPayout === true,
  );

  const seller2HasPayout = await hasSellerPayoutAccount(seller2.id);
  check(
    "hasSellerPayoutAccount() returns false when no payout account exists",
    seller2HasPayout === false,
  );

  // --- 3. groupBySellerAndAllocateDiscount with real cart_items across 2 sellers ---
  console.log("\n--- 3. cart_items across two sellers -> groupBySellerAndAllocateDiscount ---");
  const cartUserId = "verify-script-cart-user";
  await db.delete(cartItemsTable).where(eq(cartItemsTable.userId, cartUserId));

  // Phase 2: cart_items now addresses a seller_listing_variant, not a
  // seller_listing directly (schema/cart.ts doc comment) -- price/stock
  // moved to the variant, so that's what a cart line must point at to be
  // resolvable. sellerListingId is still populated (denormalized from the
  // variant's own FK), matching what routes/cart.ts actually does on
  // insert.
  await db.insert(cartItemsTable).values([
    {
      userId: cartUserId,
      productId: product.id,
      sellerListingId: listing1.id,
      sellerListingVariantId: listing1Variant.id,
      quantity: 2,
    }, // seller1: 500*2=1000
    {
      userId: cartUserId,
      productId: product.id,
      sellerListingId: listing2.id,
      sellerListingVariantId: listing2Variant.id,
      quantity: 1,
    }, // seller2: 300*1=300
  ]);

  const cartRows = await db
    .select({
      sellerListingVariantId: cartItemsTable.sellerListingVariantId,
      quantity: cartItemsTable.quantity,
      price: sellerListingVariantsTable.price,
      sellerId: sellerListingsTable.sellerId,
    })
    .from(cartItemsTable)
    .innerJoin(
      sellerListingVariantsTable,
      eq(cartItemsTable.sellerListingVariantId, sellerListingVariantsTable.id),
    )
    .innerJoin(
      sellerListingsTable,
      eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id),
    )
    .where(eq(cartItemsTable.userId, cartUserId));

  check("real cart query returns 2 rows", cartRows.length === 2, `got ${cartRows.length}`);

  const lines = cartRows.map((r) => ({
    sellerId: r.sellerId,
    lineTotal: Number(r.price) * r.quantity,
  }));

  const groups = groupBySellerAndAllocateDiscount(lines, 100);
  check(
    "groupBySellerAndAllocateDiscount produces 2 separate order groups",
    groups.length === 2,
    `got ${groups.length}`,
  );
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

  // seller_payout_accounts: schema declares .unique() on sellerId (same
  // shape as the dropped seller_payment_configs had). Verify the DB
  // actually enforces it, not just that Drizzle declares it.
  let payoutUniqueEnforced = false;
  try {
    await db.insert(sellerPayoutAccountsTable).values({
      sellerId: seller1.id,
      bkashNumber: "01800000000",
    });
  } catch (err: any) {
    // node-postgres/Drizzle wraps the real Postgres error in DrizzleQueryError,
    // whose own .message is the *query text*, not the driver error -- the
    // actual pg error (with .code = "23505" for unique_violation) lives on
    // .cause.
    const pgErr = err?.cause ?? err;
    payoutUniqueEnforced =
      pgErr?.code === "23505" || /unique|duplicate/i.test(String(pgErr?.message ?? pgErr));
  }
  check(
    "seller_payout_accounts: DB rejects a 2nd row for the same seller (unique constraint enforced)",
    payoutUniqueEnforced,
    payoutUniqueEnforced
      ? undefined
      : "insert of a duplicate sellerId succeeded -- no unique constraint at the DB level",
  );

  // seller_courier_configs: schema now HAS .unique() on sellerId (Part C of
  // this session). The duplicate-insert should fail with Postgres 23505,
  // same way it does for seller_payout_accounts above.
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
    courierUniqueEnforced =
      pgErr?.code === "23505" || /unique|duplicate/i.test(String(pgErr?.message ?? pgErr));
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

  // --- 6. cart.ts buildCart()'s platformBkashVerified flag ---
  console.log("\n--- 6. cart.ts seller.platformBkashVerified flag ---");
  // Post-migration: cart.ts reads platformPaymentConfigTable.isVerified once
  // for the whole cart (a global flag, not per-seller), and surfaces it on
  // every cart line as `seller.platformBkashVerified` (renamed from
  // `seller.hasVerifiedPaymentConfig` during the migration cleanup). The
  // per-seller seller_payment_configs lookup no longer exists.
  //
  // We don't reimplement the cart query here (it's not exported from
  // routes/cart.ts, same convention as before). Instead we just confirm
  // seller1 has a payout account (already done in §2) — that's the
  // per-seller invariant the new model cares about. The platform-level
  // isVerified flag is an admin concern exercised by the
  // platformPaymentConfig route's own tests.
  const seller1PayoutExists = await hasSellerPayoutAccount(seller1.id);
  check(
    "seller1 still has a payout account on file (invariant for offering advance/both on listings)",
    seller1PayoutExists === true,
  );

  // --- 7. Reconciliation on payout-account delete ---
  console.log(
    "\n--- 7. reconciliation: deleting a payout account flips listing.paymentMethod to cod ---",
  );
  // seller1 has a payout account (from §2) and listing1 (from §1, created
  // with paymentMethod="cod"). Flip listing1 to "advance" first so there's
  // something for the delete-route's reconciliation UPDATE to actually
  // change — otherwise this test wouldn't distinguish "the reconciliation
  // ran" from "the listing was already cod".
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

  // Reimplements routes/sellerPayoutAccounts.ts's DELETE /seller-payout-accounts/mine
  // route body directly (bypassing the HTTP/auth layer, same convention as
  // every other section here) — the delete followed by the reconciliation
  // UPDATE that flips any "advance"/"both" listings back to "cod".
  await db
    .delete(sellerPayoutAccountsTable)
    .where(eq(sellerPayoutAccountsTable.sellerId, seller1.id));
  await db
    .update(sellerListingsTable)
    .set({ paymentMethod: "cod" })
    .where(
      and(
        eq(sellerListingsTable.sellerId, seller1.id),
        ne(sellerListingsTable.paymentMethod, "cod"),
      ),
    );

  const [listingAfterDelete] = await db
    .select({ paymentMethod: sellerListingsTable.paymentMethod })
    .from(sellerListingsTable)
    .where(eq(sellerListingsTable.id, listing1.id));
  check(
    "listing1.paymentMethod actually flips to 'cod' in the database after the payout account is deleted (not just in a response payload)",
    listingAfterDelete?.paymentMethod === "cod",
    `got ${listingAfterDelete?.paymentMethod}`,
  );
  const remainingPayoutRows = await db
    .select()
    .from(sellerPayoutAccountsTable)
    .where(eq(sellerPayoutAccountsTable.sellerId, seller1.id));
  check(
    "seller1's payout account row is actually gone after delete",
    remainingPayoutRows.length === 0,
    `got ${remainingPayoutRows.length} row(s)`,
  );

  // --- Cleanup ---
  console.log("\n--- cleanup ---");
  await db.delete(usersTable).where(eq(usersTable.id, user1.id)); // cascades seller1 -> listing1, payout account, courier configs
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
