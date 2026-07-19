import { Router } from "express";
import { db } from "@workspace/db";
import { sellersTable, sellerListingsTable, sellerSubscriptionsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import { logAudit } from "../lib/audit";

const router = Router();

const SUBSCRIPTION_FEE = "500";
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Admin: list sellers by subscription state, for the seller-subscriptions
 * admin tab (mirrors the shape of other admin.ts list endpoints). Filter is
 * optional; defaults to "trial" + "active" (i.e. anyone with a live or
 * upcoming deadline) since "expired" sellers are the ones admin most needs
 * to see and action.
 */
router.get("/admin/seller-subscriptions", requireAdmin, async (req, res) => {
  try {
    const { status } = req.query as { status?: string };
    const validStatuses = ["trial", "active", "expired"];

    const sellers = await db
      .select()
      .from(sellersTable)
      .where(
        status && validStatuses.includes(status)
          ? eq(sellersTable.subscriptionStatus, status)
          : undefined,
      )
      .orderBy(desc(sellersTable.updatedAt));

    res.json(
      sellers.map((s) => ({
        id: s.id,
        businessName: s.businessName,
        contactEmail: s.contactEmail,
        contactPhone: s.contactPhone,
        status: s.status,
        subscriptionStatus: s.subscriptionStatus,
        trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
        subscriptionExpiresAt: s.subscriptionExpiresAt?.toISOString() ?? null,
        reminderSentAt: s.reminderSentAt?.toISOString() ?? null,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch seller subscriptions" });
  }
});

/**
 * Admin: confirm a seller's 500 taka/year payment was received (outside
 * the system — bKash to the admin's own account, cash, etc.) and:
 *  1. Records/updates a seller_subscriptions row for `year` as "paid".
 *  2. Flips sellers.subscriptionStatus to "active", extends
 *     subscriptionExpiresAt one year from today, clears reminderSentAt so
 *     the new cycle gets its own reminder.
 *  3. Restores any listings this seller had hidden by the subscription-
 *     expiry job specifically (hiddenReason = "subscription_expired") --
 *     does NOT touch listings the seller hid themselves (hiddenReason
 *     null) or via vacation mode.
 *  4. Writes an audit log entry: which admin, when, and the free-text
 *     `note` the admin provides as evidence (e.g. a bKash transaction ID),
 *     so "why is this seller live" is answerable later.
 *
 * This is a manual confirmation, not automated payment verification --
 * matches the plan's actual money flow (seller pays admin outside the
 * system; admin confirms it here).
 */
router.post("/admin/seller-subscriptions/:sellerId/mark-paid", requireAdmin, async (req: any, res) => {
  try {
    const sellerId = parseInt(req.params.sellerId);
    if (isNaN(sellerId) || sellerId <= 0) {
      res.status(400).json({ error: "Invalid seller id" });
      return;
    }

    const { year, note } = req.body as { year?: number; note?: string };
    const targetYear = year ?? new Date().getFullYear();

    const [seller] = await db.select().from(sellersTable).where(eq(sellersTable.id, sellerId)).limit(1);
    if (!seller) {
      res.status(404).json({ error: "Seller not found" });
      return;
    }

    const before = {
      subscriptionStatus: seller.subscriptionStatus,
      subscriptionExpiresAt: seller.subscriptionExpiresAt,
    };

    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + YEAR_MS);

    // Upsert the seller_subscriptions row for this year.
    const [existingSub] = await db
      .select()
      .from(sellerSubscriptionsTable)
      .where(and(eq(sellerSubscriptionsTable.sellerId, sellerId), eq(sellerSubscriptionsTable.year, targetYear)))
      .limit(1);

    if (existingSub) {
      await db
        .update(sellerSubscriptionsTable)
        .set({ status: "paid", paidAt: now, amount: SUBSCRIPTION_FEE })
        .where(eq(sellerSubscriptionsTable.id, existingSub.id));
    } else {
      await db.insert(sellerSubscriptionsTable).values({
        sellerId,
        year: targetYear,
        amount: SUBSCRIPTION_FEE,
        status: "paid",
        paidAt: now,
      });
    }

    await db
      .update(sellersTable)
      .set({
        subscriptionStatus: "active",
        subscriptionExpiresAt: newExpiresAt,
        reminderSentAt: null,
        updatedAt: now,
      })
      .where(eq(sellersTable.id, sellerId));

    // Restore only listings THIS system hid for expiry, not ones the
    // seller hid themselves or via vacation mode.
    const restored = await db
      .update(sellerListingsTable)
      .set({ visibility: "public", hiddenReason: null, updatedAt: now })
      .where(
        and(
          eq(sellerListingsTable.sellerId, sellerId),
          eq(sellerListingsTable.visibility, "hidden"),
          eq(sellerListingsTable.hiddenReason, "subscription_expired"),
        ),
      )
      .returning({ id: sellerListingsTable.id });

    await logAudit({
      adminId: req.userId,
      adminEmail: req.dbUser?.email,
      action: "seller_subscription.marked_paid",
      targetType: "seller",
      targetId: String(sellerId),
      before,
      after: {
        subscriptionStatus: "active",
        subscriptionExpiresAt: newExpiresAt,
        year: targetYear,
        amount: SUBSCRIPTION_FEE,
        note: note ?? null,
        listingsRestored: restored.length,
      },
    });

    res.json({
      ok: true,
      subscriptionStatus: "active",
      subscriptionExpiresAt: newExpiresAt.toISOString(),
      listingsRestored: restored.length,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to mark subscription as paid" });
  }
});

export default router;
