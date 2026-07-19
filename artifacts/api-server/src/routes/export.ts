import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable, usersTable, newsletterTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

function escapeCsv(val: unknown): string {
  const str = val == null ? "" : String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsvRow(fields: unknown[]): string {
  return fields.map(escapeCsv).join(",");
}

router.get("/admin/export/orders", requireAdmin, async (_req, res) => {
  try {
    const orders = await db
      .select({
        id: ordersTable.id,
        trackingId: ordersTable.trackingId,
        userEmail: usersTable.email,
        userName: usersTable.firstName,
        totalAmount: ordersTable.totalAmount,
        paymentMethod: ordersTable.paymentMethod,
        paymentStatus: ordersTable.paymentStatus,
        orderStatus: ordersTable.orderStatus,
        couponCode: ordersTable.couponCode,
        discountAmount: ordersTable.discountAmount,
        shippingAddress: ordersTable.shippingAddress,
        createdAt: ordersTable.createdAt,
      })
      .from(ordersTable)
      .leftJoin(usersTable, eq(ordersTable.userId, usersTable.clerkId))
      .orderBy(desc(ordersTable.createdAt));

    const headers = [
      "Order ID","Tracking ID","Customer Email","Customer Name",
      "Total (BDT)","Payment Method","Payment Status","Order Status",
      "Coupon Code","Discount (BDT)","Shipping City","Shipping District","Created At",
    ];

    const rows = orders.map((o) => {
      const addr = o.shippingAddress as any;
      return buildCsvRow([
        o.id, o.trackingId, o.userEmail, o.userName,
        o.totalAmount, o.paymentMethod, o.paymentStatus, o.orderStatus,
        o.couponCode ?? "", o.discountAmount,
        addr?.city ?? "", addr?.district ?? "",
        new Date(o.createdAt).toISOString(),
      ]);
    });

    const csv = [headers.join(","), ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="orders_${new Date().toISOString().split("T")[0]}.csv"`,
    );
    res.send(csv);
  } catch {
    res.status(500).json({ error: "Failed to export orders" });
  }
});

router.get("/admin/export/newsletter", requireAdmin, async (_req, res) => {
  try {
    const subscribers = await db
      .select()
      .from(newsletterTable)
      .where(eq(newsletterTable.isActive, true))
      .orderBy(newsletterTable.createdAt);

    const headers = ["Email", "Subscribed At"];
    const rows = subscribers.map((s) =>
      buildCsvRow([s.email, s.createdAt.toISOString()]),
    );
    const csv = [headers.join(","), ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="newsletter_${new Date().toISOString().split("T")[0]}.csv"`,
    );
    res.send(csv);
  } catch {
    res.status(500).json({ error: "Failed to export subscribers" });
  }
});

export default router;
