/**
 * Loyalty points business logic.
 *
 * EXTRACTED from routes/loyalty.ts so that:
 *  • The logic is reusable from non-HTTP contexts (cron jobs, CLI scripts,
 *    webhooks) without importing Express.
 *  • The logic is unit-testable in isolation.
 *  • The race condition in the previous `awardPoints` implementation is fixed
 *    (see below).
 *
 * ─── Concurrency safety ──────────────────────────────────────────────────────
 *
 * awardPoints: uses Postgres's atomic `UPDATE ... SET points = points + N`
 * (the `+ N` is evaluated server-side, not client-side), wrapped in a
 * transaction that also inserts the audit row. If the user doesn't have a
 * `loyalty_points` row yet, we INSERT it (with the points already applied)
 * inside the same transaction. This is safe under concurrency — concurrent
 * calls each atomically add their delta; no delta is lost.
 *
 * redeemPoints: uses a single guarded UPDATE with `WHERE points >= N`:
 *
 *   UPDATE loyalty_points
 *   SET points = points - $1, updated_at = now()
 *   WHERE user_id = $2 AND points >= $1
 *   RETURNING id, points
 *
 * If this returns zero rows, either the user has no loyalty_points row OR
 * their balance is insufficient — in both cases we throw "Insufficient
 * points" WITHOUT having decremented anything. The `WHERE points >= N`
 * guard is enforced by Postgres's row-level locking: the UPDATE acquires
 * an exclusive lock on the row, evaluates the WHERE clause, and only
 * applies the SET if the condition holds. Two concurrent calls cannot
 * both succeed if the combined decrement would go negative — the second
 * call sees the already-decremented balance and its `points >= N` check
 * fails.
 *
 * ─── Correction notice ───────────────────────────────────────────────────────
 *
 * A prior version of this file's doc comments claimed redeemPoints used a
 * `WHERE points >= N` guard. That claim was false — the guard did not
 * exist in the code. The prior code did an unconditional decrement, then
 * checked the result, then issued a compensating "add back" UPDATE if the
 * balance went negative. That two-step approach was NOT safe under
 * concurrency (the compensating write could race with a third operation).
 * This file now implements the guarded UPDATE that the prior doc comments
 * incorrectly described.
 */

import { logger } from "./logger";
import { db } from "@workspace/db";
import { loyaltyPointsTable, loyaltyTransactionsTable } from "@workspace/db";
import { eq, sql, and, gte } from "drizzle-orm";

export const POINTS_PER_100_TAKA = 1;   // Earn 1 point per ৳100 spent
export const TAKA_PER_POINT = 1;         // 1 point = ৳1 discount

/**
 * Award loyalty points to a user for an order. Idempotent in the sense that
 * the same (userId, orderId) pair will create multiple transactions — the
 * caller is responsible for not calling this twice for the same order. The
 * `loyalty_transactions.orderId` column has no unique constraint (a single
 * order could legitimately earn points in multiple installments — e.g. partial
 * refunds + re-awards), so the DB doesn't enforce idempotency here.
 *
 * Never throws — failures are logged and swallowed so a loyalty-points bug
 * can never break the order checkout flow that calls this.
 */
export async function awardPoints(userId: string, orderId: number, orderTotal: number): Promise<void> {
  const points = Math.floor(orderTotal / 100) * POINTS_PER_100_TAKA;
  if (points <= 0) return;

  try {
    await db.transaction(async (tx) => {
      // Try to atomically increment the existing row.
      const updated = await tx
        .update(loyaltyPointsTable)
        .set({ points: sql`${loyaltyPointsTable.points} + ${points}`, updatedAt: new Date() })
        .where(eq(loyaltyPointsTable.userId, userId))
        .returning({ id: loyaltyPointsTable.id });

      // If no row was updated, the user doesn't have a loyalty_points row yet —
      // INSERT one with the points already applied.
      if (updated.length === 0) {
        await tx.insert(loyaltyPointsTable).values({ userId, points });
      }

      // Always insert the audit row.
      await tx.insert(loyaltyTransactionsTable).values({
        userId,
        points,
        reason: `order_#${orderId}`,
        orderId,
      });
    });
  } catch (err) {
    // Never throw — loyalty points must not break checkout.
    logger.error({ err, userId, orderId, points }, "[loyalty] awardPoints failed");
  }
}

/**
 * Redeem loyalty points for an order discount. Throws "Insufficient points"
 * if the user has no loyalty_points row OR their balance is less than
 * `pointsToRedeem`.
 *
 * Uses a single guarded UPDATE:
 *
 *   UPDATE loyalty_points
 *   SET points = points - N, updated_at = now()
 *   WHERE user_id = ? AND points >= N
 *   RETURNING id, points
 *
 * If zero rows are returned, the user either has no row or insufficient
 * balance — in both cases nothing was decremented and we throw. This is
 * safe under concurrency: Postgres's row-level locking ensures the WHERE
 * clause is evaluated atomically with the SET, so two concurrent calls
 * cannot both succeed if the combined decrement would go negative.
 */
export async function redeemPoints(userId: string, pointsToRedeem: number, orderId: number): Promise<void> {
  // Guarded UPDATE: the WHERE clause includes `points >= pointsToRedeem`,
  // so the decrement only happens if the user has enough points. If zero
  // rows are returned, either the user has no loyalty_points row or their
  // balance is insufficient — in both cases, nothing was decremented.
  const result = await db
    .update(loyaltyPointsTable)
    .set({ points: sql`${loyaltyPointsTable.points} - ${pointsToRedeem}`, updatedAt: new Date() })
    .where(
      and(
        eq(loyaltyPointsTable.userId, userId),
        gte(loyaltyPointsTable.points, pointsToRedeem),
      ),
    )
    .returning({ id: loyaltyPointsTable.id, points: loyaltyPointsTable.points });

  if (result.length === 0) {
    // No row matched — either user doesn't exist or points < pointsToRedeem.
    // Nothing was decremented; no compensating write needed.
    throw new Error("Insufficient points");
  }

  // Success — the guarded UPDATE already decremented atomically. Insert
  // the audit row.
  await db.insert(loyaltyTransactionsTable).values({
    userId,
    points: -pointsToRedeem,
    reason: `redeemed_order_#${orderId}`,
    orderId,
  });
}
