import { Router } from "express";
import { db } from "@workspace/db";
import {
  orderShipmentsTable,
  ordersTable,
  sellersTable,
  sellerCourierConfigsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireSeller, requireAuth } from "../middlewares/auth";
import { decryptCredential } from "../lib/credentialEncryption";
import { getCourierAdapter, CourierBookingError } from "../lib/courierAdapters";
import type { OrderItem } from "@workspace/db";

/**
 * Courier booking + shipment status (plan doc §8, Part 4 scope). Buyer-
 * facing tracking UI reads only from order_shipments -- never calls
 * Pathao/Steadfast directly, per plan doc §8's explicit instruction.
 *
 * A shipment row is created lazily on first "Book Courier" click or first
 * manual-status-set, not eagerly at order-creation time -- an order can sit
 * unshipped for a while (payment verification, stock prep), and there's no
 * requirement in the plan doc that every order gets a shipment row
 * immediately. GET routes below return null/404-shaped "not yet shipped"
 * rather than a row with placeholder values when none exists yet.
 */

const router = Router();

function formatShipment(s: typeof orderShipmentsTable.$inferSelect) {
  return {
    id: s.id,
    orderId: s.orderId,
    courierProvider: s.courierProvider,
    courierTrackingId: s.courierTrackingId,
    status: s.status,
    lastSyncedAt: s.lastSyncedAt ? s.lastSyncedAt.toISOString() : null,
  };
}

const MANUAL_STATUSES = ["pending", "picked_up", "in_transit", "delivered", "returned", "failed"] as const;

/**
 * Estimates total item weight for a Pathao booking from the order's line
 * items. orders.items[] has no weight field (schema was never extended for
 * it -- flagging, not guessing a real per-plant weight). Falls back to a
 * flat 1kg-per-unit estimate, which is a rough placeholder a seller should
 * expect to see reflected in Pathao's own weight-based fee if it's wrong;
 * this does not block booking, since Pathao's API accepts the estimate and
 * the seller can correct actual weight at pickup.
 */
function estimateWeightKg(items: OrderItem[]): number {
  const totalQty = items.reduce((s, i) => s + i.quantity, 0);
  return Math.max(0.5, totalQty * 1);
}

/**
 * Seller: get the shipment status for one of THEIR OWN orders. Ownership
 * check via orders.sellerId, same pattern as sellerListings.ts's
 * "You don't own this listing" 403.
 */
router.get("/seller/orders/:orderId/shipment", requireSeller, async (req: any, res) => {
  try {
    const orderId = parseInt(req.params.orderId);
    if (isNaN(orderId) || orderId <= 0) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
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
      .where(eq(orderShipmentsTable.orderId, orderId))
      .limit(1);
    res.json(shipment ? formatShipment(shipment) : null);
  } catch (err) {
    console.error("Get shipment error:", err);
    res.status(500).json({ error: "Failed to fetch shipment" });
  }
});

/**
 * Seller: "Book Courier" action (plan doc §8). Requires a verified
 * seller_courier_configs row for pathao/steadfast -- if none exists, or
 * exists but isn't verified, this 400s and tells the seller to use manual
 * status updates instead, rather than silently creating a "manual"
 * shipment row on a booking attempt (that would hide a real configuration
 * problem behind what looks like success).
 *
 * isVerified IS required to be true here (as of Phase 7) -- mirrors
 * hasVerifiedPaymentConfig's exact shape in sellerListings.ts: check for
 * isVerified === true specifically, not row existence. The admin
 * verify-toggle at PUT /admin/seller-courier-configs/:id/verify already
 * exists and is the only place isVerified is ever set true, same as
 * payment configs, so this is not a dead end -- an admin marks the config
 * verified once, same manual-review convention already in place for
 * payment configs. Previously this check didn't exist at all (see prior
 * comment, now stale); that gap is closed.
 */
