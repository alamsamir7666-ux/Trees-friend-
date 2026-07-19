import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable, orderShipmentsTable, usersTable } from "@workspace/db";
import { eq, and, desc, inArray } from "drizzle-orm";
import { requireSeller } from "../middlewares/auth";
import { sendOrderStatusUpdate } from "../lib/email";

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
 * id). Optional orderStatus filter for the dashboard's status tabs. Not
 * paginated -- matches the existing GET /orders (buyer) and GET
 * /admin/seller-listings conventions in this codebase, none of which
 * paginate either; a seller-scale order volume (hundreds, not the
 * platform's total) doesn't yet justify introducing pagination as a
 * one-off pattern here.
 */
router.get("/seller/orders", requireSeller, async (req, res) => {
  try {
    const { orderStatus } = req.query as { orderStatus?: string };
    const valid = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];

    const orders = await db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.sellerId, req.dbSeller!.id),
          orderStatus && valid.includes(orderStatus) ? eq(ordersTable.orderStatus, orderStatus) : undefined,
        ),
      )
      .orderBy(desc(ordersTable.createdAt));

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
    // FK -- same join-by-clerkId pattern smsWebhook.ts and orders.ts both
    // already use elsewhere in this codebase.
    const clerkIds = [...new Set(orders.map((o) => o.userId))];
    const users = await db.select().from(usersTable).where(inArray(usersTable.clerkId, clerkIds));
    const emailMap = new Map(users.map((u) => [u.clerkId, u.email]));

    res.json(
      orders.map((o) =>
        formatSellerOrder(o, shipmentMap.get(o.id), emailMap.get(o.userId)?.endsWith("@clerk.user") ? null : emailMap.get(o.userId) ?? null),
      ),
    );
  } catch (err) {
    console.error("List seller orders error:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

router.get("/seller/orders/:id", requireSeller, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid order id" });
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
    const [shipment] = await db.select().from(orderShipmentsTable).where(eq(orderShipmentsTable.orderId, id)).limit(1);
    const [buyer] = await db.select().from(usersTable).where(eq(usersTable.clerkId, order.userId)).limit(1);
    const buyerEmail = buyer?.email && !buyer.email.endsWith("@clerk.user") ? buyer.email : null;

    res.json(formatSellerOrder(order, shipment, buyerEmail));
  } catch (err) {
    console.error("Get seller order error:", err);
    res.status(500).json({ error: "Failed to fetch order" });
  }
});

/**
 * Seller: advance order status (pending -> confirmed -> processing ->
 * shipped -> delivered), or cancel. Distinct from the shipment-status
 * dropdown in orderShipments.ts's PUT /seller/orders/:orderId/shipment-status
 * -- that one tracks the COURIER'S delivery state (picked_up/in_transit/
 * etc.), this one tracks the SELLER'S own order-processing state
 * (confirmed/processing/etc, matching ordersTable.orderStatus's existing
 * buyer-facing vocabulary used by /orders/track/:trackingId's timeline).
 * The two are related but not identical -- a seller confirms an order
 * before a courier is even booked, for instance.
 *
 * No forward-only transition enforcement here (unlike the buyer's own
 * cancel-only-if-pending rule in orders.ts) -- a seller correcting their
 * own mistake (e.g. accidentally marking delivered too early) is a
 * legitimate action their dashboard should allow, not something to gate
 * behind a state machine that doesn't exist elsewhere in this codebase.
 */
router.put("/seller/orders/:id/status", requireSeller, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const { orderStatus, cancellationReason } = req.body as { orderStatus?: string; cancellationReason?: string };
    const valid = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];
    if (!orderStatus || !valid.includes(orderStatus)) {
      res.status(400).json({ error: `orderStatus must be one of: ${valid.join(", ")}` });
      return;
    }
    if (orderStatus === "cancelled" && (!cancellationReason || cancellationReason.trim().length < 3)) {
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

    const [updated] = await db
      .update(ordersTable)
      .set({
        orderStatus,
        cancellationReason: orderStatus === "cancelled" ? cancellationReason!.trim() : order.cancellationReason,
        updatedAt: new Date(),
      })
      .where(eq(ordersTable.id, id))
      .returning();

    try {
      const [buyer] = await db.select().from(usersTable).where(eq(usersTable.clerkId, order.userId)).limit(1);
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
    } catch {
      /* non-blocking */
    }

    const [shipment] = await db.select().from(orderShipmentsTable).where(eq(orderShipmentsTable.orderId, id)).limit(1);
    res.json(formatSellerOrder(updated, shipment, null));
  } catch (err) {
    console.error("Update seller order status error:", err);
    res.status(500).json({ error: "Failed to update order status" });
  }
});

export default router;
