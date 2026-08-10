import { asyncHandler } from "../lib/errors";
import { Router } from "express";
import { db } from "@workspace/db";
import {
  ordersTable,
  orderShipmentsTable,
  usersTable,
  productVariantsTable,
  sellerListingVariantsTable,
} from "@workspace/db";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { requireSeller } from "../middlewares/auth";
import { sendOrderStatusUpdate } from "../lib/email";
import {
  GetSellerOrderParams,
  UpdateSellerOrderStatusParams,
  UpdateSellerOrderStatusBody,
} from "@workspace/api-zod";
import { validateBody, validateParams } from "../lib/validateRequest";
import { logger } from "../lib/logger";
import type { ApiRequest } from "../types/apiRequest";
import type { z } from "zod";

/**
 * Seller "Manage Orders" (plan doc §4). Deliberately a separate file from
 * routes/orders.ts rather than appended to it -- orders.ts is Part 3 scope
 * (cart/checkout migration) this session shouldn't reshape; the query
 * pattern (orders.sellerId already exists from Part 3, just unused by any
 * seller-facing route until now) is additive, not a rewrite.
 *
 * formatOrder here intentionally duplicates orders.ts's formatOrder rather
 * than importing/exporting it across files -- orders.ts doesn't export it,
 * and the shape sellers need (with a buyer contact + shipment status
 * folded in) is different enough from the buyer's own /orders/:id shape
 * that sharing one function would require a flag parameter. Small,
 * deliberate duplication over a shared function with a growing parameter
 * list.
 */

const router = Router();

function formatSellerOrder(
  o: typeof ordersTable.$inferSelect,
  shipment: typeof orderShipmentsTable.$inferSelect | undefined,
  buyerEmail: string | null,
) {
  return {
    id: o.id,
    trackingId: o.trackingId,
    items: o.items as any[],
    totalAmount: Number(o.totalAmount),
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    orderStatus: o.orderStatus,
    shippingAddress: o.shippingAddress as any,
    buyerEmail,
    cancellationReason: o.cancellationReason ?? null,
    shipment: shipment
      ? {
          courierProvider: shipment.courierProvider,
          courierTrackingId: shipment.courierTrackingId,
          status: shipment.status,
          lastSyncedAt: shipment.lastSyncedAt ? shipment.lastSyncedAt.toISOString() : null,
        }
      : null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

/**
 * Seller: list orders that belong to them (orders.sellerId = their seller
 * id). Optional orderStatus filter for the dashboard's status tabs.
 * PERF-5: Added DB-level LIMIT (default 50, max 100) + optional page param.
 * Non-breaking: response shape stays Order[]. The doc comment previously
 * said "not paginated" — that was the audit's PERF weakness #5; now bounded.
 */
router.get(
  "/seller/orders",
  requireSeller,
  asyncHandler(async (req, res) => {
    const { orderStatus } = req.query as { orderStatus?: string };
    const valid = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];

    // PERF-5: DB-level LIMIT — was unbounded.
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? "50")));
    const page = Math.max(1, parseInt((req.query.page as string) ?? "1"));
    const offset = (page - 1) * limit;

    const orders = await db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.sellerId, req.dbSeller!.id),
          orderStatus && valid.includes(orderStatus)
            ? eq(ordersTable.orderStatus, orderStatus)
            : undefined,
        ),
      )
      .orderBy(desc(ordersTable.createdAt))
      .limit(limit)
      .offset(offset);

    if (orders.length === 0) {
      res.json([]);
      return;
    }

    const orderIds = orders.map((o) => o.id);
    const shipments = await db
      .select()
      .from(orderShipmentsTable)
      .where(inArray(orderShipmentsTable.orderId, orderIds));
    const shipmentMap = new Map(shipments.map((s) => [s.orderId, s]));

    // Buyer email lookup: orders.userId is a Clerk id, not our own users.id
    // FK -- same join-by-clerkId pattern used elsewhere in this codebase
    // (e.g. orders.ts).
    const clerkIds = [...new Set(orders.map((o) => o.userId))];
    const users = await db.select().from(usersTable).where(inArray(usersTable.clerkId, clerkIds));
    const emailMap = new Map(users.map((u) => [u.clerkId, u.email]));

    res.json(
      orders.map((o) =>
        formatSellerOrder(
          o,
          shipmentMap.get(o.id),
          emailMap.get(o.userId)?.endsWith("@clerk.user") ? null : (emailMap.get(o.userId) ?? null),
        ),
      ),
    );
  }),
);

