import { Router } from "express";
import { db } from "@workspace/db";
import { loyaltyPointsTable, loyaltyTransactionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();

export const POINTS_PER_100_TAKA = 1;   // Earn 1 point per ৳100 spent
export const TAKA_PER_POINT = 1;         // 1 point = ৳1 discount

export async function awardPoints(userId: string, orderId: number, orderTotal: number) {
  const points = Math.floor(orderTotal / 100) * POINTS_PER_100_TAKA;
  if (points <= 0) return;
  try {
    const [existing] = await db
      .select()
      .from(loyaltyPointsTable)
      .where(eq(loyaltyPointsTable.userId, userId))
      .limit(1);

    if (existing) {
      await db
        .update(loyaltyPointsTable)
        .set({ points: existing.points + points, updatedAt: new Date() })
        .where(eq(loyaltyPointsTable.userId, userId));
    } else {
      await db.insert(loyaltyPointsTable).values({ userId, points });
    }

    await db.insert(loyaltyTransactionsTable).values({
      userId,
      points,
      reason: `order_#${orderId}`,
      orderId,
    });
  } catch (err) {
    console.error("[loyalty] awardPoints failed:", err);
  }
}

export async function redeemPoints(userId: string, pointsToRedeem: number, orderId: number) {
  const [existing] = await db
    .select()
    .from(loyaltyPointsTable)
    .where(eq(loyaltyPointsTable.userId, userId))
    .limit(1);

  if (!existing || existing.points < pointsToRedeem) {
    throw new Error("Insufficient points");
  }

  await db
    .update(loyaltyPointsTable)
    .set({ points: existing.points - pointsToRedeem, updatedAt: new Date() })
    .where(eq(loyaltyPointsTable.userId, userId));

  await db.insert(loyaltyTransactionsTable).values({
    userId,
    points: -pointsToRedeem,
    reason: `redeemed_order_#${orderId}`,
    orderId,
  });
}

router.get("/loyalty/me", requireAuth, async (req: any, res) => {
  try {
    const [balance] = await db
      .select()
      .from(loyaltyPointsTable)
      .where(eq(loyaltyPointsTable.userId, req.userId))
      .limit(1);

    const transactions = await db
      .select()
      .from(loyaltyTransactionsTable)
      .where(eq(loyaltyTransactionsTable.userId, req.userId))
      .orderBy(desc(loyaltyTransactionsTable.createdAt))
      .limit(20);

    res.json({
      points: balance?.points ?? 0,
      takaValue: (balance?.points ?? 0) * TAKA_PER_POINT,
      transactions: transactions.map((t) => ({
        id: t.id,
        points: t.points,
        reason: t.reason,
        orderId: t.orderId,
        createdAt: t.createdAt.toISOString(),
      })),
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch loyalty points" });
  }
});

export default router;
