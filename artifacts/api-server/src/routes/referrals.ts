import { Router } from "express";
import type { z } from "zod";
import { db } from "@workspace/db";
import {
  referralsTable,
  couponsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { validateBody } from "../lib/validateRequest";
import { asyncHandler, HttpError } from "../lib/errors";
import { RedeemReferralBody } from "../lib/schemas";
import crypto from "crypto";
import type { ApiRequest } from "../types/apiRequest";

const router = Router();

function generateReferralCode(userId: string): string {
  return "REF" + crypto.createHash("md5").update(userId).digest("hex").slice(0, 6).toUpperCase();
}

/**
 * Get or create the current user's referral code.
 */
router.get(
  "/referrals/my-code",
  requireAuth,
  asyncHandler(async (req: ApiRequest, res) => {
    const code = generateReferralCode(req.userId!);

    // Upsert referral record
    const existing = await db
      .select()
      .from(referralsTable)
      .where(eq(referralsTable.referrerId, req.userId!))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(referralsTable).values({
        referrerId: req.userId!,
        referralCode: code,
      }).onConflictDoNothing();
    }

    // Count how many successful referrals this user has made
    const allReferrals = await db
      .select()
      .from(referralsTable)
      .where(eq(referralsTable.referrerId, req.userId!));

    const used = allReferrals.filter((r) => r.used).length;

    res.json({
      code,
      totalReferrals: allReferrals.filter((r) => r.referredId).length,
      successfulReferrals: used,
      earnedPoints: used * 100, // 100 points per successful referral
      shareUrl: `${process.env.APP_URL ?? "https://treefriend.com"}/?ref=${code}`,
    });
  }),
);

/**
 * Apply a referral code when a new user signs up.
 * Called from ProfileSync after first login.
 */
router.post(
  "/referrals/apply",
  requireAuth,
  validateBody(RedeemReferralBody, "RedeemReferralBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof RedeemReferralBody>>, res) => {
    const { code } = req.body;
    const sanitized = code.toUpperCase().trim();

    // Find referral record
    const [referral] = await db
      .select()
      .from(referralsTable)
      .where(eq(referralsTable.referralCode, sanitized))
      .limit(1);

    if (!referral) throw new HttpError(404, "Invalid referral code");
    if (referral.referrerId === req.userId) {
      throw new HttpError(400, "You cannot use your own referral code");
    }
    if (referral.referredId) {
      throw new HttpError(400, "This referral code has already been used");
    }

    // Generate a one-time coupon for the new user
    const couponCode = "WELCOME" + crypto.randomBytes(3).toString("hex").toUpperCase();
    await db.insert(couponsTable).values({
      code: couponCode,
      discountType: "fixed",
      discountValue: "100",
      isActive: true,
    });

    // Mark referral as used
    await db
      .update(referralsTable)
      .set({ referredId: req.userId, used: true, usedAt: new Date() })
      .where(eq(referralsTable.referralCode, sanitized));

    res.json({
      success: true,
      couponCode,
      message: "Referral applied! You get ৳100 off your first order.",
    });
  }),
);

export default router;
