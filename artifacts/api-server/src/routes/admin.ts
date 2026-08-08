import { Router } from "express";
import { db } from "@workspace/db";
import {
  ordersTable,
  usersTable,
  productsTable,
  preOrdersTable,
  sellersTable,
  sellerListingsTable,
  sellerListingVariantsTable,
  payoutsTable,
} from "@workspace/db";
import { eq, desc, sql, and, lt, or, not, inArray } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import { sendOrderStatusUpdate } from "../lib/email";
import { logAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { attemptSellerPayout } from "../lib/payouts";
import type { ApiRequest } from "../types/apiRequest";
import { z } from "zod";
import {
  UpdateOrderStatusBody,
  UpdateOrderStatusParams,
  UpdateOrderPaymentBody,
  UpdateOrderPaymentParams,
  ToggleUserBlockBody,
  ToggleUserBlockParams,
} from "@workspace/api-zod";
import { validateBody, validateParams } from "../lib/validateRequest";

// VAL-MIGRATE-3: hand-authored schema for PATCH /admin/payouts/:id/note
// (OpenAPI spec doesn't cover this route). Matches the existing manual checks:
// - adminNote: optional string | null
// - clawbackNotedAmount: optional number | string | null (number validation
//   is a business rule kept in the handler — Zod validates the union shape)
const UpdatePayoutNoteBody = z.object({
  adminNote: z.string().nullish(),
  clawbackNotedAmount: z.union([z.number(), z.string()]).nullish(),
});
const UpdatePayoutNoteParams = z.object({
  id: z.coerce.number(),
});

const router = Router();

// "pending" | "success" | "failed" today -- see payoutsTable's own schema
// doc comment (lib/db/src/schema/payouts.ts) for why this is left as a
// plain text column with room to extend, same reasoning as
// VALID_ORDER_STATUSES/VALID_PAYMENT_STATUSES below.
const VALID_PAYOUT_STATUSES = ["pending", "success", "failed"];

function formatOrder(o: typeof ordersTable.$inferSelect) {
  return {
    id: o.id,
    trackingId: o.trackingId,
    userId: o.userId,
    sellerId: o.sellerId,
    items: o.items as any[],
    totalAmount: Number(o.totalAmount),
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    orderStatus: o.orderStatus,
    transactionId: o.transactionId,
    shippingAddress: o.shippingAddress as any,
    couponCode: o.couponCode,
    discountAmount: Number(o.discountAmount),
    cancellationReason: o.cancellationReason ?? null,
    giftWrap: o.giftWrap ?? "false",
    giftMessage: o.giftMessage ?? null,
    senderNumber: o.senderNumber ?? null,
    paidAt: o.paidAt ? o.paidAt.toISOString() : null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

// Extends formatOrder's output with the user (customer) fields and the
// seller fields. Both joins are LEFT -- `userId` may not match a row in
// `usersTable` if the user record was deleted, and `sellerId` is NULL
// for any legacy admin-direct order created before the Phase 2
// marketplace migration. The frontend must handle null seller fields
// (e.g. show "Unknown seller" for a legacy row).
type OrderWithUser = typeof ordersTable.$inferSelect & {
  userEmail: string | null;
  userFirstName: string | null;
  userLastName: string | null;
  userPhone: string | null;
  sellerBusinessName: string | null;
  sellerOwnerName: string | null;
  sellerContactEmail: string | null;
  sellerContactPhone: string | null;
  sellerStatus: string | null;
  sellerLogoUrl: string | null;
};

function formatOrderWithUser(o: OrderWithUser) {
  return {
    ...formatOrder(o),
    userEmail: o.userEmail ?? null,
    userName:
      [o.userFirstName, o.userLastName].filter(Boolean).join(" ") || null,
    userPhone: o.userPhone ?? null,
    sellerBusinessName: o.sellerBusinessName ?? null,
    sellerOwnerName: o.sellerOwnerName ?? null,
    sellerContactEmail: o.sellerContactEmail ?? null,
    sellerContactPhone: o.sellerContactPhone ?? null,
    sellerStatus: o.sellerStatus ?? null,
    sellerLogoUrl: o.sellerLogoUrl ?? null,
  };
}

const VALID_ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
];
const VALID_PAYMENT_STATUSES = [
  "pending",
  "pending_verification",
  // Part 2 of 4 (bKash Tokenized Checkout, see PART2_HANDOFF.md): new
  // value, distinct from "pending_verification" -- an order created for a
  // "bkash" checkout whose real bKash Create Payment/Execute Payment cycle
  // hasn't completed yet. Only routes/orders.ts (on insert) and
  // routes/bkashPayment.ts (on a bKash-side cancel/failure, to allow
  // retry) ever set this value; only routes/bkashPayment.ts's callback
  // ever moves an order OUT of it (to "paid").
  "payment_pending",
  "paid",
  "failed",
  "refunded",
];

router.get("/admin/dashboard", requireAdmin, async (_req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      [{ totalOrders }],
      [{ totalUsers }],
      [{ totalSales }],
      [{ pendingOrders }],
    ] = await Promise.all([
      db
        .select({ totalOrders: sql<string>`COUNT(*)` })
        .from(ordersTable)
        .where(sql`created_at >= ${startOfMonth.toISOString()}`),
      db.select({ totalUsers: sql<string>`COUNT(*)` }).from(usersTable),
      db
        .select({
          totalSales: sql<string>`COALESCE(SUM(total_amount), 0)`,
        })
        .from(ordersTable)
        .where(
          sql`order_status = \'delivered\' AND created_at >= ${startOfMonth.toISOString()}`,
        ),
      db
        .select({ pendingOrders: sql<string>`COUNT(*)` })
        .from(ordersTable)
        .where(eq(ordersTable.orderStatus, "pending")),
    ]);

    const recentOrders = await db
      .select()
      .from(ordersTable)
      .orderBy(desc(ordersTable.createdAt))
      .limit(5);

    const monthlySalesRaw = await db.execute(sql`
      SELECT
        TO_CHAR(created_at, \'Mon \'\'YY\') AS month,
        COALESCE(SUM(CASE WHEN order_status = \'delivered\' THEN total_amount ELSE 0 END), 0) AS total,
        COUNT(*) AS orders
      FROM orders
      WHERE created_at >= NOW() - INTERVAL \'6 months\'
      GROUP BY TO_CHAR(created_at, \'Mon \'\'YY\'), DATE_TRUNC(\'month\', created_at)
      ORDER BY DATE_TRUNC(\'month\', created_at) ASC
    `);

    const monthlySales = (monthlySalesRaw.rows as any[]).map((r) => ({
      month: r.month as string,
      total: Number(r.total),
      orders: Number(r.orders),
    }));

    // Sales by TOP-LEVEL category (e.g. "Fruit Trees"), resolved by
    // walking product -> subcategory -> parent category. Order items are
    // a JSONB snapshot, so we match on productId and join through the
    // current categories table (category name is not frozen on the order,
    // only price/name at time of purchase are).
    const salesByCategoryRaw = await db.execute(sql`
      SELECT
        COALESCE(parent.name, sub.name, \'Uncategorized\') AS category,
        COUNT(DISTINCT o.id) AS count,
        COALESCE(SUM(o.total_amount), 0) AS total
      FROM products p
      LEFT JOIN categories sub ON sub.id = p.category_id
      LEFT JOIN categories parent ON parent.id = sub.parent_id
      LEFT JOIN orders o ON o.order_status = \'delivered\'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(o.items) AS item
          WHERE (item->>\'productId\')::int = p.id
        )
      GROUP BY COALESCE(parent.name, sub.name, \'Uncategorized\')
      ORDER BY total DESC
      LIMIT 10
    `);

    const salesByCategory = (salesByCategoryRaw.rows as any[]).map((r) => ({
      category: r.category as string,
      total: Number(r.total),
      count: Number(r.count),
    }));

    res.json({
      totalSales: Number(totalSales),
      totalOrders: Number(totalOrders),
      totalUsers: Number(totalUsers),
      pendingOrders: Number(pendingOrders),
      recentOrders: recentOrders.map(formatOrder),
      salesByCategory,
      monthlySales,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load dashboard" });
  }
});

router.get("/admin/orders/stats", requireAdmin, async (_req, res) => {
  try {
    const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const [activeResult, archivedResult, archivedPreOrderResult] = await Promise.all([
      db.select({ count: sql<string>`COUNT(*)` })
        .from(ordersTable)
        .where(
          sql`NOT (
            (order_status = \'delivered\' OR order_status = \'cancelled\')
            AND updated_at < ${TWO_DAYS_AGO.toISOString()}
          )`
        ),
      db.select({ count: sql<string>`COUNT(*)` })
        .from(ordersTable)
        .where(and(
          or(
            eq(ordersTable.orderStatus, "delivered"),
            eq(ordersTable.orderStatus, "cancelled")
          ),
          lt(ordersTable.updatedAt, TWO_DAYS_AGO)
        )),
      db.select({ count: sql<string>`COUNT(*)` })
        .from(preOrdersTable)
        .where(and(
          or(
            eq(preOrdersTable.status, "delivered"),
            eq(preOrdersTable.status, "cancelled")
          ),
          lt(preOrdersTable.updatedAt, TWO_DAYS_AGO)
        )),
    ]);
    res.json({
      activeOrders: Number(activeResult[0].count),
      archivedOrders: Number(archivedResult[0].count) + Number(archivedPreOrderResult[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch order stats" });
  }
});

router.get("/admin/orders/archived", requireAdmin, async (req: ApiRequest, res) => {
  try {
    const { page = "1" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limit = 15;
    const offset = (pageNum - 1) * limit;
    const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const baseSelect = {
      id: ordersTable.id,
      trackingId: ordersTable.trackingId,
      userId: ordersTable.userId,
      sellerId: ordersTable.sellerId,
      items: ordersTable.items,
      totalAmount: ordersTable.totalAmount,
      paymentMethod: ordersTable.paymentMethod,
      paymentStatus: ordersTable.paymentStatus,
      orderStatus: ordersTable.orderStatus,
      transactionId: ordersTable.transactionId,
      shippingAddress: ordersTable.shippingAddress,
      couponCode: ordersTable.couponCode,
      discountAmount: ordersTable.discountAmount,
      cancellationReason: ordersTable.cancellationReason,
      createdAt: ordersTable.createdAt,
      updatedAt: ordersTable.updatedAt,
      userEmail: usersTable.email,
      userFirstName: usersTable.firstName,
      userLastName: usersTable.lastName,
      userPhone: usersTable.phone,
      // Seller join — same as /admin/orders above. Archived orders also
      // need seller context so the admin can audit who fulfilled what.
      sellerBusinessName: sellersTable.businessName,
      sellerOwnerName: sellersTable.ownerName,
      sellerContactEmail: sellersTable.contactEmail,
      sellerContactPhone: sellersTable.contactPhone,
      sellerStatus: sellersTable.status,
      sellerLogoUrl: sellersTable.logoUrl,
      giftWrap: ordersTable.giftWrap,
      giftMessage: ordersTable.giftMessage,
      senderNumber: ordersTable.senderNumber,
      paidAt: ordersTable.paidAt,
    };

    const [orders, [{ total }]] = await Promise.all([
      db.select(baseSelect)
        .from(ordersTable)
        .leftJoin(usersTable, eq(ordersTable.userId, usersTable.clerkId))
        .leftJoin(sellersTable, eq(ordersTable.sellerId, sellersTable.id))
        .where(and(
          or(
            eq(ordersTable.orderStatus, "delivered"),
            eq(ordersTable.orderStatus, "cancelled")
          ),
          lt(ordersTable.updatedAt, TWO_DAYS_AGO)
        ))
        .orderBy(desc(ordersTable.updatedAt))
        .limit(limit)
        .offset(offset) as unknown as Promise<OrderWithUser[]>,
      db.select({ total: sql<string>`COUNT(*)` })
        .from(ordersTable)
        .where(and(
          or(
            eq(ordersTable.orderStatus, "delivered"),
            eq(ordersTable.orderStatus, "cancelled")
          ),
          lt(ordersTable.updatedAt, TWO_DAYS_AGO)
        )),
    ]);

    const TWO_DAYS_AGO2 = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    // Archived pre-orders: join through sellerListingVariantId -> variant ->
    // listing -> seller so the admin can see which seller fulfilled each
    // archived pre-order, same as the new /admin/pre-orders endpoint below.
    // All joins are LEFT because (a) sellerListingVariantId is NULL on
    // legacy rows created before the Phase 6 migration, (b) the variant
    // or listing row may have been deleted (pre_orders is a denormalized
    // historical record, no FK), and (c) the seller row may have been
    // deleted (sellersTable.user_id cascades, but a seller could be gone
    // for other reasons). The frontend handles null seller fields.
    const archivedPreOrders = await db
      .select({
        id: preOrdersTable.id,
        trackingId: preOrdersTable.trackingId,
        userId: preOrdersTable.userId,
        productId: preOrdersTable.productId,
        productName: preOrdersTable.productName,
        productImage: preOrdersTable.productImage,
        sellerListingVariantId: preOrdersTable.sellerListingVariantId,
        quantity: preOrdersTable.quantity,
        productPrice: preOrdersTable.productPrice,
        discountedPrice: preOrdersTable.discountedPrice,
        deliveryCharge: preOrdersTable.deliveryCharge,
        whatsappPhone: preOrdersTable.whatsappPhone,
        shippingAddress: preOrdersTable.shippingAddress,
        paymentMethod: preOrdersTable.paymentMethod,
        senderNumber: preOrdersTable.senderNumber,
        transactionId: preOrdersTable.transactionId,
        paymentStatus: preOrdersTable.paymentStatus,
        status: preOrdersTable.status,
        notifiedAt: preOrdersTable.notifiedAt,
        cancellationReason: preOrdersTable.cancellationReason,
        createdAt: preOrdersTable.createdAt,
        updatedAt: preOrdersTable.updatedAt,
        sellerBusinessName: sellersTable.businessName,
        sellerOwnerName: sellersTable.ownerName,
        sellerContactEmail: sellersTable.contactEmail,
        sellerContactPhone: sellersTable.contactPhone,
        sellerStatus: sellersTable.status,
        sellerLogoUrl: sellersTable.logoUrl,
      })
      .from(preOrdersTable)
      .leftJoin(sellerListingVariantsTable, eq(preOrdersTable.sellerListingVariantId, sellerListingVariantsTable.id))
      .leftJoin(sellerListingsTable, eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id))
      .leftJoin(sellersTable, eq(sellerListingsTable.sellerId, sellersTable.id))
      .where(and(
        or(
          eq(preOrdersTable.status, "delivered"),
          eq(preOrdersTable.status, "cancelled")
        ),
        lt(preOrdersTable.updatedAt, TWO_DAYS_AGO2)
      ))
      .orderBy(desc(preOrdersTable.updatedAt));

    res.json({
      orders: orders.map(formatOrderWithUser),
      preOrders: archivedPreOrders,
      total: Number(total),
      page: pageNum,
      hasMore: offset + limit < Number(total),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch archived orders" });
  }
});

router.get("/admin/orders", requireAdmin, async (req: ApiRequest, res) => {
  try {
    const { status, page = "1" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = 20;
    const offset = (pageNum - 1) * limitNum;

    if (status && !VALID_ORDER_STATUSES.includes(status)) {
      res.status(400).json({ error: "Invalid order status filter" });
      return;
    }

    const baseSelect = {
      id: ordersTable.id,
      trackingId: ordersTable.trackingId,
      userId: ordersTable.userId,
      sellerId: ordersTable.sellerId,
      items: ordersTable.items,
      totalAmount: ordersTable.totalAmount,
      paymentMethod: ordersTable.paymentMethod,
      paymentStatus: ordersTable.paymentStatus,
      orderStatus: ordersTable.orderStatus,
      transactionId: ordersTable.transactionId,
      shippingAddress: ordersTable.shippingAddress,
      couponCode: ordersTable.couponCode,
      discountAmount: ordersTable.discountAmount,
      cancellationReason: ordersTable.cancellationReason,
      createdAt: ordersTable.createdAt,
      updatedAt: ordersTable.updatedAt,
      userEmail: usersTable.email,
      userFirstName: usersTable.firstName,
      userLastName: usersTable.lastName,
      userPhone: usersTable.phone,
      // Seller join — added Phase 6+ so the admin Orders tab can show which
      // seller is responsible for each order without a second round-trip.
      // LEFT JOIN because legacy (pre-Phase-2) orders may have sellerId=NULL.
      sellerBusinessName: sellersTable.businessName,
      sellerOwnerName: sellersTable.ownerName,
      sellerContactEmail: sellersTable.contactEmail,
      sellerContactPhone: sellersTable.contactPhone,
      sellerStatus: sellersTable.status,
      sellerLogoUrl: sellersTable.logoUrl,
      giftWrap: ordersTable.giftWrap,
      giftMessage: ordersTable.giftMessage,
      senderNumber: ordersTable.senderNumber,
      paidAt: ordersTable.paidAt,
    };

    const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const notArchived = not(and(
      inArray(ordersTable.orderStatus, ["delivered", "cancelled"]),
      lt(ordersTable.updatedAt, TWO_DAYS_AGO)
    )!);

    const whereClause = status
      ? and(eq(ordersTable.orderStatus, status), notArchived)
      : notArchived;

    const [orders, [{ total }]] = await Promise.all([
      db.select(baseSelect)
        .from(ordersTable)
        .leftJoin(usersTable, eq(ordersTable.userId, usersTable.clerkId))
        .leftJoin(sellersTable, eq(ordersTable.sellerId, sellersTable.id))
        .where(whereClause)
        .orderBy(desc(ordersTable.createdAt))
        .limit(limitNum)
        .offset(offset) as unknown as Promise<OrderWithUser[]>,
      db.select({ total: sql<string>`COUNT(*)` })
        .from(ordersTable)
        .where(whereClause),
    ]);

    const totalNum = Number(total);
    res.json({
      orders: orders.map(formatOrderWithUser),
      total: totalNum,
      hasMore: offset + limitNum < totalNum,
    });
  } catch (err: any) {
    logger.error({ err }, "Admin: orders endpoint failed");
    res.status(500).json({ error: err?.message ?? "Failed to fetch orders" });
  }
});

router.put("/admin/orders/:id/status", requireAdmin, validateParams(UpdateOrderStatusParams, "UpdateOrderStatusParams"), validateBody(UpdateOrderStatusBody, "UpdateOrderStatusBody"), async (req: ApiRequest<z.infer<typeof UpdateOrderStatusBody>>, res) => {
  try {
    const id = req.params.id as unknown as number;  // VAL-MIGRATE-3: validated + coerced

    const { orderStatus, cancellationReason } = req.body;

    // VAL-MIGRATE-3: Zod validates shape (orderStatus: string, cancellationReason:
    // string | null | undefined). The VALID_ORDER_STATUSES check is a business
    // rule (enum membership) — kept as a semantic check.
    if (!orderStatus || !VALID_ORDER_STATUSES.includes(orderStatus)) {
      res.status(400).json({ error: "Invalid order status" });
      return;
    }

    const [existing] = await db
      .select({ orderStatus: ordersTable.orderStatus, items: ordersTable.items })
      .from(ordersTable)
      .where(eq(ordersTable.id, id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    if (existing.orderStatus === "delivered") {
      res.status(400).json({ error: "Cannot change status of a delivered order" });
      return;
    }
    if (existing.orderStatus === "cancelled") {
      res.status(400).json({ error: "Cannot change status of a cancelled order" });
      return;
    }

    if (orderStatus === "cancelled") {
      const reason = cancellationReason?.trim();
      if (!reason) {
        res.status(400).json({ error: "Cancellation reason is required" });
        return;
      }
    }

    const updateFields: Record<string, unknown> = {
      orderStatus,
      updatedAt: new Date(),
    };
    if (orderStatus === "cancelled") {
      updateFields.cancellationReason = cancellationReason?.trim() || null;
    }

    const [order] = await db
      .update(ordersTable)
      .set(updateFields)
      .where(eq(ordersTable.id, id))
      .returning();

    // NOTE: stock is deducted at ORDER PLACEMENT time (see orders.ts), not
    // on delivery. Deducting again here would double-count and could
    // overshoot into negative-then-clamped stock. This is the standard
    // e-commerce pattern (reserve inventory as soon as the order is
    // confirmed, not when it physically arrives).

    // Send status update email (non-blocking)
    if (order) {
      const [userRow] = await db
        .select({
          email: usersTable.email,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
        })
        .from(usersTable)
        .where(eq(usersTable.clerkId, order.userId))
        .limit(1);

      if (userRow?.email && !userRow.email.endsWith("@clerk.user")) {
        const name =
          [userRow.firstName, userRow.lastName].filter(Boolean).join(" ") ||
          "Customer";
        sendOrderStatusUpdate({
          to: userRow.email,
          name,
          orderId: order.id,
          trackingId: order.trackingId,
          newStatus: orderStatus,
        }).catch(() => {});
      }
    }

    await logAudit({ adminId: req.userId!, adminEmail: req.dbUser?.email ?? undefined, action: "order.status_changed", targetType: "order", targetId: String(id), after: { status: orderStatus } });
    res.json(formatOrder(order));
  } catch (err) {
    res.status(500).json({ error: "Failed to update order status" });
  }
});

router.put("/admin/orders/:id/payment", requireAdmin, validateParams(UpdateOrderPaymentParams, "UpdateOrderPaymentParams"), validateBody(UpdateOrderPaymentBody, "UpdateOrderPaymentBody"), async (req: ApiRequest<z.infer<typeof UpdateOrderPaymentBody>>, res) => {
  try {
    const id = req.params.id as unknown as number;  // VAL-MIGRATE-3: validated + coerced
    const { paymentStatus } = req.body;

    // VAL-MIGRATE-3: Zod validates shape (paymentStatus: string). The
    // VALID_PAYMENT_STATUSES check is a business rule — kept.
    if (!paymentStatus || !VALID_PAYMENT_STATUSES.includes(paymentStatus)) {
      res.status(400).json({ error: "Invalid payment status" });
      return;
    }

    const [order] = await db
      .update(ordersTable)
      .set({ paymentStatus, updatedAt: new Date() })
      .where(eq(ordersTable.id, id))
      .returning();

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    await logAudit({ adminId: req.userId!, adminEmail: req.dbUser?.email ?? undefined, action: "order.payment_updated", targetType: "order", targetId: String(id), after: { paymentStatus } });
    res.json(formatOrder(order));
  } catch (err) {
    res.status(500).json({ error: "Failed to update payment status" });
  }
});

/**
 * Admin: list all pre-orders with the seller that fulfilled (or is going to
 * fulfill) each one, joined through
 *   preOrders.sellerListingVariantId -> sellerListingVariants.sellerListingId
 *   -> sellerListings.sellerId -> sellers.id
 *
 * Replaces the admin frontend's previous use of the public GET /pre-orders
 * endpoint, which (a) had no auth and (b) returned no seller context. The
 * frontend's fetchAdminPreOrders now calls this route instead.
 *
 * The seller fields are nullable on every step of the join (see
 * /admin/orders/archived's archivedPreOrders query for the full rationale),
 * so the frontend must handle null seller fields the same way it does for
 * regular orders.
 */
router.get("/admin/pre-orders", requireAdmin, async (_req, res) => {
  try {
    const preOrders = await db
      .select({
        id: preOrdersTable.id,
        trackingId: preOrdersTable.trackingId,
        userId: preOrdersTable.userId,
        productId: preOrdersTable.productId,
        productName: preOrdersTable.productName,
        productImage: preOrdersTable.productImage,
        sellerListingVariantId: preOrdersTable.sellerListingVariantId,
        quantity: preOrdersTable.quantity,
        productPrice: preOrdersTable.productPrice,
        discountedPrice: preOrdersTable.discountedPrice,
        deliveryCharge: preOrdersTable.deliveryCharge,
        whatsappPhone: preOrdersTable.whatsappPhone,
        shippingAddress: preOrdersTable.shippingAddress,
        paymentMethod: preOrdersTable.paymentMethod,
        senderNumber: preOrdersTable.senderNumber,
        transactionId: preOrdersTable.transactionId,
        paymentStatus: preOrdersTable.paymentStatus,
        status: preOrdersTable.status,
        notifiedAt: preOrdersTable.notifiedAt,
        cancellationReason: preOrdersTable.cancellationReason,
        createdAt: preOrdersTable.createdAt,
        updatedAt: preOrdersTable.updatedAt,
        sellerBusinessName: sellersTable.businessName,
        sellerOwnerName: sellersTable.ownerName,
        sellerContactEmail: sellersTable.contactEmail,
        sellerContactPhone: sellersTable.contactPhone,
        sellerStatus: sellersTable.status,
        sellerLogoUrl: sellersTable.logoUrl,
      })
      .from(preOrdersTable)
      .leftJoin(sellerListingVariantsTable, eq(preOrdersTable.sellerListingVariantId, sellerListingVariantsTable.id))
      .leftJoin(sellerListingsTable, eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id))
      .leftJoin(sellersTable, eq(sellerListingsTable.sellerId, sellersTable.id))
      .orderBy(desc(preOrdersTable.createdAt));

    res.json(preOrders);
  } catch (err: any) {
    logger.error({ err }, "Admin: pre-orders endpoint failed");
    res.status(500).json({ error: err?.message ?? "Failed to fetch admin pre-orders" });
  }
});

router.get("/admin/users", requireAdmin, async (_req, res) => {
  try {
    const usersRaw = await db
      .select()
      .from(usersTable)
      .orderBy(desc(usersTable.createdAt));

    const orderCountsRaw = await db.execute(sql`
      SELECT user_id, COUNT(*) AS order_count
      FROM orders
      GROUP BY user_id
    `);
    const orderCountMap: Record<string, number> = {};
    for (const row of orderCountsRaw.rows as any[]) {
      orderCountMap[row.user_id] = Number(row.order_count);
    }

    res.json(
      usersRaw.map((u) => ({
        id: u.id,
        clerkId: u.clerkId,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        phone: u.phone,
        role: u.role,
        isBlocked: u.isBlocked,
        orderCount: orderCountMap[u.clerkId] ?? 0,
        createdAt: u.createdAt.toISOString(),
      })),
    );
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

router.put("/admin/users/:id/block", requireAdmin, validateParams(ToggleUserBlockParams, "ToggleUserBlockParams"), validateBody(ToggleUserBlockBody, "ToggleUserBlockBody"), async (req: ApiRequest<z.infer<typeof ToggleUserBlockBody>>, res) => {
  try {
    const id = req.params.id as unknown as number;  // VAL-MIGRATE-3: validated + coerced
    const { isBlocked } = req.body;
    // VAL-MIGRATE-3: Zod validates shape (isBlocked: boolean). No manual
    // check needed — z.boolean() enforces both type and presence.

    const [targetUser] = await db
      .select({ clerkId: usersTable.clerkId })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);

    if (targetUser?.clerkId === req.userId) {
      res.status(400).json({ error: "You cannot block your own account" });
      return;
    }

    const [user] = await db
      .update(usersTable)
      .set({ isBlocked, updatedAt: new Date() })
      .where(eq(usersTable.id, id))
      .returning();

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({
      id: user.id,
      clerkId: user.clerkId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      role: user.role,
      isBlocked: user.isBlocked,
      createdAt: user.createdAt.toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to update user" });
  }
});

// ─── Admin payout visibility + manual retry -- Part 4 of 4 ─────────────────
// (see PART4_HANDOFF.md). payoutsTable has been written to since Part 3
// (bKash B2C disbursement on courier delivery), but nothing surfaced those
// rows anywhere until now -- this is that surface.

/**
 * Formats a payoutsTable row joined against ordersTable/sellersTable for
 * human-readable admin display -- raw ids alone (orderId, sellerId) don't
 * tell an admin what actually happened; the tracking id and seller
 * business name do. Both joins are LEFT: an order/seller row could in
 * principle be gone (payoutsTable's own FKs are RESTRICT, not CASCADE --
 * see that schema's doc comment -- so this is largely defensive, not an
 * expected case, but the admin list must not 500 if it somehow happens).
 */
type PayoutWithContext = typeof payoutsTable.$inferSelect & {
  orderTrackingId: string | null;
  orderStatus: string | null;
  sellerBusinessName: string | null;
  sellerOwnerName: string | null;
};

function formatPayout(p: PayoutWithContext) {
  return {
    id: p.id,
    orderId: p.orderId,
    orderTrackingId: p.orderTrackingId ?? null,
    orderStatus: p.orderStatus ?? null,
    sellerId: p.sellerId,
    sellerBusinessName: p.sellerBusinessName ?? null,
    sellerOwnerName: p.sellerOwnerName ?? null,
    amount: Number(p.amount),
    status: p.status,
    bkashTransactionId: p.bkashTransactionId ?? null,
    failureReason: p.failureReason ?? null,
    adminNote: p.adminNote ?? null,
    clawbackNotedAmount: p.clawbackNotedAmount != null ? Number(p.clawbackNotedAmount) : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/**
 * Admin: list payout attempts, newest first, optionally filtered by
 * status. Follows /admin/orders's own query-param handling (checked that
 * route first, per the prompt's instruction): `?status=` filter,
 * `?page=` pagination with a fixed page size, `hasMore` in the response.
 * No `notArchived`-style time-based exclusion here (unlike /admin/orders)
 * -- there's no equivalent "archived" concept for payouts; every row stays
 * visible regardless of age, since a payout is itself already a discrete,
 * timestamped historical record rather than something evolving over time
 * the way an order's orderStatus does.
 */
router.get("/admin/payouts", requireAdmin, async (req: ApiRequest, res) => {
  try {
    const { status, page = "1" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = 20;
    const offset = (pageNum - 1) * limitNum;

    if (status && !VALID_PAYOUT_STATUSES.includes(status)) {
      res.status(400).json({ error: "Invalid payout status filter" });
      return;
    }

    const baseSelect = {
      id: payoutsTable.id,
      orderId: payoutsTable.orderId,
      sellerId: payoutsTable.sellerId,
      amount: payoutsTable.amount,
      status: payoutsTable.status,
      bkashTransactionId: payoutsTable.bkashTransactionId,
      failureReason: payoutsTable.failureReason,
      adminNote: payoutsTable.adminNote,
      clawbackNotedAmount: payoutsTable.clawbackNotedAmount,
      createdAt: payoutsTable.createdAt,
      updatedAt: payoutsTable.updatedAt,
      orderTrackingId: ordersTable.trackingId,
      orderStatus: ordersTable.orderStatus,
      sellerBusinessName: sellersTable.businessName,
      sellerOwnerName: sellersTable.ownerName,
    };

    const whereClause = status ? eq(payoutsTable.status, status) : undefined;

    const [payouts, [{ total }]] = await Promise.all([
      db
        .select(baseSelect)
        .from(payoutsTable)
        .leftJoin(ordersTable, eq(payoutsTable.orderId, ordersTable.id))
        .leftJoin(sellersTable, eq(payoutsTable.sellerId, sellersTable.id))
        .where(whereClause)
        .orderBy(desc(payoutsTable.createdAt))
        .limit(limitNum)
        .offset(offset) as Promise<PayoutWithContext[]>,
      whereClause
        ? db.select({ total: sql<string>`COUNT(*)` }).from(payoutsTable).where(whereClause)
        : db.select({ total: sql<string>`COUNT(*)` }).from(payoutsTable),
    ]);

    const totalNum = Number(total);
    res.json({
      payouts: payouts.map(formatPayout),
      total: totalNum,
      hasMore: offset + limitNum < totalNum,
    });
  } catch (err: any) {
    logger.error({ err }, "Admin: payouts endpoint failed");
    res.status(500).json({ error: err?.message ?? "Failed to fetch payouts" });
  }
});

/**
 * Admin: manually retry a payout. Per the prompt's explicit instruction,
 * this re-runs the EXACT SAME logic Part 3's attemptSellerPayout()
 * already implements -- now shared via lib/payouts.ts (see that file's
 * doc comment) -- rather than a second, separate retry implementation.
 *
 * `:id` identifies the FAILED payout row the admin is looking at, but note
 * what actually gets re-attempted is the ORDER behind it
 * (`payout.orderId`), not the row itself -- attemptSellerPayout() always
 * inserts a fresh row per attempt (Part 3's retry policy, unchanged here),
 * so this route looks up the order, calls attemptSellerPayout(order)
 * again, and a NEW payoutsTable row is what actually records this retry's
 * outcome. The original failed row named in the URL is left exactly as it
 * was -- untouched, still visible in the list as history of the earlier
 * attempt.
 *
 * Only allowed from a "failed" row -- retrying a "pending" row makes no
 * sense (it may still be in flight, or its own last attempt already
 * decided success/failed and this route's own DB read would be stale
 * information to act on), and retrying a "success" row is actively wrong
 * (attemptSellerPayout()'s own idempotency guard would refuse it anyway
 * and simply return null with nothing recorded, but rejecting it here
 * with a clear 400 is a better experience than a silent no-op).
 */
router.post("/admin/payouts/:id/retry", requireAdmin, validateParams(UpdatePayoutNoteParams, "UpdatePayoutNoteParams"), async (req: ApiRequest, res) => {
  try {
    const id = req.params.id as unknown as number;  // VAL-MIGRATE-3: validated + coerced

    const [existingPayout] = await db.select().from(payoutsTable).where(eq(payoutsTable.id, id)).limit(1);
    if (!existingPayout) {
      res.status(404).json({ error: "Payout not found" });
      return;
    }
    if (existingPayout.status !== "failed") {
      res.status(400).json({ error: `Only a "failed" payout can be retried (this one is "${existingPayout.status}")` });
      return;
    }

    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, existingPayout.orderId)).limit(1);
    if (!order) {
      // Shouldn't happen (payoutsTable.orderId is a NOT NULL FK), but
      // payoutsTable's FK is RESTRICT not CASCADE (see its schema doc
      // comment) specifically so this kind of dangling reference can't
      // silently occur -- handled defensively anyway rather than assumed
      // impossible.
      res.status(404).json({ error: "The order behind this payout no longer exists" });
      return;
    }

    const result = await attemptSellerPayout(order);

    await logAudit({
      adminId: req.userId!,
      adminEmail: req.dbUser?.email ?? undefined,
      action: "payout.manual_retry",
      targetType: "payout",
      targetId: String(id),
      before: { previousPayoutId: existingPayout.id, previousStatus: existingPayout.status },
      after: result ? { newPayoutId: result.payoutId, newStatus: result.status } : { skipped: true },
    });

    if (!result) {
      // attemptSellerPayout()'s own guards decided nothing should happen
      // (e.g. a payout for this order already succeeded via some other
      // path between page-load and this click, or the order's
      // paymentStatus somehow isn't "paid") -- surfaced as a clear
      // message rather than a silent 200 with nothing to show for it.
      res.status(409).json({
        error: "Retry was not attempted -- this order no longer qualifies for a payout (already paid out, or not marked paid). Refresh the list to see the current state.",
      });
      return;
    }

    const [newPayout] = await db
      .select({
        id: payoutsTable.id,
        orderId: payoutsTable.orderId,
        sellerId: payoutsTable.sellerId,
        amount: payoutsTable.amount,
        status: payoutsTable.status,
        bkashTransactionId: payoutsTable.bkashTransactionId,
        failureReason: payoutsTable.failureReason,
        adminNote: payoutsTable.adminNote,
        clawbackNotedAmount: payoutsTable.clawbackNotedAmount,
        createdAt: payoutsTable.createdAt,
        updatedAt: payoutsTable.updatedAt,
        orderTrackingId: ordersTable.trackingId,
        orderStatus: ordersTable.orderStatus,
        sellerBusinessName: sellersTable.businessName,
        sellerOwnerName: sellersTable.ownerName,
      })
      .from(payoutsTable)
      .leftJoin(ordersTable, eq(payoutsTable.orderId, ordersTable.id))
      .leftJoin(sellersTable, eq(payoutsTable.sellerId, sellersTable.id))
      .where(eq(payoutsTable.id, result.payoutId))
      .limit(1);

    res.json(formatPayout(newPayout as PayoutWithContext));
  } catch (err: any) {
    logger.error({ err }, "Admin: payout retry failed");
    res.status(500).json({ error: err?.message ?? "Failed to retry payout" });
  }
});

/**
 * Admin: attach a manual note (and optionally a "noted" adjustment amount,
 * for the admin's own record-keeping only) to a specific payout row --
 * Part 4's lightest-weight item, deliberately. This exists ONLY for the
 * project's explicit "returns-after-payout are handled manually,
 * case-by-case, never automated" decision (restated in this part's own
 * prompt). Setting these fields:
 *  - Does NOT call bKash in any way.
 *  - Does NOT touch sellerPayoutAccountsTable, sellersTable, or any
 *    balance/ledger anywhere in this codebase (there is no such ledger --
 *    confirmed by grep, nothing computes a running seller balance from
 *    payoutsTable today).
 *  - Does NOT change `status` -- a payout that succeeded stays "success"
 *    even after a clawback note is attached; the note records a SEPARATE,
 *    later real-world event (a return happening after the money already
 *    moved), not a correction to whether the original disbursement
 *    happened.
 * `clawbackNotedAmount` accepts null/omitted (clearing it) or a
 * non-negative number -- no upper-bound check against the payout's own
 * `amount`, deliberately: an admin might legitimately want to note a
 * larger figure (e.g. a partial return plus a separate goodwill
 * adjustment) or this may not even correspond 1:1 to the original amount;
 * constraining it would assume a shape this deliberately-freeform field
 * doesn't need to have.
 */
router.patch("/admin/payouts/:id/note", requireAdmin, validateParams(UpdatePayoutNoteParams, "UpdatePayoutNoteParams"), validateBody(UpdatePayoutNoteBody, "UpdatePayoutNoteBody"), async (req: ApiRequest<z.infer<typeof UpdatePayoutNoteBody>>, res) => {
  try {
    const id = req.params.id as unknown as number;  // VAL-MIGRATE-3: validated + coerced

    const { adminNote, clawbackNotedAmount } = req.body;

    const updateFields: Record<string, unknown> = { updatedAt: new Date() };

    if (adminNote !== undefined) {
      updateFields.adminNote = adminNote === null || adminNote.trim() === "" ? null : adminNote.trim();
    }

    if (clawbackNotedAmount !== undefined) {
      if (clawbackNotedAmount === null || clawbackNotedAmount === "") {
        updateFields.clawbackNotedAmount = null;
      } else {
        const amountNum = Number(clawbackNotedAmount);
        if (isNaN(amountNum) || amountNum < 0) {
          res.status(400).json({ error: "clawbackNotedAmount must be a non-negative number, or null to clear it" });
          return;
        }
        updateFields.clawbackNotedAmount = amountNum.toFixed(2);
      }
    }

    if (Object.keys(updateFields).length === 1) {
      // Only updatedAt was set -- neither field was actually provided.
      res.status(400).json({ error: "Provide adminNote and/or clawbackNotedAmount" });
      return;
    }

    const [updated] = await db.update(payoutsTable).set(updateFields).where(eq(payoutsTable.id, id)).returning();
    if (!updated) {
      res.status(404).json({ error: "Payout not found" });
      return;
    }

    await logAudit({
      adminId: req.userId!,
      adminEmail: req.dbUser?.email ?? undefined,
      action: "payout.note_updated",
      targetType: "payout",
      targetId: String(id),
      after: { adminNote: updated.adminNote, clawbackNotedAmount: updated.clawbackNotedAmount },
    });

    res.json({
      id: updated.id,
      adminNote: updated.adminNote ?? null,
      clawbackNotedAmount: updated.clawbackNotedAmount != null ? Number(updated.clawbackNotedAmount) : null,
    });
  } catch (err: any) {
    logger.error({ err }, "Admin: payout note failed");
    res.status(500).json({ error: err?.message ?? "Failed to update payout note" });
  }
});

export default router;
