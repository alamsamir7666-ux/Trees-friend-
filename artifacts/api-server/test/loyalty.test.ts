/**
 * Concurrency test for redeemPoints.
 *
 * Tests that two concurrent redeemPoints calls against a user with exactly
 * enough points for ONE redemption result in exactly ONE success and ONE
 * failure — never both succeeding (double-spend) and never both failing
 * (false rejection of a valid redemption).
 *
 * This test requires a real Postgres database (DATABASE_URL must be set).
 * The guarded UPDATE (`WHERE points >= N`) is safe under Postgres's
 * row-level locking regardless of whether the test can force the exact
 * interleaving — if two concurrent UPDATEs both evaluate `points >= N`,
 * Postgres serializes them via the row lock, so the second UPDATE sees
 * the already-decremented balance and its WHERE clause fails.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { usersTable, loyaltyPointsTable, loyaltyTransactionsTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";
import { redeemPoints } from "../src/lib/loyalty";
import { cleanupAll, markerId, seedUser } from "./testDb";

const TEST_CLERK_ID_SUFFIX = "loyalty-concurrency-test";

async function seedLoyaltyPoints(userId: string, points: number) {
  await db.insert(loyaltyPointsTable).values({ userId, points });
}

async function getLoyaltyPoints(userId: string): Promise<number | null> {
  const [row] = await db
    .select({ points: loyaltyPointsTable.points })
    .from(loyaltyPointsTable)
    .where(eq(loyaltyPointsTable.userId, userId))
    .limit(1);
  return row?.points ?? null;
}

async function cleanupLoyalty() {
  const clerkId = markerId(TEST_CLERK_ID_SUFFIX);
  await db.delete(loyaltyTransactionsTable).where(eq(loyaltyTransactionsTable.userId, clerkId));
  await db.delete(loyaltyPointsTable).where(eq(loyaltyPointsTable.userId, clerkId));
}

describe("redeemPoints concurrency", () => {
  let user: { id: number; clerkId: string };

  beforeAll(async () => {
    await cleanupAll();
    user = await seedUser({
      clerkIdSuffix: TEST_CLERK_ID_SUFFIX,
      email: "loyalty-concurrency-test@test.com",
    });
  });

  afterAll(async () => {
    await cleanupLoyalty();
    await cleanupAll();
  });

  it("exactly one of two concurrent redeemPoints(100) calls succeeds when balance is 100", async () => {
    // Seed exactly 100 points
    await cleanupLoyalty();
    await seedLoyaltyPoints(user.clerkId, 100);

    // Verify seed
    const before = await getLoyaltyPoints(user.clerkId);
    expect(before).toBe(100);

    // Fire two concurrent redemptions of 100 points each
    const results = await Promise.allSettled([
      redeemPoints(user.clerkId, 100, 99991),
      redeemPoints(user.clerkId, 100, 99992),
    ]);

    // Exactly one must succeed, one must fail
    const fulfilled = results.filter(r => r.status === "fulfilled");
    const rejected = results.filter(r => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // The rejected one must say "Insufficient points"
    if (rejected[0].status === "rejected") {
      expect(rejected[0].reason.message).toBe("Insufficient points");
    }

    // Final balance must be exactly 0 — never negative
    const after = await getLoyaltyPoints(user.clerkId);
    expect(after).toBe(0);
    expect(after!).not.toBeLessThan(0);
  });

  it("redeemPoints throws when user has no loyalty_points row", async () => {
    await cleanupLoyalty();
    // No seed — user has no row

    await expect(redeemPoints(user.clerkId, 50, 99993)).rejects.toThrow("Insufficient points");

    // Balance should still be null (no row created)
    const after = await getLoyaltyPoints(user.clerkId);
    expect(after).toBeNull();
  });

  it("redeemPoints throws when balance is insufficient", async () => {
    await cleanupLoyalty();
    await seedLoyaltyPoints(user.clerkId, 50);

    await expect(redeemPoints(user.clerkId, 100, 99994)).rejects.toThrow("Insufficient points");

    // Balance must be unchanged (50, not -50)
    const after = await getLoyaltyPoints(user.clerkId);
    expect(after).toBe(50);
  });

  it("redeemPoints succeeds when balance is exactly enough", async () => {
    await cleanupLoyalty();
    await seedLoyaltyPoints(user.clerkId, 100);

    await redeemPoints(user.clerkId, 100, 99995);

    const after = await getLoyaltyPoints(user.clerkId);
    expect(after).toBe(0);
  });

  it("redeemPoints decrements correctly for partial redemption", async () => {
    await cleanupLoyalty();
    await seedLoyaltyPoints(user.clerkId, 250);

    await redeemPoints(user.clerkId, 75, 99996);

    const after = await getLoyaltyPoints(user.clerkId);
    expect(after).toBe(175);
  });
});