router.post("/seller/orders/:orderId/book-courier", requireSeller, async (req: any, res) => {
  try {
    const orderId = parseInt(req.params.orderId);
    if (isNaN(orderId) || orderId <= 0) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }

    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    if (order.sellerId !== req.dbSeller!.id) {
      res.status(403).json({ error: "You don't own this order" });
      return;
    }

    const [existingShipment] = await db
      .select()
      .from(orderShipmentsTable)
      .where(eq(orderShipmentsTable.orderId, orderId))
      .limit(1);
    if (existingShipment && existingShipment.courierTrackingId) {
      res.status(400).json({ error: "This order already has a courier booking", shipment: formatShipment(existingShipment) });
      return;
    }

    const [config] = await db
      .select()
      .from(sellerCourierConfigsTable)
      .where(eq(sellerCourierConfigsTable.sellerId, req.dbSeller!.id))
      .limit(1);
    if (!config) {
      res.status(400).json({
        error: "No courier account configured. Add your Pathao or Steadfast credentials in Courier Settings, or use manual status updates for this order.",
      });
      return;
    }
    if (!config.isVerified) {
      res.status(400).json({
        error: "Your courier account hasn't been verified yet. An admin needs to verify your Courier Settings before you can book through Pathao/Steadfast — use manual status updates for this order in the meantime.",
      });
      return;
    }

    const adapter = getCourierAdapter(config.provider);
    if (!adapter) {
      res.status(400).json({ error: `Unsupported courier provider "${config.provider}"` });
      return;
    }

    const seller = req.dbSeller!;
    const shippingAddress = order.shippingAddress as {
      fullName?: string;
      phone?: string;
      street?: string;
      city?: string;
      district?: string;
    };
    if (!shippingAddress?.fullName || !shippingAddress?.phone || !shippingAddress?.street) {
      res.status(400).json({ error: "Order is missing a complete shipping address" });
      return;
    }

    const items = order.items as OrderItem[];
    const itemDescription = items.map((i) => `${i.productName} x${i.quantity}`).join(", ").slice(0, 250);
    const codAmount = order.paymentMethod === "cod" ? Number(order.totalAmount) : 0;

    let bookingResult;
    try {
      bookingResult = await adapter.bookShipment({
        credentials: {
          apiKey: decryptCredential(config.apiKey),
          apiSecret: decryptCredential(config.apiSecret),
          storeId: config.storeId,
        },
        merchantOrderId: order.trackingId,
        senderName: seller.ownerName || seller.businessName,
        senderPhone: seller.contactPhone,
        recipientName: shippingAddress.fullName,
        recipientPhone: shippingAddress.phone,
        recipientAddress: `${shippingAddress.street}, ${shippingAddress.city ?? ""}`,
        recipientCity: shippingAddress.city ?? shippingAddress.district ?? "",
        codAmount,
        itemDescription: itemDescription || "Plant order",
        itemQuantity: items.reduce((s, i) => s + i.quantity, 0),
        itemWeightKg: estimateWeightKg(items),
      });
    } catch (err) {
      const message = err instanceof CourierBookingError ? err.message : "Courier booking failed";
      console.error("Courier booking error:", err instanceof CourierBookingError ? { message: err.message, provider: err.provider, raw: err.raw } : err);
      res.status(502).json({ error: message });
      return;
    }

    let shipment;
    if (existingShipment) {
      [shipment] = await db
        .update(orderShipmentsTable)
        .set({
          courierProvider: config.provider,
          courierTrackingId: bookingResult.courierTrackingId,
          status: bookingResult.status,
          lastSyncedAt: new Date(),
          rawWebhookPayload: bookingResult.raw as any,
        })
        .where(eq(orderShipmentsTable.id, existingShipment.id))
        .returning();
    } else {
      [shipment] = await db
        .insert(orderShipmentsTable)
        .values({
          orderId,
          courierProvider: config.provider,
          courierTrackingId: bookingResult.courierTrackingId,
          status: bookingResult.status,
          lastSyncedAt: new Date(),
          rawWebhookPayload: bookingResult.raw as any,
        })
        .returning();
    }

    res.status(201).json(formatShipment(shipment));
  } catch (err) {
    console.error("Book courier error:", err);
    res.status(500).json({ error: "Failed to book courier" });
  }
});

/**
 * Seller: manual status update (plan doc §8's "no verified courier config
 * ... seller updates status manually via dropdown"). Also usable for
 * sellers WITH a courier config, in case a status needs manual correction --
 * the plan doc doesn't say manual updates are exclusive to manual-only
 * sellers, just that manual-only sellers have no other option.
 */
router.put("/seller/orders/:orderId/shipment-status", requireSeller, async (req: any, res) => {
  try {
    const orderId = parseInt(req.params.orderId);
    if (isNaN(orderId) || orderId <= 0) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const { status } = req.body as { status?: string };
    if (!status || !MANUAL_STATUSES.includes(status as any)) {
      res.status(400).json({ error: `status must be one of: ${MANUAL_STATUSES.join(", ")}` });
      return;
    }

    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    if (order.sellerId !== req.dbSeller!.id) {
      res.status(403).json({ error: "You don't own this order" });
      return;
    }

    const [existing] = await db
      .select()
      .from(orderShipmentsTable)
      .where(eq(orderShipmentsTable.orderId, orderId))
      .limit(1);

    let shipment;
    if (existing) {
      [shipment] = await db
        .update(orderShipmentsTable)
        .set({ status, lastSyncedAt: new Date() })
        .where(eq(orderShipmentsTable.id, existing.id))
        .returning();
    } else {
      [shipment] = await db
        .insert(orderShipmentsTable)
        .values({ orderId, courierProvider: "manual", courierTrackingId: null, status, lastSyncedAt: new Date() })
        .returning();
    }

    res.json(formatShipment(shipment));
  } catch (err) {
    console.error("Update shipment status error:", err);
    res.status(500).json({ error: "Failed to update shipment status" });
  }
});

/**
 * Buyer-facing: read shipment status for an order they own. Deliberately
 * separate from GET /orders/:id (orders.ts) rather than embedding shipment
 * in that response, since not every order has a shipment yet and orders.ts
 * is Part 3 scope this session shouldn't be reshaping.
 */
router.get("/orders/:orderId/shipment", requireAuth, async (req: any, res) => {
  try {
    const orderId = parseInt(req.params.orderId);
    if (isNaN(orderId) || orderId <= 0) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const [order] = await db
      .select()
      .from(ordersTable)
      .where(and(eq(ordersTable.id, orderId), eq(ordersTable.userId, req.userId)))
      .limit(1);
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    const [shipment] = await db
      .select()
      .from(orderShipmentsTable)
      .where(eq(orderShipmentsTable.orderId, orderId))
      .limit(1);
    res.json(shipment ? formatShipment(shipment) : null);
  } catch (err) {
    console.error("Get buyer shipment error:", err);
    res.status(500).json({ error: "Failed to fetch shipment" });
  }
});

export default router;