router.get(
  "/seller/orders/:id",
  requireSeller,
  validateParams(GetSellerOrderParams, "GetSellerOrderParams"),
  async (req: ApiRequest, res) => {
    try {
      const id = req.params.id as unknown as number; // VAL-MIGRATE-4: validated + coerced
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
      if (!order) {
        res.status(404).json({ error: "Order not found" });
        return;
      }
      if (order.sellerId !== req.dbSeller!.id) {
        res.status(403).json({ error: "You don't own this order" });
        return;
      }
      const [shipment] = await db
        .select()
        .from(orderShipmentsTable)
        .where(eq(orderShipmentsTable.orderId, id))
        .limit(1);
      const [buyer] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.clerkId, order.userId))
        .limit(1);
      const buyerEmail = buyer?.email && !buyer.email.endsWith("@clerk.user") ? buyer.email : null;

      res.json(formatSellerOrder(order, shipment, buyerEmail));
    } catch (err) {
      logger.error({ err: err }, "Get seller order error");
      res.status(500).json({ error: "Failed to fetch order" });
    }
  },
);

/**
 * Seller: advance order status (pending -> confirmed -> processing ->
 * shipped -> delivered), or cancel. Distinct from the shipment-status
 * dropdown in orderShipments.ts's PUT /seller/orders/:orderId/shipment-status
 * -- that one tracks the COURIER'S delivery state (picked_up/in_transit/
 * etc.), this one tracks the SELLER'S own order-processing state
 * (confirmed/processing/etc, matching ordersTable.orderStatus's existing
 * buyer-facing vocabulary used by /orders/track/:trackingId's timeline).
 *
 * STATE MACHINE (forward-only transitions):
 * Previously, sellers could move statuses backwards freely (e.g.
 * delivered → pending) with no audit trail — this broke payouts (which
 * trigger on "delivered"), returns (window starts at deliveredAt), and
 * the buyer's timeline display. Now enforces forward-only transitions:
 *   pending → confirmed → processing → shipped → delivered
 *   any non-terminal → cancelled
 * "delivered" and "cancelled" are terminal — no further transitions
 * allowed (except "delivered" → "return_completed" via the returns flow,
 * which is admin-gated, not seller-gated).
 *
 * Sets the corresponding per-status timestamp (confirmedAt, shippedAt,
 * deliveredAt, cancelledAt) when the status changes — used by the return
 * window, SLA reporting, and the OrderTimeline component.
 */
