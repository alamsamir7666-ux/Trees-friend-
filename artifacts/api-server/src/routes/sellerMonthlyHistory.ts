import { asyncHandler } from "../lib/errors";
import { logger } from "../lib/logger";
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireSeller } from "../middlewares/auth";

/**
 * Seller-scoped monthly revenue/order history.
 *
 * Unlike admin's monthlyRecordsTable (a platform-wide table populated by a
 * once-a-month archive job -- see routes/monthlyRecords.ts), there is no
 * per-seller archive table or job. Adding one would mean a new migration
 * plus a cron/job change purely to back a read-only history view, so this
 * instead computes the same shape (year, month, totalOrders,
 * totalRevenue-of-delivered-orders) live from ordersTable, grouped by
 * calendar month, filtered to this seller's own orders via a parameterized
 * query (sellerId is bound, never string-interpolated). Cheap at
 * seller-scale order volume (matches the no-pagination-needed-at-the-DB-
 * level precedent already set by sellerOrders.ts's simple list query) and
 * always reflects the current state of the seller's orders rather than a
 * monthly snapshot that can drift stale.
 *
 * Response is capped to a bounded window (?months=, default 12, max 60) so
 * a seller with years of order history doesn't get an unbounded response --
 * same spirit as admin.ts's page/limit pagination on /admin/orders, just
 * expressed as a row cap since "month" is already the natural unit here.
 */

const router = Router();

const DEFAULT_MONTHS = 12;
const MAX_MONTHS = 60;

router.get("/seller/monthly-history", requireSeller, asyncHandler(async (req: ApiRequest, res) => {
  const { months: monthsRaw } = req.query as Record<string, string>;
  const monthsParsed = parseInt(monthsRaw ?? String(DEFAULT_MONTHS), 10);
  if (monthsRaw !== undefined && (isNaN(monthsParsed) || monthsParsed <= 0)) {
    res.status(400).json({ error: "months must be a positive integer" });
    return;
  }
  const months = Math.min(MAX_MONTHS, monthsParsed || DEFAULT_MONTHS);

  const sellerId = req.dbSeller!.id;

  const rows = await db.execute(sql`
    SELECT
      EXTRACT(YEAR FROM created_at)::int AS year,
      EXTRACT(MONTH FROM created_at)::int AS month,
      COUNT(*)::int AS total_orders,
      COALESCE(SUM(total_amount) FILTER (WHERE order_status = 'delivered'), 0) AS total_revenue
    FROM orders
    WHERE seller_id = ${sellerId}
    GROUP BY 1, 2
    ORDER BY 1 DESC, 2 DESC
    LIMIT ${months}
  `);

  const records = (rows.rows as any[]).map((r, idx) => ({
    id: idx + 1,
    year: Number(r.year),
    month: Number(r.month),
    totalOrders: Number(r.total_orders),
    totalRevenue: Number(r.total_revenue),
  }));

  res.json({ records, months });
}));
import type { ApiRequest } from "../types/apiRequest";

export default router;
