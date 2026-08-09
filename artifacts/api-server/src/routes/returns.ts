import { logAudit } from "../lib/audit";
import { Router } from "express";
import type { z } from "zod";
import { db } from "@workspace/db";
import { returnsTable, ordersTable, sellersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { validateBody, validateParams } from "../lib/validateRequest";
import { asyncHandler, HttpError } from "../lib/errors";
import { CreateReturnBody, UpdateReturnBody, IdParam } from "../lib/schemas";
import type { ApiRequest } from "../types/apiRequest";

const router = Router();

function fmt(r: typeof returnsTable.$inferSelect) {
  return {
    id: r.id,
    orderId: r.orderId,
    userId: r.userId,
    reason: r.reason,
    status: r.status,
    adminNote: r.adminNote ?? null,
    refundAmount: r.refundAmount != null ? Number(r.refundAmount) : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// User: Request a return
router.post(
  "/returns",
  requireAuth,
  validateBody(CreateReturnBody, "CreateReturnBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof CreateReturnBody>>, res) => {
    const { orderId, reason } = req.body;

    // Verify the order belongs to this user and is delivered
    const [order] = await db
      .select({ id: ordersTable.id, orderStatus: ordersTable.orderStatus, userId: ordersTable.userId, updatedAt: ordersTable.updatedAt })
      .from(ordersTable)
      .where(and(eq(ordersTable.id, orderId), eq(ordersTable.userId, req.userId!)))
      .limit(1);

    if (!order) throw new HttpError(404, "Order not found");
    if (order.orderStatus !== "delivered") {
      throw new HttpError(400, "Returns can only be requested for delivered orders");
    }

    // Enforce 7-day return window from delivery date
    const deliveredAt = new Date(order.updatedAt);
    const daysSinceDelivery = (Date.now() - deliveredAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceDelivery > 7) {
      throw new HttpError(400, "Return window has expired. Returns must be requested within 7 days of delivery.");
    }

    // Check no existing return request for this order
    const [existing] = await db
      .select({ id: returnsTable.id })
      .from(returnsTable)
      .where(eq(returnsTable.orderId, orderId))
      .limit(1);

    if (existing) {
      throw new HttpError(409, "A return request already exists for this order");
    }

    const [returnReq] = await db
      .insert(returnsTable)
      .values({ orderId, userId: req.userId!, reason: reason.trim() })
      .returning();

    res.status(201).json(fmt(returnReq));
  }),
);

// User: Get own returns
router.get(
  "/returns/me",
  requireAuth,
  asyncHandler(async (req: ApiRequest, res) => {
    const returns = await db
      .select()
      .from(returnsTable)
      .where(eq(returnsTable.userId, req.userId!))
      .orderBy(desc(returnsTable.createdAt));
    res.json(returns.map(fmt));
  }),
);

// Admin: Get all returns (with order details + seller context)
// Joins sellersTable via ordersTable.sellerId so the admin knows which
// seller is responsible for fulfilling each return. LEFT JOIN because
// legacy (pre-Phase-2) orders may have sellerId=NULL.
router.get(
  "/admin/returns",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await db
      .select({
        ret: returnsTable,
        orderItems: ordersTable.items,
        orderTotal: ordersTable.totalAmount,
        orderUpdatedAt: ordersTable.updatedAt,
        orderStatus: ordersTable.orderStatus,
        shippingAddress: ordersTable.shippingAddress,
        sellerBusinessName: sellersTable.businessName,
        sellerOwnerName: sellersTable.ownerName,
        sellerContactEmail: sellersTable.contactEmail,
        sellerContactPhone: sellersTable.contactPhone,
        sellerStatus: sellersTable.status,
      })
      .from(returnsTable)
      .leftJoin(ordersTable, eq(ordersTable.id, returnsTable.orderId))
      .leftJoin(sellersTable, eq(ordersTable.sellerId, sellersTable.id))
      .orderBy(desc(returnsTable.createdAt));

    const result = rows.map(({
      ret, orderItems, orderTotal, orderUpdatedAt, orderStatus, shippingAddress,
      sellerBusinessName, sellerOwnerName, sellerContactEmail, sellerContactPhone, sellerStatus,
    }) => ({
      ...fmt(ret),
      orderItems: orderItems ?? [],
      orderTotal: orderTotal ? Number(orderTotal) : null,
      orderDeliveredAt: orderUpdatedAt ? orderUpdatedAt.toISOString() : null,
      orderStatus,
      customerName: (shippingAddress as { fullName?: string } | null)?.fullName ?? null,
      sellerBusinessName: sellerBusinessName ?? null,
      sellerOwnerName: sellerOwnerName ?? null,
      sellerContactEmail: sellerContactEmail ?? null,
      sellerContactPhone: sellerContactPhone ?? null,
      sellerStatus: sellerStatus ?? null,
    }));

    res.json(result);
  }),
);

// Admin: Update return status
router.put(
  "/admin/returns/:id",
  requireAdmin,
  validateParams(IdParam, "IdParam"),
  validateBody(UpdateReturnBody, "UpdateReturnBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof UpdateReturnBody>, z.infer<typeof IdParam>>, res) => {
    const { id } = req.params;
    const { status, adminNote, refundAmount } = req.body;

    const updates: Partial<typeof returnsTable.$inferInsert> = {
      status,
      updatedAt: new Date(),
    };
    if (adminNote !== undefined) updates.adminNote = adminNote?.trim() || null;
    if (refundAmount !== undefined && refundAmount !== null) {
      const amt = Number(refundAmount);
      if (!isNaN(amt) && amt >= 0) updates.refundAmount = String(amt);
    }

    const [updated] = await db
      .update(returnsTable)
      .set(updates)
      .where(eq(returnsTable.id, id))
      .returning();

    if (!updated) throw new HttpError(404, "Return not found");

    // When refund is completed → flip order status to return_completed
    if (status === "completed") {
      await db
        .update(ordersTable)
        .set({ orderStatus: "return_completed", updatedAt: new Date() })
        .where(eq(ordersTable.id, updated.orderId));
    }

    await logAudit({ adminId: req.userId!, adminEmail: req.dbUser?.email ?? undefined, action: "return.updated", targetType: "return", targetId: String(id) });
    res.json(fmt(updated));
  }),
);

export default router;
