import { Router } from "express";
import { db } from "@workspace/db";
import { preOrdersTable, productsTable, sellerListingVariantsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();

function generateTrackingId() {
  return "PRE-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).substring(2, 6).toUpperCase();
}

/**
 * Phase 2: pre-order now requires a sellerListingVariantId against
 * sellerListingVariantsTable, not a variantId against productVariantsTable
 * -- pre-order is a per-variant flag on a marketplace seller's listing
 * variant (isPreOrder), not a concept admin's productVariantsTable
 * participates in at all. Requires that specific variant's isPreOrder flag
 * to be true, rather than assuming any variant can be pre-ordered (the old
 * code had no such check -- any admin variant could be "pre-ordered"
 * regardless of the parent product's productStatus field being the only
 * gate). basePrice/deliveryCharge are pulled from the seller listing
 * variant, the same way routes/orders.ts now resolves marketplace lines.
 */
router.post("/pre-orders", requireAuth, async (req, res) => {
  try {
    const { productId, sellerListingVariantId, quantity = 1, shippingAddress, paymentMethod, senderNumber, transactionId, whatsappPhone } = req.body;
    if (!productId || !shippingAddress) { res.status(400).json({ error: "Product and shipping address are required" }); return; }
    if (!sellerListingVariantId) { res.status(400).json({ error: "Please select an option (e.g. Seed, Sapling, Grafted, Potted) before pre-ordering" }); return; }

    const [product] = await db.select().from(productsTable).where(eq(productsTable.id, Number(productId))).limit(1);
    if (!product) { res.status(404).json({ error: "Product not found" }); return; }

    const [variant] = await db
      .select()
      .from(sellerListingVariantsTable)
      .where(eq(sellerListingVariantsTable.id, Number(sellerListingVariantId)))
      .limit(1);
    if (!variant) { res.status(404).json({ error: "Listing variant not found" }); return; }
    if (!variant.isPreOrder) {
      res.status(400).json({ error: "This option is not currently available for pre-order" });
      return;
    }

    const basePrice = Number(variant.discountPrice ?? variant.price);
    const discountedPrice = Math.round(basePrice * 0.95 * 100) / 100;
    const deliveryCharge = Number(variant.deliveryCharge);
    const trackingId = generateTrackingId();
    await db.insert(preOrdersTable).values({
      trackingId,
      userId: req.userId!,
      productId: Number(productId),
      productName: product.name,
      productImage: ((product.images as string[]) ?? [])[0] ?? "",
      quantity: Number(quantity),
      productPrice: String(basePrice),
      discountedPrice: String(discountedPrice),
      deliveryCharge: String(deliveryCharge),
      whatsappPhone: whatsappPhone ?? null,
      shippingAddress,
      paymentMethod: paymentMethod ?? "bkash",
      senderNumber: senderNumber ?? null,
      transactionId: transactionId ?? null,
      paymentStatus: paymentMethod === "cod" ? "pending" : "pending_verification",
      status: "pending",
    });
    res.status(201).json({ message: "Pre-order placed!", trackingId, deliveryCharge, discountedPrice });
  } catch (err) {
    console.error("[pre-order] Failed:", err);
    res.status(500).json({ error: "Failed to place pre-order" });
  }
});

router.get("/pre-orders", async (req, res) => {
  try {
    const orders = await db.select().from(preOrdersTable).orderBy(preOrdersTable.createdAt);
    res.json(orders);
  } catch { res.status(500).json({ error: "Failed to fetch pre-orders" }); }
});

router.get("/pre-orders/track/:trackingId", async (req, res) => {
  try {
    const { trackingId } = req.params;
    const [order] = await db.select().from(preOrdersTable).where(eq(preOrdersTable.trackingId, trackingId)).limit(1);
    if (!order) { res.status(404).json({ error: "Not found" }); return; }
    res.json(order);
  } catch { res.status(500).json({ error: "Failed" }); }
});

router.get("/pre-orders/my", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const orders = await db.select().from(preOrdersTable).where(eq(preOrdersTable.userId, userId));
    res.json(orders);
  } catch { res.status(500).json({ error: "Failed" }); }
});

router.post("/pre-orders/:id/status", async (req, res) => {
  try {
    const { status, cancellationReason } = req.body;
    const [current] = await db.select().from(preOrdersTable).where(eq(preOrdersTable.id, Number(req.params.id))).limit(1);
    if (!current) { res.status(404).json({ error: "Not found" }); return; }
    if (current.status === "delivered" || current.status === "cancelled") {
      res.status(400).json({ error: "Cannot change status of delivered or cancelled pre-orders" }); return;
    }
    const updateData: any = { status, updatedAt: new Date() };
    if (status === "cancelled" && cancellationReason) updateData.cancellationReason = cancellationReason;
    const [order] = await db.update(preOrdersTable).set(updateData).where(eq(preOrdersTable.id, Number(req.params.id))).returning();
    res.json(order);
  } catch { res.status(500).json({ error: "Failed" }); }
});

/**
 * NOTE (Phase 2, unrelated to the variant migration): notifyPreOrderCustomers
 * is still keyed by admin productId + productStatus flip (products.ts calls
 * this when productStatus goes pre_order -> in_stock). This is now
 * INCONSISTENT with the pre-order creation flow above, which is
 * variant-based and has nothing to do with productsTable.productStatus --
 * admin no longer owns any price/stock data, so "admin flips productStatus
 * to in_stock" no longer has a clear relationship to "a specific seller
 * listing variant's isPreOrder flag/stock became available". This function
 * is left AS-IS this phase (not in the files-to-change list, and changing
 * its trigger condition/semantics is a product decision, not a mechanical
 * variant-shape update) -- flagging as a real gap for a future phase to
 * resolve, not fixing here.
 */
export async function notifyPreOrderCustomers(productId: number, productName: string) {
  try {
    const orders = await db.select().from(preOrdersTable).where(and(eq(preOrdersTable.productId, productId), eq(preOrdersTable.status, "pending")));
    console.log(`[pre-order] Notifying ${orders.length} customers`);
    for (const order of orders) {
      if (order.whatsappPhone) {
        const phone = order.whatsappPhone.replace(/[^+\d]/g, "");
        const to = phone.startsWith("+") ? phone : `+88${phone}`;
        const siteUrl = process.env.VITE_SITE_URL ?? "https://fixed5.vercel.app";
        try {
          const twilio = await import("twilio");
          const client = twilio.default(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await client.messages.create({
            from: process.env.TWILIO_WHATSAPP_FROM ?? "whatsapp:+14155238886",
            to: `whatsapp:${to}`,
            body: `🌸 *Tree Friend*\n\nGreat news! Your pre-ordered *${productName}* has arrived and is now being shipped to you! 🚚\n\nExpected delivery: 2-3 days.\n\nTrack: ${siteUrl}/track\n\nThank you for your patience! 💕`,
          });
        } catch (err: any) { console.error(`[pre-order] WhatsApp failed:`, err?.message); }
      }
      await db.update(preOrdersTable).set({ status: "shipped", notifiedAt: new Date(), updatedAt: new Date() }).where(eq(preOrdersTable.id, order.id));
    }
  } catch (err) { console.error("[pre-order] notify failed:", err); }
}

export default router;
