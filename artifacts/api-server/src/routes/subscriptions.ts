// artifacts/api-server/src/routes/subscriptions.ts
import { Router } from "express";
import type { z } from "zod";
import { db } from "@workspace/db";
import {
  subscriptionsTable,
  productsTable,
  productVariantsTable,
} from "@workspace/db";
import type { SubscriptionItem, SubscriptionAddress } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { validateBody } from "../lib/validateRequest";
import { asyncHandler, HttpError } from "../lib/errors";
import type { ApiRequest } from "../types/apiRequest";
import {
  CreateSubscriptionBody,
  UpdateSubscriptionBody,
} from "../lib/schemas";

const router = Router();

const FREQUENCY_DAYS: Record<string, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

function nextOrderDate(frequency: string): Date {
  const days = FREQUENCY_DAYS[frequency] ?? 30;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

function formatSub(s: typeof subscriptionsTable.$inferSelect) {
  return {
    id: s.id,
    userId: s.userId,
    status: s.status,
    frequency: s.frequency,
    items: s.items as SubscriptionItem[],
    shippingAddress: s.shippingAddress as SubscriptionAddress,
    totalAmount: Number(s.totalAmount),
    discountPercent: s.discountPercent,
    nextOrderDate: s.nextOrderDate.toISOString(),
    lastOrderDate: s.lastOrderDate?.toISOString() ?? null,
    orderCount: s.orderCount,
    paymentMethod: s.paymentMethod,
    notes: s.notes,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/**
 * Resolve product info (name, image, price) from the DB for a list of
 * productIds. Returns a Map keyed by productId for O(1) lookup during
 * subscription creation.
 *
 * SECURITY: This is the price-manipulation fix (H-1 in the security audit).
 * Previously the route trusted `i.price` from the request body. Now the
 * server looks up the actual price from `productVariantsTable` (cheapest
 * variant per product — the "starting from" price) and uses THAT.
 *
 * Returns the items to store on the subscription, including the
 * server-resolved price + product metadata (name, image) so future price
 * changes don't break active subscriptions.
 *
 * Throws HttpError(404) if any requested product doesn't exist.
 */
async function resolveSubscriptionItems(
  items: { productId: number; quantity: number }[],
): Promise<SubscriptionItem[]> {
  const productIds = items.map((i) => i.productId);

  // Single batched query: fetch all requested products + their cheapest
  // variant (the "starting from" price). Uses `inArray` to avoid N+1.
  const productRows = await db
    .select({
      id: productsTable.id,
      name: productsTable.name,
      images: productsTable.images,
      deletedAt: productsTable.deletedAt,
    })
    .from(productsTable)
    .where(inArray(productsTable.id, productIds));

  // Verify every requested product exists and isn't soft-deleted.
  const productMap = new Map(productRows.map((p) => [p.id, p]));
  for (const item of items) {
    const p = productMap.get(item.productId);
    if (!p) {
      throw new HttpError(404, `Product ${item.productId} not found`);
    }
    if (p.deletedAt) {
      throw new HttpError(404, `Product ${item.productId} is no longer available`);
    }
  }

  // Fetch the lowest-priced variant per product in one batched query.
  const variantRows = await db
    .select({
      productId: productVariantsTable.productId,
      price: productVariantsTable.price,
      discountPrice: productVariantsTable.discountPrice,
    })
    .from(productVariantsTable)
    .where(inArray(productVariantsTable.productId, productIds));

  // Pick the cheapest variant per product, honoring discountPrice when set.
  const cheapestPriceByProduct = new Map<number, number>();
  for (const v of variantRows) {
    const effective = v.discountPrice
      ? Math.min(Number(v.price), Number(v.discountPrice))
      : Number(v.price);
    const prev = cheapestPriceByProduct.get(v.productId);
    if (prev === undefined || effective < prev) {
      cheapestPriceByProduct.set(v.productId, effective);
    }
  }

  // Compose the subscription items with server-resolved prices.
  return items.map((i) => {
    const p = productMap.get(i.productId)!;
    const price = cheapestPriceByProduct.get(i.productId);
    if (price === undefined) {
      // Product exists but has no variants → not sellable.
      throw new HttpError(
        422,
        `Product "${p.name}" is not available for purchase (no pricing configured)`,
      );
    }
    return {
      productId: i.productId,
      productName: p.name,
      productImage: (p.images?.[0] as string | undefined) ?? "",
      quantity: i.quantity,
      price,
    } satisfies SubscriptionItem;
  });
}

// GET /subscriptions — list user's subscriptions
router.get(
  "/subscriptions",
  requireAuth,
  asyncHandler(async (req: ApiRequest, res) => {
    const subs = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, req.userId!));
    res.json(subs.map(formatSub));
  }),
);

// GET /subscriptions/:id — single subscription
router.get(
  "/subscriptions/:id",
  requireAuth,
  asyncHandler(async (req: ApiRequest, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) throw new HttpError(400, "Invalid subscription id");

    const [sub] = await db
      .select()
      .from(subscriptionsTable)
      .where(and(eq(subscriptionsTable.id, id), eq(subscriptionsTable.userId, req.userId!)))
      .limit(1);
    if (!sub) throw new HttpError(404, "Subscription not found");
    res.json(formatSub(sub));
  }),
);

