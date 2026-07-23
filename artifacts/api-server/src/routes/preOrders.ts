import { Router } from "express";
import { db } from "@workspace/db";
import { preOrdersTable, productsTable, sellerListingVariantsTable } from "@workspace/db";
import { eq, and, or, isNull } from "drizzle-orm";
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
      sellerListingVariantId: Number(sellerListingVariantId),
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
 * RESOLVED (Phase 5): the trigger inconsistency flagged in this comment
 * since Phase 2 is fixed. productsTable.productStatus is no longer
 * admin-settable (see products.ts's PATCH route) and no longer drives this
 * function -- the old pre_order -> in_stock trigger there was removed
 * entirely. The real trigger now lives in sellerListings.ts's PUT handler:
 * it fires when a seller edit transitions a variant out of "pending
 * pre-order" (isPreOrder=true, availableQuantity=0), either by turning
 * isPreOrder off or by making stock available.
 *
 * RESOLVED (Phase 6): the over-notification gap flagged below since Phase 5
 * is fixed for any row that has a sellerListingVariantId (every row created
 * from this point forward, since POST /pre-orders now persists it -- see
 * that route). This function takes the specific variant id that
 * transitioned and, when present, scopes the notify query to
 * (productId AND sellerListingVariantId) instead of productId alone -- a
 * customer who pre-ordered seller A's variant will no longer be notified
 * when only seller B's unrelated variant becomes available.
 *
 * Legacy rows created before the Phase 6 migration have
 * sellerListingVariantId = null and cannot be scoped this precisely (the
 * data was never captured) -- those rows still match under the old,
 * broader "any pending pre-order on this product" condition, via the `OR
 * sellerListingVariantId IS NULL` branch below. This is intentional
 * backward-compatible behavior, not a bug: a legacy row has no way to know
 * which variant it was really for, so still notifying it under the old
 * product-wide rule is strictly better than never notifying it again.
 *
 * Residual imprecision, deliberately accepted: a legacy (null-variant) row
 * can still be notified more than once if a product has multiple variants
 * that each transition out of pending-pre-order separately (once per
 * transitioned variant, since each gets its own call from
 * sellerListings.ts). This is a strictly smaller version of the original
 * over-notification gap -- new (non-null) rows are now scoped exactly, and
 * legacy rows are notified at most as often as variants transition, not
 * notified about every seller's unrelated variant on every stock change
 * project-wide. A future phase could de-dupe consecutive notifies to the
 * same legacy row if this turns out to matter in practice; not done here
 * since it's a minor UX nuisance, not a correctness bug, and this phase's
 * scope is the specific over-notification case named in PHASE6_PROMPT.md.
 */
export async function notifyPreOrderCustomers(productId: number, productName: string, sellerListingVariantId?: number) {
  try {
    const scope = sellerListingVariantId != null
      ? and(
          eq(preOrdersTable.productId, productId),
          eq(preOrdersTable.status, "pending"),
          or(
            eq(preOrdersTable.sellerListingVariantId, sellerListingVariantId),
            isNull(preOrdersTable.sellerListingVariantId),
          ),
        )
      : and(eq(preOrdersTable.productId, productId), eq(preOrdersTable.status, "pending"));

    const orders = await db.select().from(preOrdersTable).where(scope);
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