router.put(
  "/seller/orders/:id/status",
  requireSeller,
  validateParams(UpdateSellerOrderStatusParams, "UpdateSellerOrderStatusParams"),
  validateBody(UpdateSellerOrderStatusBody, "UpdateSellerOrderStatusBody"),
  async (req: ApiRequest<z.infer<typeof UpdateSellerOrderStatusBody>>, res) => {
    try {
      const id = req.params.id as unknown as number; // VAL-MIGRATE-4: validated + coerced
      const { orderStatus, cancellationReason } = req.body;
      // VAL-MIGRATE-4: Zod validates shape — orderStatus is
      // zod.enum(['pending','confirmed','processing','shipped','delivered','cancelled']),
      // so the manual valid.includes() check is superseded.
      // Business rule kept: cancellationReason required when cancelling.
      if (
        orderStatus === "cancelled" &&
        (!cancellationReason || cancellationReason.trim().length < 3)
      ) {
        res.status(400).json({ error: "cancellationReason is required when cancelling" });
        return;
      }

      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
      if (!order) {
        res.status(404).json({ error: "Order not found" });
        return;
      }
      if (order.sellerId !== req.dbSeller!.id) {
        res.status(403).json({ error: "You don't own this order" });
        return;
      }

      // ── State machine validation (forward-only) ───────────────────
      // Prevents backwards transitions that break downstream consumers
      // (payouts, returns, timeline). Terminal states (delivered,
      // cancelled, return_completed) can't be changed by the seller.
      const FORWARD_ORDER: Record<string, number> = {
        pending: 0,
        confirmed: 1,
        processing: 2,
        shipped: 3,
        delivered: 4,
      };
      const currentIdx = FORWARD_ORDER[order.orderStatus] ?? -1;
      const newIdx = FORWARD_ORDER[orderStatus] ?? -1;

      // Terminal states: seller can't change them (only admin returns flow can).
      if (
        order.orderStatus === "delivered" ||
        order.orderStatus === "cancelled" ||
        order.orderStatus === "return_completed"
      ) {
        res.status(400).json({
          error: `Cannot change status of an order that is already "${order.orderStatus}".`,
        });
        return;
      }

      // Cancellation is allowed from any non-terminal state.
      if (orderStatus === "cancelled") {
        // Allowed — seller can cancel pending/confirmed/processing/shipped.
      } else if (newIdx === -1) {
        res.status(400).json({ error: `Invalid order status: ${orderStatus}` });
        return;
      } else if (newIdx <= currentIdx) {
        // Backwards transition — reject. A seller correcting their own
        // mistake should use the admin support flow, not silently flip
        // status backwards (which breaks payouts + returns + timeline).
        res.status(400).json({
          error: `Cannot move order from "${order.orderStatus}" to "${orderStatus}" — status can only advance forward. If you made a mistake, please contact support.`,
        });
        return;
      }

      // Build the update set — set the corresponding timestamp when the
      // status changes.
      const updates: Partial<typeof ordersTable.$inferInsert> = {
        orderStatus,
        updatedAt: new Date(),
      };
      if (orderStatus === "cancelled") {
        updates.cancellationReason = cancellationReason!.trim();
        updates.cancelledAt = new Date();
      } else if (orderStatus === "confirmed") {
        updates.confirmedAt = new Date();
      } else if (orderStatus === "shipped") {
        updates.shippedAt = new Date();
      } else if (orderStatus === "delivered") {
        updates.deliveredAt = new Date();
      }

      // ── Stock restoration on seller cancel ─────────────────────────
      // Same as buyer cancel: restore the stock that was decremented at
      // checkout. Additive (idempotent).
      if (orderStatus === "cancelled") {
        const items = (order.items ?? []) as any[];
        for (const item of items) {
          if (item.variantId != null) {
            await db
              .update(productVariantsTable)
              .set({ stock: sql`${productVariantsTable.stock} + ${item.quantity}` })
              .where(eq(productVariantsTable.id, item.variantId));
          } else if (item.sellerListingVariantId != null) {
            await db
              .update(sellerListingVariantsTable)
              .set({
                stock: sql`${sellerListingVariantsTable.stock} + ${item.quantity}`,
                availableQuantity: sql`${sellerListingVariantsTable.availableQuantity} + ${item.quantity}`,
                updatedAt: new Date(),
              })
              .where(eq(sellerListingVariantsTable.id, item.sellerListingVariantId));
          }
        }
      }

      const [updated] = await db
        .update(ordersTable)
        .set(updates)
        .where(eq(ordersTable.id, id))
        .returning();

      try {
        const [buyer] = await db
          .select()
          .from(usersTable)
          .where(eq(usersTable.clerkId, order.userId))
          .limit(1);
        if (buyer?.email && !buyer.email.endsWith("@clerk.user")) {
          const name = [buyer.firstName, buyer.lastName].filter(Boolean).join(" ") || "Customer";
          await sendOrderStatusUpdate({
            to: buyer.email,
            name,
            orderId: order.id,
            trackingId: order.trackingId,
            newStatus: orderStatus,
          }).catch(() => {});
        }
      } catch (err) {
        logger.error({ err }, "Route handler error");
        /* non-blocking */
      }

      const [shipment] = await db
        .select()
        .from(orderShipmentsTable)
        .where(eq(orderShipmentsTable.orderId, id))
        .limit(1);
      res.json(formatSellerOrder(updated, shipment, null));
    } catch (err) {
      logger.error({ err: err }, "Update seller order status error");
      res.status(500).json({ error: "Failed to update order status" });
    }
  },
);

export default router;
