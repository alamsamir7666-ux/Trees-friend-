import { Router } from "express";
import { db } from "@workspace/db";
import { loyaltyPointsTable, loyaltyTransactionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../lib/errors";
import {
  POINTS_PER_100_TAKA,
  TAKA_PER_POINT,
  awardPoints,
  redeemPoints,
} from "../lib/loyalty";
import type { ApiRequest } from "../types/apiRequest";

// Re-export for backward compat — orders.ts imports these from "./loyalty".
// New code should import directly from "../lib/loyalty".
export { POINTS_PER_100_TAKA, TAKA_PER_POINT, awardPoints, redeemPoints };

const router = Router();

router.get(
  "/loyalty/me",
  requireAuth,
  asyncHandler(async (req: ApiRequest, res) => {
    const [balance] = await db
      .select()
      .from(loyaltyPointsTable)
      .where(eq(loyaltyPointsTable.userId, req.userId!))
      .limit(1);

    const transactions = await db
      .select()
      .from(loyaltyTransactionsTable)
      .where(eq(loyaltyTransactionsTable.userId, req.userId!))
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
  }),
);

export default router;
