import { Router } from "express";
import { db } from "@workspace/db";
import { returnsTable, ordersTable, usersTable } from "@workspace/db";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { requireSeller } from "../middlewares/auth";
import { logAudit } from "../lib/audit";
import { createRateLimiter } from "../middlewares/rateLimiter";

/**
 * Seller-scoped mirror of routes/returns.ts's admin endpoints. Sellers can
 * only see and act on return requests for orders where ordersTable.sellerId
 * matches their own seller id -- the admin routes stay platform-wide and
 * untouched. Follows the same requireSeller + ownership-check pattern as
 * sellerOrders.ts, with pagination matching admin.ts's page/limit/offset +
 * COUNT(*) convention, and logAudit on every write (mirroring returns.ts's
 * admin PUT and every other seller-mutation route in this codebase).
 */

const router = Router();

const VALID_RETURN_STATUSES = ["approved", "rejected", "completed"] as const;
const VALID_FILTER_STATUSES = ["requested", "approved", "rejected", "completed"] as const;
const DEFAULT_PAGE_SIZE = 15;
const MAX_PAGE_SIZE = 50;

// Same rate-limit shape as the other write-heavy seller mutation routes
// (createRateLimiter is the established primitive -- see rateLimiter.ts).
const sellerReturnWriteLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: "Too many return updates. Please try again later.",
  keyPrefix: "seller-returns-write",
});

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

function parsePagination(query: Record<string, string>) {
  const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
  const limitRaw = parseInt(query.limit ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE;
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, limitRaw));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * Seller: list return requests for their own orders, with order + buyer
 * context. Paginated (page/limit query params, matching admin.ts's
 * archived-orders convention) and optionally filtered by ?status=.
 */
router.get("/seller/returns", requireSeller, async (req: any, res) => {
  try {
    const { status } = req.query as Record<string, string>;
    if (status !== undefined && !VALID_FILTER_STATUSES.includes(status as any)) {
      res.status(400).json({ error: `status filter must be one of: ${VALID_FILTER_STATUSES.join(", ")}` });
      return;
    }
    const { page, limit, offset } = parsePagination(req.query as Record<string, string>);
    const sellerId = req.dbSeller!.id;

    const whereClause = and(
      eq(ordersTable.sellerId, sellerId),
      status ? eq(returnsTable.status, status as any) : undefined,
    );

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          ret: returnsTable,
          orderItems: ordersTable.items,
          orderTotal: ordersTable.totalAmount,
          orderUpdatedAt: ordersTable.updatedAt,
          orderStatus: ordersTable.orderStatus,
          shippingAddress: ordersTable.shippingAddress,
        })
        .from(returnsTable)
        .innerJoin(ordersTable, eq(ordersTable.id, returnsTable.orderId))
        .where(whereClause)
        .orderBy(desc(returnsTable.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<string>`COUNT(*)` })
        .from(returnsTable)
        .innerJoin(ordersTable, eq(ordersTable.id, returnsTable.orderId))
        .where(whereClause),
    ]);

    if (rows.length === 0) {
      res.json({ returns: [], page, limit, total: Number(total), totalPages: Math.max(1, Math.ceil(Number(total) / limit)) });
      return;
    }

    // Buyer email lookup, same clerkId-join pattern as sellerOrders.ts
    const clerkIds = [...new Set(rows.map((r) => r.ret.userId))];
    const buyers = await db.select().from(usersTable).where(inArray(usersTable.clerkId, clerkIds));
    const emailMap = new Map(buyers.map((u) => [u.clerkId, u.email]));

    const result = rows.map(({ ret, orderItems, orderTotal, orderUpdatedAt, orderStatus, shippingAddress }) => {
      const buyerEmail = emailMap.get(ret.userId);
      return {
        ...fmt(ret),
        orderItems: orderItems ?? [],
        orderTotal: orderTotal ? Number(orderTotal) : null,
        orderDeliveredAt: orderUpdatedAt ? orderUpdatedAt.toISOString() : null,
        orderStatus,
        customerName: (shippingAddress as any)?.fullName ?? null,
        customerEmail: buyerEmail && !buyerEmail.endsWith("@clerk.user") ? buyerEmail : null,
      };
    });

    res.json({ returns: result, page, limit, total: Number(total), totalPages: Math.max(1, Math.ceil(Number(total) / limit)) });
  } catch (err) {
    console.error("List seller returns error:", err);
    res.status(500).json({ error: "Failed to fetch returns" });
  }
});

/**
 * Seller: get a single return for one of their own orders. Same ownership
 * check as the PUT below, split out because the dashboard's detail view
 * (and any future retry/polling) shouldn't have to refetch + refilter the
 * whole paginated list just to see one record's current state.
 */
