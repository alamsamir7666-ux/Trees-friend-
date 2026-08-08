import { Router } from "express";
import { db } from "@workspace/db";
import { sellerPayoutAccountsTable, isValidBdPhone } from "@workspace/db";
import { eq } from "drizzle-orm";
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
 * paid out to (Part 1 of 4 -- see PART1_HANDOFF.md). Distinct from the old
 * sellerPaymentConfigs.ts (merchant API credentials, still live,
 * untouched) -- this table has no secret credentials to mask, so unlike
 * that route there is no toMasked step; the row is returned as-is.
 *
 * Verified before writing this route: nothing in this codebase's checkout/
 * listing eligibility logic (sellerListings.ts's hasVerifiedPaymentConfig,
 * cart.ts's per-seller verified-config map, orders.ts's payment-method
 * check) reads sellerPayoutAccountsTable at all -- every one of those
 * still reads ONLY sellerPaymentConfigsTable (grepped: zero hits for
 * sellerPayoutAccountsTable outside this file and its schema file at the
 * time of writing). That's correct for this part's scope (checkout logic
 * is explicitly Part 2's job, not this file's) -- but it does mean a
 * seller can fully delete their payout account here with NO reconciling
 * side effect anywhere else in the app yet, unlike sellerPaymentConfigs.ts's
 * DELETE route, which flips the seller's own listings back to "cod" on
 * delete because that table's existence is what checkout eligibility is
 * actually wired to today. There is nothing equivalent to flip here yet
 * because nothing downstream depends on this table's existence yet. Once
 * Part 2/3 wires payout-account existence into any buyer-facing or
 * checkout-facing decision, whoever builds that should re-examine whether
 * this DELETE route then also needs a reconciliation step of its own --
 * flagging this now rather than guessing at Part 2/3's design here.
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
router.get("/seller-payout-accounts/mine", requireSeller, async (req, res) => {
  try {
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
  } catch (err) {
    logger.error({ err: err }, "Get seller payout account error");
    res.status(500).json({ error: "Failed to fetch payout account" });
  }
});

/**
 * Seller: create or replace their payout account (upsert by sellerId,
 * matching the table's unique(sellerId) constraint). Delete-then-insert,
 * same pattern as sellerPaymentConfigs.ts/sellerCourierConfigs.ts, for
 * consistency even though there's no isVerified flag here to reset (this
 * table has none -- a payout number isn't "verified" the way merchant API
 * credentials are, there's no live check being gated).
 */
router.post("/seller-payout-accounts", requireSeller, validateBody(CreateSellerPayoutAccountBody, "CreateSellerPayoutAccountBody"), async (req: ApiRequest<z.infer<typeof CreateSellerPayoutAccountBody>>, res) => {
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
        error: "bkashNumber doesn't look like a valid Bangladeshi mobile number (e.g. 01712345678)",
      });
      return;
    }

    await db.delete(sellerPayoutAccountsTable).where(eq(sellerPayoutAccountsTable.sellerId, req.dbSeller!.id));

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
});

/**
 * Seller: delete their payout account. See this file's top doc comment --
 * deliberately no reconciliation side effect, unlike sellerPaymentConfigs.ts's
 * DELETE, because nothing downstream reads this table's existence yet.
 */
router.delete("/seller-payout-accounts/mine", requireSeller, async (req, res) => {
  try {
    const deleted = await db
      .delete(sellerPayoutAccountsTable)
      .where(eq(sellerPayoutAccountsTable.sellerId, req.dbSeller!.id))
      .returning();
    if (deleted.length === 0) {
      res.status(404).json({ error: "No payout account to delete" });
      return;
    }
    res.json({ message: "Payout account removed." });
  } catch (err) {
    logger.error({ err: err }, "Delete seller payout account error");
    res.status(500).json({ error: "Failed to delete payout account" });
  }
});

export default router;
