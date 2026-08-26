import { asyncHandler } from "../lib/errors";
import { Router } from "express";
import { db } from "@workspace/db";
import { sellerPayoutAccountsTable, sellerListingsTable, isValidBdPhone } from "@workspace/db";
import { eq, and, ne } from "drizzle-orm";
import { requireSeller } from "../middlewares/auth";
import { z } from "zod";
import { validateBody } from "../lib/validateRequest";
import { logger } from "../lib/logger";
import type { ApiRequest } from "../types/apiRequest";

// VAL-MIGRATE-1: hand-authored schema (OpenAPI spec doesn't cover this POST body).
// Matches the existing manual checks exactly:
// - bkashNumber: required string (isValidBdPhone format check is a business rule below)
// - accountHolderName: optional string
const CreateSellerPayoutAccountBody = z.object({
  bkashNumber: z.string(),
  accountHolderName: z.string().optional(),
});

/**
 * Seller-only: register/update/remove the plain bKash NUMBER a seller gets
 * paid out to (Part 1 of 4 -- see PART1_HANDOFF.md). Under the post-migration
 * platform-custodial payments model:
 *
 *   - Admin configures ONE bKash merchant account at platform_payment_config
 *     (the platform's own merchant account). Buyers pay the platform directly.
 *   - Each seller registers a plain bKash PERSONAL number here. After
 *     courier-confirmed delivery, the platform disburses the seller's share
 *     to this number via bKash B2C (see lib/payouts.ts:attemptSellerPayout).
 *   - Sellers never touch merchant API credentials. The old
 *     seller_payment_configs table (per-seller merchant App Key/Secret/etc.)
 *     has been dropped.
 *
 * This table has no secret credentials to mask, so unlike the old merchant-
 * credentials route there is no toMasked step; the row is returned as-is.
 *
 * LISTING ELIGIBILITY INVARIANT (industry-standard reconciliation):
 *   A seller may set paymentMethod = "advance" | "both" on a listing ONLY
 *   if they have a payout account on file (see lib/db/src/logic/sellerListings.ts:
 *   hasSellerPayoutAccount, called from routes/sellerListings.ts POST/PUT).
 *   Therefore, when a seller DELETES their payout account here, any of their
 *   listings still claiming "advance" or "both" would be left in an invalid
 *   state — checkout is still money-safe (orders.ts's isPlatformBkashAvailable
 *   gate is independent), but the listing's displayed paymentMethod would be
 *   misleading. This route reconciles by flipping any such listings back to
 *   "cod" in a single UPDATE, mirroring the same reconciliation pattern that
 *   existed under the old model on seller_payment_configs delete/unverify.
 *   See routes/sellerListings.ts's PAYMENT_METHOD_ERROR doc comment for the
 *   full invariant story.
 */

const router = Router();

/**
 * Seller: get their own payout account. Returns 200 with null when no account
 * is registered yet -- this is the normal "not set up yet" state (a new
 * seller hasn't been asked to provide a payout number until they need one),
 * not an error state. Returning 200/null (instead of 404) means React Query
 * treats the response as successful data and caches it normally, instead of
 * refetching on every Clerk token refresh and flooding the Network tab.
 */
router.get(
  "/seller-payout-accounts/mine",
  requireSeller,
  asyncHandler(async (req, res) => {
    const [account] = await db
      .select()
      .from(sellerPayoutAccountsTable)
      .where(eq(sellerPayoutAccountsTable.sellerId, req.dbSeller!.id))
      .limit(1);
    if (!account) {
      res.status(200).json(null);
      return;
    }
    res.json(account);
  }),
);

/**
 * Seller: create or replace their payout account (upsert by sellerId,
 * matching the table's unique(sellerId) constraint). Delete-then-insert,
 * same pattern as sellerCourierConfigs.ts, for consistency.
 */
router.post(
  "/seller-payout-accounts",
  requireSeller,
  validateBody(CreateSellerPayoutAccountBody, "CreateSellerPayoutAccountBody"),
  async (req: ApiRequest<z.infer<typeof CreateSellerPayoutAccountBody>>, res) => {
    try {
      const { bkashNumber, accountHolderName } = req.body;

      // VAL-MIGRATE-1: Zod validates shape (bkashNumber: string, accountHolderName:
      // string | undefined). isValidBdPhone is a business rule (BD phone format
      // check) — kept as a semantic check, same as sellerPayoutAccounts has always done.
      if (!bkashNumber.trim()) {
        res.status(400).json({ error: "bkashNumber is required" });
        return;
      }
      if (!isValidBdPhone(bkashNumber)) {
        res.status(400).json({
          error:
            "bkashNumber doesn't look like a valid Bangladeshi mobile number (e.g. 01712345678)",
        });
        return;
      }

      await db
        .delete(sellerPayoutAccountsTable)
        .where(eq(sellerPayoutAccountsTable.sellerId, req.dbSeller!.id));

      const [account] = await db
        .insert(sellerPayoutAccountsTable)
        .values({
          sellerId: req.dbSeller!.id,
          bkashNumber: bkashNumber.trim(),
          accountHolderName: accountHolderName?.trim() || null,
        })
        .returning();

      res.status(201).json(account);
    } catch (err) {
      logger.error({ err: err }, "Create seller payout account error");
      res.status(500).json({ error: "Failed to save payout account" });
    }
  },
);

/**
 * Seller: delete their payout account. Reconciles this seller's
 * seller_listings: any listing still claiming paymentMethod "advance"/"both"
 * is flipped to "cod", since the payout destination backing that claim is
 * now gone. This is the industry-standard invariant-preservation pattern:
 * a seller cannot offer advance/bKash payment on a listing if the platform
 * has nowhere to disburse their money. Checkout is already money-safe
 * regardless (orders.ts's isPlatformBkashAvailable gate is independent),
 * but the listing's displayed state must stay honest.
 *
 * Same reconciliation shape as the old seller_payment_configs DELETE route,
 * preserved through the migration: a single UPDATE ... WHERE seller_id = ?
 * AND payment_method != 'cod' — no per-row loop, no extra locking beyond
 * what a normal single-statement UPDATE already has.
 */
router.delete(
  "/seller-payout-accounts/mine",
  requireSeller,
  asyncHandler(async (req, res) => {
    const deleted = await db
      .delete(sellerPayoutAccountsTable)
      .where(eq(sellerPayoutAccountsTable.sellerId, req.dbSeller!.id))
      .returning();
    if (deleted.length === 0) {
      res.status(404).json({ error: "No payout account to delete" });
      return;
    }

    // Reconcile: flip any of this seller's listings still claiming "advance" or
    // "both" back to "cod". They can no longer accept advance payments without
    // a payout destination, so leaving the field as-is would be misleading.
    await db
      .update(sellerListingsTable)
      .set({ paymentMethod: "cod" })
      .where(
        and(
          eq(sellerListingsTable.sellerId, req.dbSeller!.id),
          ne(sellerListingsTable.paymentMethod, "cod"),
        ),
      );

    res.json({
      message:
        "Payout account removed. Your advance-payment listings have been switched to COD-only.",
    });
  }),
);

export default router;
