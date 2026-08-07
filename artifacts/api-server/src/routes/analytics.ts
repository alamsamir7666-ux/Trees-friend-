import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable, productsTable, reviewsTable, usersTable } from "@workspace/db";
import { desc, sql, eq } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

router.get("/admin/analytics/products", requireAdmin, async (_req, res) => {
  try {
    // Top products by revenue
    const topByRevenue = await db.execute(sql`
      SELECT
        p.id, p.name, p.category, p.images,
        COALESCE(SUM((item->>'quantity')::int * (item->>'price')::numeric), 0) AS revenue,
        COALESCE(SUM((item->>'quantity')::int), 0) AS units_sold,
        COUNT(DISTINCT o.id) AS order_count
      FROM products p
      LEFT JOIN orders o ON o.order_status NOT IN ('cancelled')
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(o.items) AS item
          WHERE (item->>'productId')::int = p.id
        )
      LEFT JOIN LATERAL (
        SELECT item FROM jsonb_array_elements(o.items) AS item
        WHERE (item->>'productId')::int = p.id
      ) AS items_lateral ON true
      GROUP BY p.id, p.name, p.category, p.images
      ORDER BY revenue DESC
      LIMIT 20
    `);

    // Products with most reviews
    const topByReviews = await db
      .select({
        id: productsTable.id,
        name: productsTable.name,
        avgRating: sql<string>`ROUND(AVG(${reviewsTable.rating}), 1)`,
        reviewCount: sql<string>`COUNT(${reviewsTable.id})`,
      })
      .from(productsTable)
      .leftJoin(reviewsTable, eq(reviewsTable.productId, productsTable.id))
      .groupBy(productsTable.id, productsTable.name)
      .orderBy(desc(sql`COUNT(${reviewsTable.id})`))
      .limit(10);

    // Customer segments
    const segments = await db.execute(sql`
      SELECT
        CASE
          WHEN order_count >= 5 THEN 'VIP'
          WHEN order_count >= 2 THEN 'Returning'
          ELSE 'New'
        END AS segment,
        COUNT(*) AS customer_count,
        AVG(total_spent) AS avg_spent
      FROM (
        SELECT user_id, COUNT(*) AS order_count, SUM(total_amount) AS total_spent
        FROM orders
        WHERE order_status NOT IN ('cancelled')
        GROUP BY user_id
      ) AS user_stats
      GROUP BY segment
    `);

    // Revenue by month (last 12 months)
    const monthlyRevenue = await db.execute(sql`
      SELECT
        TO_CHAR(created_at, 'YYYY-MM') AS month,
        SUM(total_amount) AS revenue,
        COUNT(*) AS orders,
        COUNT(DISTINCT user_id) AS unique_customers
      FROM orders
      WHERE order_status NOT IN ('cancelled')
        AND created_at >= NOW() - INTERVAL '12 months'
      GROUP BY TO_CHAR(created_at, 'YYYY-MM')
      ORDER BY month ASC
    `);

    res.json({
      topProductsByRevenue: (topByRevenue.rows as any[]).map((r) => ({
        id: r.id, name: r.name, category: r.category,
        image: (r.images as string[])?.[0] ?? null,
        revenue: Number(r.revenue), unitsSold: Number(r.units_sold),
        orderCount: Number(r.order_count),
      })),
      topProductsByReviews: topByReviews.map((r) => ({
        id: r.id, name: r.name,
        avgRating: Number(r.avgRating), reviewCount: Number(r.reviewCount),
      })),
      customerSegments: (segments.rows as any[]).map((r) => ({
        segment: r.segment, count: Number(r.customer_count),
        avgSpent: Math.round(Number(r.avg_spent)),
      })),
      monthlyRevenue: (monthlyRevenue.rows as any[]).map((r) => ({
        month: r.month, revenue: Number(r.revenue),
        orders: Number(r.orders), uniqueCustomers: Number(r.unique_customers),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

export default router;
