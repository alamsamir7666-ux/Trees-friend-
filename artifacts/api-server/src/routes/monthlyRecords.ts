import { Router } from "express";
import { db } from "@workspace/db";
import { monthlyRecordsTable, ordersTable } from "@workspace/db";
import { desc, sql, and, eq } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

router.get("/admin/monthly-records", requireAdmin, async (req: any, res) => {
  const records = await db
    .select()
    .from(monthlyRecordsTable)
    .orderBy(desc(monthlyRecordsTable.year), desc(monthlyRecordsTable.month));

  res.json(
    records.map((r) => ({
      id: r.id,
      year: r.year,
      month: r.month,
      totalRevenue: Number(r.totalRevenue),
      totalOrders: r.totalOrders,
      archivedAt: r.archivedAt.toISOString(),
    }))
  );
});

router.post("/admin/monthly-records/archive", requireAdmin, async (req: any, res) => {
  const result = await archiveLastMonth();
  res.json(result);
});

export async function archiveLastMonth(): Promise<{ archived: boolean; message: string }> {
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const year = lastMonth.getFullYear();
  const month = lastMonth.getMonth() + 1; // 1-indexed

  // Check if already archived
  const [existing] = await db
    .select({ id: monthlyRecordsTable.id })
    .from(monthlyRecordsTable)
    .where(and(eq(monthlyRecordsTable.year, year), eq(monthlyRecordsTable.month, month)))
    .limit(1);

  if (existing) {
    return { archived: false, message: `Month ${month}/${year} already archived` };
  }

  const startOfLastMonth = new Date(year, month - 1, 1).toISOString();
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [[{ revenue }], [{ orderCount }]] = await Promise.all([
    db.execute(sql`
      SELECT COALESCE(SUM(total_amount), 0) AS revenue
      FROM orders
      WHERE order_status = 'delivered'
        AND created_at >= ${startOfLastMonth}
        AND created_at < ${startOfThisMonth}
    `).then((r) => [{ revenue: Number((r.rows[0] as any)?.revenue ?? 0) }]),
    db.execute(sql`
      SELECT COUNT(*) AS order_count
      FROM orders
      WHERE created_at >= ${startOfLastMonth}
        AND created_at < ${startOfThisMonth}
    `).then((r) => [{ orderCount: Number((r.rows[0] as any)?.order_count ?? 0) }]),
  ]);

  await db.insert(monthlyRecordsTable).values({
    year,
    month,
    totalRevenue: String(revenue),
    totalOrders: orderCount,
  });

  return { archived: true, message: `Archived ${month}/${year}: ৳${revenue} revenue, ${orderCount} orders` };
}

export default router;
