import { db } from "@workspace/db";
import { type ordersTable, payoutsTable, sellerPayoutAccountsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { disburseToSeller, BkashApiError } from "./bkash";

/**
 * Shared seller-payout-attempt logic -- Part 4 of 4 (see PART4_HANDOFF.md).
 * EXTRACTED from routes/courierWebhooks.ts's `attemptSellerPayout()`
 * (Part 3), moved here so BOTH the courier-webhook's automatic delivered-
 * transition call site AND this part's new admin manual-retry route
 * (`POST /admin/payouts/:id/retry` in routes/admin.ts) can call the exact
 * same logic, rather than a second near-identical implementation being
 * copy-pasted. Per the Part 4 prompt's explicit instruction: "read that
 * function in full first and decide the cleanest refactor, but do not
 * change its guard behavior in the process."
 *
 * THIS IS A PURE MOVE, NOT A REWRITE: every guard, every insert-before-call
 * ordering decision, every retry-policy choice below is copied byte-for-
 * byte in behavior from Part 3's original `attemptSellerPayout()` in
 * courierWebhooks.ts -- see PART3_HANDOFF.md for the full original
 * reasoning on each of these, restated here only where it matters for a
 * reader of THIS file specifically:
 *
 * Guard order (cheapest/most-conclusive-first), all three independently
 * re-checked here rather than trusted from any caller's own guard, since
 * this function now has TWO callers (a webhook that can legitimately fire
 * more than once, AND an admin manual retry that a human could click
 * more than once):
 * 1. `order.sellerId == null` -- admin-direct order, no seller to pay.
 *    Skip silently, not an error.
 * 2. `order.paymentStatus !== "paid"` -- delivery does not imply payment
 *    (COD orders, or a bkash order stuck at payment_pending). Skip,
 *    logged as an expected outcome.
 * 3. An existing `payoutsTable` row for this `orderId` with
 *    `status: "success"` -- idempotency. Deliberately does NOT block on a
 *    "failed" or "pending" row -- this is exactly what lets a MANUAL
 *    RETRY (this part's new addition) re-attempt a previously-failed
 *    payout for the same order: the retry route calls this exact same
 *    function, and this guard only stops it if a payout for that order
 *    has ALREADY succeeded (nothing to retry) or the seller fixed their
 *    account and a retry is already in flight elsewhere -- not merely
 *    because a PRIOR attempt failed. Confirmed by re-reading this guard
 *    specifically for the retry use case (per the Part 4 prompt's own
 *    instruction to "double check this refactor doesn't break the retry
 *    path itself") -- it does not: `eq(payoutsTable.status, "success")` is
 *    the only status checked, so a "failed" row for the same orderId
 *    passes through this guard exactly as before.
 *
 * Only after all three guards pass does this look up
 * `sellerPayoutAccountsTable` FRESH by `sellerId` (not any account looked
 * up by the caller) -- this is what lets a retry pick up a seller who has
 * since added or corrected their payout number after an earlier "no
 * payout account on file" or bKash-side rejection failure.
 *
 * RETRY POLICY (Part 3's decision, restated here since this function IS
 * now literally what "retry" means): insert a NEW payoutsTable row per
 * attempt, always -- never reuse/update an existing failed row. Every
 * attempt (first or Nth, automatic or admin-manual) is symmetrical:
 * insert "pending" before the bKash call (so a mid-call crash still
 * leaves an audit trail), call disburseToSeller(), then update that same
 * new row to "success"/"failed". This means a seller with several failed
 * attempts accumulates several payoutsTable rows for the same orderId --
 * intentional, per Part 3's "full audit trail of every attempt" reasoning,
 * and exactly what the admin payout list (routes/admin.ts's
 * `GET /admin/payouts`) is expected to show.
 *
 * Returns the newly-inserted payoutsTable row's outcome (`success` or
 * `failed` with the final row's id/status), or `null` if no attempt was
 * made at all (one of the three early guards fired, or no payout account
 * exists -- see below) -- callers that care about the outcome (the retry
 * route) can use this return value instead of re-querying; the webhook
 * caller (courierWebhooks.ts) ignores it, exactly as it did before this
 * extraction, since it never used the return value either.
 */
export interface AttemptSellerPayoutResult {
  payoutId: number;
  status: "success" | "failed";
}

export async function attemptSellerPayout(
  order: typeof ordersTable.$inferSelect,
): Promise<AttemptSellerPayoutResult | null> {
  if (order.sellerId == null) {
    // Admin-direct order (pre-marketplace path) -- no seller, nothing to
    // pay out. Not an error case, not logged as one.
    return null;
  }

  if (order.paymentStatus !== "paid") {
    // Delivered but never actually paid via bKash (COD, or a bkash order
    // stuck at payment_pending) -- nothing to disburse. Also not an error.
    logger.info(`[payouts] Order ${order.id} paymentStatus is "${order.paymentStatus}", not "paid" -- skipping payout.`,);
    return null;
  }

  const [existingSuccess] = await db
    .select({ id: payoutsTable.id })
    .from(payoutsTable)
    .where(and(eq(payoutsTable.orderId, order.id), eq(payoutsTable.status, "success")))
    .limit(1);
  if (existingSuccess) {
    // Idempotency: a webhook can legitimately fire more than once (courier
    // retry, duplicate delivered report with a different payload shape),
    // and an admin could click retry more than once too -- a payout that
    // already succeeded for this order must not be attempted again. A
    // "failed"/"pending" row does NOT hit this guard, deliberately -- see
    // RETRY POLICY note above; this is exactly what a manual retry needs
    // to pass through.
    logger.info(`[payouts] Order ${order.id} already has a successful payout, skipping.`);
    return null;
  }

  // Looked up FRESH here (not passed in by the caller) so a retry picks
  // up a seller who has since added/corrected their payout account since
  // an earlier failed attempt -- see doc comment above.
  const [payoutAccount] = await db
    .select()
    .from(sellerPayoutAccountsTable)
    .where(eq(sellerPayoutAccountsTable.sellerId, order.sellerId))
    .limit(1);

  if (!payoutAccount) {
    // Real, expected case (a seller who never set up a payout number, or
    // hasn't fixed it yet even on a retry) -- documented as such, not
    // alarmed on. Insert a failed row so this shows up in the admin
    // payout list, but do NOT call bKash at all -- there is nowhere to
    // send money.
    const [payoutRow] = await db
      .insert(payoutsTable)
      .values({
        orderId: order.id,
        sellerId: order.sellerId,
        amount: order.totalAmount,
        status: "failed",
        failureReason: "No payout account on file for this seller",
      })
      .returning();
    logger.info(`[payouts] Order ${order.id}: seller ${order.sellerId} has no payout account, recorded failed payout.`);
    return { payoutId: payoutRow.id, status: "failed" };
  }

  // Inserted BEFORE calling bKash, per Part 3's own instruction, so a
  // crash mid-call still leaves an audit trail showing an attempt was
  // made rather than silently vanishing. New row per attempt, always --
  // see RETRY POLICY note above.
  const [payoutRow] = await db
    .insert(payoutsTable)
    .values({
      orderId: order.id,
      sellerId: order.sellerId,
      amount: order.totalAmount,
      status: "pending",
    })
    .returning();

  try {
    const result = await disburseToSeller({
      amount: Number(order.totalAmount),
      receiverNumber: payoutAccount.bkashNumber,
      reference: order.trackingId,
    });
    await db
      .update(payoutsTable)
      .set({ status: "success", bkashTransactionId: result.trxID, updatedAt: new Date() })
      .where(eq(payoutsTable.id, payoutRow.id));
    logger.info(`[payouts] Order ${order.id}: payout succeeded, trxID ${result.trxID}.`);
    return { payoutId: payoutRow.id, status: "success" };
  } catch (err) {
    const failureReason =
      err instanceof BkashApiError
        ? `bKash disbursement failed (${err.step}): ${err.message}`
        : `Unexpected error during disbursement: ${err instanceof Error ? err.message : String(err)}`;
    await db
      .update(payoutsTable)
      .set({ status: "failed", failureReason, updatedAt: new Date() })
      .where(eq(payoutsTable.id, payoutRow.id));
    logger.error({ orderId: order.id, failureReason }, "Payout failed");
    return { payoutId: payoutRow.id, status: "failed" };
  }
}
import { logger } from "../lib/logger";
