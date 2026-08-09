import { Router } from "express";
import type { z } from "zod";
import { db } from "@workspace/db";
import { preOrdersTable, productsTable, sellerListingVariantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { validateBody, validateParams } from "../lib/validateRequest";
import { asyncHandler, HttpError } from "../lib/errors";
import { IdParam, CreatePreOrderBody, UpdatePreOrderStatusBody } from "../lib/schemas";
import type { ApiRequest } from "../types/apiRequest";

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
router.post(
  "/pre-orders",
  requireAuth,
  validateBody(CreatePreOrderBody, "CreatePreOrderBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof CreatePreOrderBody>>, res) => {
    const {
      productId,
      sellerListingVariantId,
      quantity,
      shippingAddress,
      paymentMethod,
      senderNumber,
      transactionId,
      whatsappPhone,
    } = req.body;

    const [product] = await db.select().from(productsTable).where(eq(productsTable.id, productId)).limit(1);
    if (!product) throw new HttpError(404, "Product not found");

    const [variant] = await db
      .select()
      .from(sellerListingVariantsTable)
      .where(eq(sellerListingVariantsTable.id, sellerListingVariantId))
      .limit(1);
    if (!variant) throw new HttpError(404, "Listing variant not found");
    if (!variant.isPreOrder) {
      throw new HttpError(400, "This option is not currently available for pre-order");
    }

    const basePrice = Number(variant.discountPrice ?? variant.price);
    const discountedPrice = Math.round(basePrice * 0.95 * 100) / 100;
    const deliveryCharge = Number(variant.deliveryCharge);
    const trackingId = generateTrackingId();
    await db.insert(preOrdersTable).values({
      trackingId,
      userId: req.userId!,
      productId,
      productName: product.name,
      productImage: ((product.images as string[]) ?? [])[0] ?? "",
      sellerListingVariantId,
      quantity,
      productPrice: String(basePrice),
      discountedPrice: String(discountedPrice),
      deliveryCharge: String(deliveryCharge),
      whatsappPhone: whatsappPhone ?? null,
      shippingAddress,
      paymentMethod,
      senderNumber: senderNumber ?? null,
      transactionId: transactionId ?? null,
      paymentStatus: paymentMethod === "cod" ? "pending" : "pending_verification",
      status: "pending",
    });
    res.status(201).json({ message: "Pre-order placed!", trackingId, deliveryCharge, discountedPrice });
  }),
);

// NOTE: a public GET /pre-orders endpoint (no auth, listed every pre-order
// in the system) used to live here. It was removed because:
//   - The admin frontend now uses GET /admin/pre-orders (added in admin.ts),
//     which is requireAdmin-gated AND joins sellers through
//     preOrders.sellerListingVariantId -> variant -> listing -> seller.
//   - The buyer-facing pages use /pre-orders/track/:trackingId (one specific
//     pre-order by tracking id) and /pre-orders/my (the authenticated user's
//     own pre-orders) -- never the all-pre-orders list endpoint.
//   - Allowing anyone on the internet to fetch the full pre-orders table
//     (no auth) was a customer-PII leak: shippingAddress + whatsappPhone +
//     senderNumber + transactionId for every pre-order ever placed.
// No frontend caller was using it (verified by grepping every .ts/.tsx file
// in the repo before removal). If a future caller needs an
// all-pre-orders list, add a requireAdmin-gated route in admin.ts, not
// here.

router.get(
  "/pre-orders/track/:trackingId",
  asyncHandler(async (req, res) => {
    const { trackingId } = req.params;
    const [order] = await db.select().from(preOrdersTable).where(eq(preOrdersTable.trackingId, trackingId)).limit(1);
    if (!order) throw new HttpError(404, "Not found");
    res.json(order);
  }),
);

router.get(
  "/pre-orders/my",
  requireAuth,
  asyncHandler(async (req: ApiRequest, res) => {
    const userId = req.userId!;
    const orders = await db.select().from(preOrdersTable).where(eq(preOrdersTable.userId, userId));
    res.json(orders);
  }),
);

/**
 * Update a pre-order's status (pending → confirmed → arrived_in_bd →
 * shipped → delivered, or → cancelled). Admin-only — this is a
 * fulfillment-state mutation, not a buyer-facing action.
 *
 * SECURITY: requireAdmin-gated. Previously this route had NO auth
 * middleware at all, which meant anyone on the internet could change
 * any pre-order's status to any value (delivered, cancelled, etc.) by
 * guessing or enumerating the numeric id. The same file's POST
 * /pre-orders route correctly used requireAuth, so this was an
 * inconsistency — likely an oversight, not a deliberate public
 * endpoint. Fixed by adding requireAdmin, matching every other
 * status-mutation route in admin.ts.
 */
router.post(
  "/pre-orders/:id/status",
  requireAdmin,
  validateParams(IdParam, "IdParam"),
  validateBody(UpdatePreOrderStatusBody, "UpdatePreOrderStatusBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof UpdatePreOrderStatusBody>, z.infer<typeof IdParam>>, res) => {
    const { id } = req.params;
    const { status, cancellationReason } = req.body;

    const [current] = await db.select().from(preOrdersTable).where(eq(preOrdersTable.id, id)).limit(1);
    if (!current) throw new HttpError(404, "Not found");
    if (current.status === "delivered" || current.status === "cancelled") {
      throw new HttpError(400, "Cannot change status of delivered or cancelled pre-orders");
    }

    const updateData: Partial<typeof preOrdersTable.$inferInsert> = {
      status,
      updatedAt: new Date(),
    };
    if (status === "cancelled" && cancellationReason) {
      updateData.cancellationReason = cancellationReason;
    }
    const [order] = await db
      .update(preOrdersTable)
      .set(updateData)
      .where(eq(preOrdersTable.id, id))
      .returning();
    res.json(order);
  }),
);

// `notifyPreOrderCustomers` was extracted to lib/preOrders.ts so it can be
// reused by routes/products.ts and routes/sellerListings.ts without coupling
// those route files to this one. Re-exported here for backward compat with
// any caller that still imports from "./preOrders".
export { notifyPreOrderCustomers } from "../lib/preOrders";

export default router;
