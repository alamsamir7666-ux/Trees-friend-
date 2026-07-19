import { Router } from "express";
import { db } from "@workspace/db";
import {
  referralsTable,
  couponsTable,
  usersTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import crypto from "crypto";

const router = Router();

function generateReferralCode(userId: string): string {
  return "REF" + crypto.createHash("md5").update(userId).digest("hex").slice(0, 6).toUpperCase();
}

/**
 * Get or create the current user's referral code.
 */
router.get("/referrals/my-code", requireAuth, async (req: any, res) => {
  try {
    const code = generateReferralCode(req.userId);

    // Upsert referral record
    const existing = await db
      .select()
      .from(referralsTable)
      .where(eq(referralsTable.referrerId, req.userId))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(referralsTable).values({
        referrerId: req.userId,
        referralCode: code,
      }).onConflictDoNothing();
    }

    // Count how many successful referrals this user has made
    const allReferrals = await db
      .select()
      .from(referralsTable)
      .where(eq(referralsTable.referrerId, req.userId));

    const used = allReferrals.filter((r) => r.used).length;

    res.json({
      code,
      totalReferrals: allReferrals.filter((r) => r.referredId).length,
      successfulReferrals: used,
      earnedPoints: used * 100, // 100 points per successful referral
      shareUrl: `${process.env.APP_URL ?? "https://treefriend.com"}/?ref=${code}`,
    });
  } catch {
    res.status(500).json({ error: "Failed to get referral code" });
  }
});

/**
 * Apply a referral code when a new user signs up.
 * Called from ProfileSync after first login.
 */
router.post("/referrals/apply", requireAuth, async (req: any, res) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== "string") {
      res.status(400).json({ error: "Referral code is required" });
      return;
    }

    const sanitized = code.toUpperCase().trim();

    // Find referral record
    const [referral] = await db
      .select()
      .from(referralsTable)
      .where(eq(referralsTable.referralCode, sanitized))
      .limit(1);

    if (!referral) {
      res.status(404).json({ error: "Invalid referral code" });
      return;
    }
    if (referral.referrerId === req.userId) {
      res.status(400).json({ error: "You cannot use your own referral code" });
      return;
    }
    if (referral.referredId) {
      res.status(400).json({ error: "This referral code has already been used" });
      return;
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
  } catch {
    res.status(500).json({ error: "Failed to apply referral" });
  }
});

export default router;