// POST /subscriptions — create a new subscription
//
// SECURITY FIX (H-1): The route no longer accepts `items[].price` from the
// client. The server resolves the actual price from the DB by looking up
// each product's cheapest variant. See `resolveSubscriptionItems` above.
router.post(
  "/subscriptions",
  requireAuth,
  validateBody(CreateSubscriptionBody, "CreateSubscriptionBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof CreateSubscriptionBody>>, res) => {
    const { items, frequency, shippingAddress, paymentMethod, notes } = req.body;

    // Resolve real prices from DB (throws HttpError on invalid products).
    const resolvedItems = await resolveSubscriptionItems(items);

    const DISCOUNT = 10;
    const totalAmount = resolvedItems.reduce(
      (sum, i) => sum + i.price * (1 - DISCOUNT / 100) * i.quantity,
      0,
    );

    const [sub] = await db
      .insert(subscriptionsTable)
      .values({
        userId: req.userId!,
        status: "active",
        frequency,
        items: resolvedItems,
        shippingAddress,
        totalAmount: totalAmount.toFixed(2),
        discountPercent: DISCOUNT,
        nextOrderDate: nextOrderDate(frequency),
        paymentMethod,
        notes: notes ?? null,
      })
      .returning();

    res.status(201).json(formatSub(sub));
  }),
);

// PATCH /subscriptions/:id — pause, resume, cancel, or update frequency
router.patch(
  "/subscriptions/:id",
  requireAuth,
  validateBody(UpdateSubscriptionBody, "UpdateSubscriptionBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof UpdateSubscriptionBody>>, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) throw new HttpError(400, "Invalid subscription id");

    const { status, frequency, shippingAddress, notes } = req.body;

    const [sub] = await db
      .select()
      .from(subscriptionsTable)
      .where(and(eq(subscriptionsTable.id, id), eq(subscriptionsTable.userId, req.userId!)))
      .limit(1);

    if (!sub) throw new HttpError(404, "Subscription not found");
    if (sub.status === "cancelled") {
      throw new HttpError(400, "Cannot modify a cancelled subscription");
    }

    const updates: Partial<typeof subscriptionsTable.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (status) updates.status = status;
    if (frequency) {
      updates.frequency = frequency;
      updates.nextOrderDate = nextOrderDate(frequency);
    }
    if (shippingAddress) updates.shippingAddress = shippingAddress;
    if (notes !== undefined) updates.notes = notes;

    const [updated] = await db
      .update(subscriptionsTable)
      .set(updates)
      .where(eq(subscriptionsTable.id, id))
      .returning();

    res.json(formatSub(updated));
  }),
);

// DELETE /subscriptions/:id — hard cancel
router.delete(
  "/subscriptions/:id",
  requireAuth,
  asyncHandler(async (req: ApiRequest, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) throw new HttpError(400, "Invalid subscription id");

    const [sub] = await db
      .select()
      .from(subscriptionsTable)
      .where(and(eq(subscriptionsTable.id, id), eq(subscriptionsTable.userId, req.userId!)))
      .limit(1);
    if (!sub) throw new HttpError(404, "Subscription not found");

    await db
      .update(subscriptionsTable)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(subscriptionsTable.id, id));

    res.json({ message: "Subscription cancelled" });
  }),
);

// Admin: list all subscriptions
router.get(
  "/admin/subscriptions",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const subs = await db.select().from(subscriptionsTable);
    res.json(subs.map(formatSub));
  }),
);

export default router;