router.get("/seller/returns/:id", requireSeller, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid return ID" });
      return;
    }

    const [row] = await db
      .select({
        ret: returnsTable,
        orderItems: ordersTable.items,
        orderTotal: ordersTable.totalAmount,
        orderUpdatedAt: ordersTable.updatedAt,
        orderStatus: ordersTable.orderStatus,
        shippingAddress: ordersTable.shippingAddress,
        orderSellerId: ordersTable.sellerId,
      })
      .from(returnsTable)
      .innerJoin(ordersTable, eq(ordersTable.id, returnsTable.orderId))
      .where(eq(returnsTable.id, id))
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "Return not found" });
      return;
    }
    if (row.orderSellerId !== req.dbSeller!.id) {
      res.status(403).json({ error: "You don't own the order for this return" });
      return;
    }

    const [buyer] = await db.select().from(usersTable).where(eq(usersTable.clerkId, row.ret.userId)).limit(1);
    const buyerEmail = buyer?.email && !buyer.email.endsWith("@clerk.user") ? buyer.email : null;

    res.json({
      ...fmt(row.ret),
      orderItems: row.orderItems ?? [],
      orderTotal: row.orderTotal ? Number(row.orderTotal) : null,
      orderDeliveredAt: row.orderUpdatedAt ? row.orderUpdatedAt.toISOString() : null,
      orderStatus: row.orderStatus,
      customerName: (row.shippingAddress as any)?.fullName ?? null,
      customerEmail: buyerEmail,
    });
  } catch (err) {
    console.error("Get seller return error:", err);
    res.status(500).json({ error: "Failed to fetch return" });
  }
});

/**
 * Seller: update status on a return for one of their own orders (approve /
 * reject / mark completed with a refund amount). "requested" is
 * deliberately excluded from VALID_RETURN_STATUSES -- a seller can only
 * move a request forward, never reset it back to the initial state, and
 * can only act on it once (approved/rejected/completed are all terminal
 * from a seller-action point of view, matching the admin UI's own gating
 * in ReturnsTab.tsx where only "requested" rows show action buttons).
 */
router.put("/seller/returns/:id", requireSeller, sellerReturnWriteLimiter, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid return ID" });
      return;
    }

    const { status, adminNote, refundAmount } = req.body ?? {};
    if (!status || typeof status !== "string" || !VALID_RETURN_STATUSES.includes(status as any)) {
      res.status(400).json({ error: `status must be one of: ${VALID_RETURN_STATUSES.join(", ")}` });
      return;
    }
    if (adminNote !== undefined && adminNote !== null && typeof adminNote !== "string") {
      res.status(400).json({ error: "adminNote must be a string" });
      return;
    }
    if (status === "rejected" && (!adminNote || adminNote.trim().length < 3)) {
      res.status(400).json({ error: "A rejection reason (adminNote) of at least 3 characters is required" });
      return;
    }

    let refundAmountNum: number | undefined;
    if (status === "completed") {
      if (refundAmount === undefined || refundAmount === null || refundAmount === "") {
        res.status(400).json({ error: "refundAmount is required to mark a return as completed" });
        return;
      }
      refundAmountNum = Number(refundAmount);
      if (isNaN(refundAmountNum) || refundAmountNum < 0) {
        res.status(400).json({ error: "refundAmount must be a non-negative number" });
        return;
      }
    }

    const [existing] = await db.select().from(returnsTable).where(eq(returnsTable.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Return not found" });
      return;
    }

    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, existing.orderId)).limit(1);
    if (!order || order.sellerId !== req.dbSeller!.id) {
      res.status(403).json({ error: "You don't own the order for this return" });
      return;
    }

    // Enforce a sane state machine: only "requested" can be approved/
    // rejected, and only "approved" can be completed -- mirrors the admin
    // UI's own gating (ReturnsTab.tsx) but enforced server-side too, since
    // this is a seller-facing endpoint and shouldn't trust the client.
    const allowedFrom: Record<string, string[]> = {
      approved: ["requested"],
      rejected: ["requested"],
      completed: ["approved"],
    };
    if (!allowedFrom[status].includes(existing.status)) {
      res.status(409).json({ error: `Cannot move a return from "${existing.status}" to "${status}"` });
      return;
    }

    const updates: Record<string, unknown> = { status, updatedAt: new Date() };
    if (adminNote !== undefined) updates.adminNote = adminNote?.trim() || null;
    if (refundAmountNum !== undefined) updates.refundAmount = String(refundAmountNum);

    const [updated] = await db
      .update(returnsTable)
      .set(updates)
      .where(eq(returnsTable.id, id))
      .returning();

    if (status === "completed") {
      await db
        .update(ordersTable)
        .set({ orderStatus: "return_completed", updatedAt: new Date() })
        .where(eq(ordersTable.id, updated.orderId));
    }

    await logAudit({
      adminId: req.userId,
      adminEmail: req.dbUser?.email,
      action: `seller.return.${status}`,
      targetType: "return",
      targetId: String(id),
      before: { status: existing.status },
      after: { status: updated.status, refundAmount: updated.refundAmount },
    });

    res.json(fmt(updated));
  } catch (err) {
    console.error("Update seller return error:", err);
    res.status(500).json({ error: "Failed to update return" });
  }
});

export default router;
