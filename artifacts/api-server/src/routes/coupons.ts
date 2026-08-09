import { asyncHandler, HttpError, isPgError, PG_ERROR_CODE } from "../lib/errors";
import { Router } from "express";
import { db } from "@workspace/db";
import { couponsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAdmin, requireSeller } from "../middlewares/auth";
import { logAudit } from "../lib/audit";
import { validateCoupon } from "../lib/coupons";
import { ValidateCouponBody, CreateCouponBody } from "@workspace/api-zod";
import { validateBody } from "../lib/validateRequest";
import type { ApiRequest } from "../types/apiRequest";
import type { z } from "zod";

const router = Router();

function formatCoupon(c: typeof couponsTable.$inferSelect) {
  return {
    id: c.id,
    code: c.code,
    discountType: c.discountType,
    discountValue: Number(c.discountValue),
    minOrderAmount: c.minOrderAmount != null ? Number(c.minOrderAmount) : null,
    expiryDate: c.expiryDate ? c.expiryDate.toISOString() : null,
    isActive: c.isActive,
    sellerId: c.sellerId ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

const VALID_DISCOUNT_TYPES = ["percentage", "fixed"];

router.post(
  "/coupons/validate",
  validateBody(ValidateCouponBody, "ValidateCouponBody"),
  asyncHandler(async (req, res) => {
    const { code, orderAmount, sellerIds } = req.body;
    // validateCoupon throws HttpError on validation failure (400/404) —
    // the global error handler converts it to the right JSON response.
    // sellerIds comes in as unknown[] from the Zod schema; coerce to number[].
    const sellerIdsAsNumbers = Array.isArray(sellerIds)
      ? sellerIds.map((id: unknown) => Number(id)).filter((n) => !isNaN(n))
      : undefined;
    const coupon = await validateCoupon(code, Number(orderAmount), sellerIdsAsNumbers);
    // Re-fetch the full row so formatCoupon can include createdAt, isActive, etc.
    const [fullCoupon] = await db
      .select()
      .from(couponsTable)
      .where(eq(couponsTable.id, coupon.id))
      .limit(1);
    if (!fullCoupon) throw new HttpError(404, "Coupon not found");
    res.json(formatCoupon(fullCoupon));
  }),
);

router.get("/coupons", requireAdmin, asyncHandler(async (_req, res) => {
  const coupons = await db
    .select()
    .from(couponsTable)
    .orderBy(couponsTable.createdAt);
  res.json(coupons.map(formatCoupon));
}));

router.post("/coupons", requireAdmin, validateBody(CreateCouponBody, "CreateCouponBody"), async (req: ApiRequest<z.infer<typeof CreateCouponBody>>, res) => {
  try {
    // P0-1: body shape now validated by Zod (CreateCouponBody). The
    // hand-rolled code/discountType/discountValue checks below are kept
    // as business rules — Zod validates the SHAPE (string/number types),
    // these enforce the SEMANTICS (non-empty code, valid discount type
    // enum, positive value, percentage <= 100) the schema can't express.
    const { code, discountType, discountValue, minOrderAmount, expiryDate } =
      req.body as Partial<z.infer<typeof CreateCouponBody>>;

    if (!code || code.trim().length === 0) {
      res.status(400).json({ error: "Coupon code is required" });
      return;
    }
    if (!discountType || !discountType || !VALID_DISCOUNT_TYPES.includes(discountType)) {
      res.status(400).json({ error: "Discount type must be 'percentage' or 'fixed'" });
      return;
    }
    const discountNum = Number(discountValue);
    if (isNaN(discountNum) || discountNum <= 0) {
      res.status(400).json({ error: "Discount value must be a positive number" });
      return;
    }
    if (discountType === "percentage" && discountNum > 100) {
      res.status(400).json({ error: "Percentage discount cannot exceed 100%" });
      return;
    }

    const sanitizedCode = code.toUpperCase().trim().replace(/\s+/g, "");

    const [coupon] = await db
      .insert(couponsTable)
      .values({
        code: sanitizedCode,
        discountType,
        discountValue: String(discountValue),
        minOrderAmount:
          minOrderAmount != null
            ? String(minOrderAmount)
            : null,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
      })
      .returning();
    res.status(201).json(formatCoupon(coupon));
  } catch (err) {
    // Handle unique constraint violation on coupon code
    if (isPgError(err) && err.code === PG_ERROR_CODE.UNIQUE_VIOLATION) {
      res.status(409).json({ error: "A coupon with this code already exists" });
      return;
    }
    res.status(500).json({ error: "Failed to create coupon" });
  }
});

router.put("/coupons/:id", requireAdmin, asyncHandler(async (req: ApiRequest, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid coupon ID" });
    return;
  }
  const { code, discountType, discountValue, minOrderAmount, expiryDate } =
    req.body as Partial<z.infer<typeof CreateCouponBody>>;

  if (discountType && !discountType || !discountType || !VALID_DISCOUNT_TYPES.includes(discountType)) {
    res.status(400).json({ error: "Invalid discount type" });
    return;
  }

  const [coupon] = await db
    .update(couponsTable)
    .set({
      code: code?.toUpperCase().trim(),
      discountType,
      discountValue: String(discountValue),
      minOrderAmount:
        minOrderAmount != null
          ? String(minOrderAmount)
          : null,
      expiryDate: expiryDate ? new Date(expiryDate) : null,
    })
    .where(eq(couponsTable.id, id))
    .returning();

  if (!coupon) {
    res.status(404).json({ error: "Coupon not found" });
    return;
  }
  res.json(formatCoupon(coupon));
}));

router.patch("/coupons/:id/toggle", requireAdmin, asyncHandler(async (req: ApiRequest, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid coupon ID" });
    return;
  }
  const [existing] = await db
    .select()
    .from(couponsTable)
    .where(eq(couponsTable.id, id))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Coupon not found" });
    return;
  }

  const [coupon] = await db
    .update(couponsTable)
    .set({ isActive: !existing.isActive })
    .where(eq(couponsTable.id, id))
    .returning();
  res.json(formatCoupon(coupon));
}));

router.delete("/coupons/:id", requireAdmin, asyncHandler(async (req: ApiRequest, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid coupon ID" });
    return;
  }
  await db.delete(couponsTable).where(eq(couponsTable.id, id));
  res.json({ message: "Coupon deleted" });
}));

// ══════════════════════════════════════════════════════════════════════════
//  Seller-scoped coupon routes
//
//  These power the "Coupons" tab in the seller dashboard (coupons were
//  shifted out of the admin panel and into the seller dashboard so each
//  seller can manage their own discount codes). All routes require an
//  active seller account (requireSeller) and scope every read/write to
//  req.dbSeller!.id -- a seller can only ever see / edit / delete coupons
//  where coupons.seller_id === their own seller id.
//
//  Platform-wide coupons (seller_id IS NULL, e.g. welcome codes generated
//  by the referral system) are NOT visible through these routes -- they
//  remain managed by the system / admin API.
// ══════════════════════════════════════════════════════════════════════════

router.get("/sellers/me/coupons", requireSeller, asyncHandler(async (req: ApiRequest, res) => {
  const sellerId = req.dbSeller!.id;
  const coupons = await db
    .select()
    .from(couponsTable)
    .where(eq(couponsTable.sellerId, sellerId))
    .orderBy(couponsTable.createdAt);
  res.json(coupons.map(formatCoupon));
}));

router.post("/sellers/me/coupons", requireSeller, async (req: ApiRequest, res) => {
  try {
    const sellerId = req.dbSeller!.id;
    const { code, discountType, discountValue, minOrderAmount, expiryDate } =
      req.body as Partial<z.infer<typeof CreateCouponBody>>;

    if (!code || typeof code !== "string" || code.trim().length === 0) {
      res.status(400).json({ error: "Coupon code is required" });
      return;
    }
    if (!discountType || !discountType || !VALID_DISCOUNT_TYPES.includes(discountType)) {
      res.status(400).json({ error: "Discount type must be 'percentage' or 'fixed'" });
      return;
    }
    const discountNum = Number(discountValue);
    if (isNaN(discountNum) || discountNum <= 0) {
      res.status(400).json({ error: "Discount value must be a positive number" });
      return;
    }
    if (discountType === "percentage" && discountNum > 100) {
      res.status(400).json({ error: "Percentage discount cannot exceed 100%" });
      return;
    }

    const sanitizedCode = code.toUpperCase().trim().replace(/\s+/g, "");

    const [coupon] = await db
      .insert(couponsTable)
      .values({
        code: sanitizedCode,
        discountType,
        discountValue: String(discountValue),
        minOrderAmount:
          minOrderAmount != null
            ? String(minOrderAmount)
            : null,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
        sellerId,
      })
      .returning();

    await logAudit({
      adminId: req.userId!,
      adminEmail: req.dbUser?.email,
      action: "seller_coupon.create",
      targetType: "coupon",
      targetId: String(coupon.id),
      after: { code: sanitizedCode, discountType, discountValue: discountNum, sellerId },
    });

    res.status(201).json(formatCoupon(coupon));
  } catch (err) {
    if (isPgError(err) && err.code === PG_ERROR_CODE.UNIQUE_VIOLATION) {
      res.status(409).json({ error: "A coupon with this code already exists" });
      return;
    }
    res.status(500).json({ error: "Failed to create coupon" });
  }
});

router.put("/sellers/me/coupons/:id", requireSeller, asyncHandler(async (req: ApiRequest, res) => {
  const sellerId = req.dbSeller!.id;
  const id = parseInt(req.params.id);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid coupon ID" });
    return;
  }

  // Scope by sellerId so a seller can only update their own coupons.
  const [existing] = await db
    .select()
    .from(couponsTable)
    .where(and(eq(couponsTable.id, id), eq(couponsTable.sellerId, sellerId)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Coupon not found" });
    return;
  }

  const { code, discountType, discountValue, minOrderAmount, expiryDate } =
    req.body as Partial<z.infer<typeof CreateCouponBody>>;

  if (discountType && !discountType || !discountType || !VALID_DISCOUNT_TYPES.includes(discountType)) {
    res.status(400).json({ error: "Invalid discount type" });
    return;
  }

  const [coupon] = await db
    .update(couponsTable)
    .set({
      code: code?.toUpperCase().trim(),
      discountType,
      discountValue: String(discountValue),
      minOrderAmount:
        minOrderAmount != null
          ? String(minOrderAmount)
          : null,
      expiryDate: expiryDate ? new Date(expiryDate) : null,
    })
    .where(eq(couponsTable.id, id))
    .returning();

  await logAudit({
    adminId: req.userId!,
    adminEmail: req.dbUser?.email,
    action: "seller_coupon.update",
    targetType: "coupon",
    targetId: String(coupon.id),
    after: { code: coupon.code, discountType: coupon.discountType, discountValue: Number(coupon.discountValue) },
  });

  res.json(formatCoupon(coupon));
}));

router.patch("/sellers/me/coupons/:id/toggle", requireSeller, asyncHandler(async (req: ApiRequest, res) => {
  const sellerId = req.dbSeller!.id;
  const id = parseInt(req.params.id);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid coupon ID" });
    return;
  }

  const [existing] = await db
    .select()
    .from(couponsTable)
    .where(and(eq(couponsTable.id, id), eq(couponsTable.sellerId, sellerId)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Coupon not found" });
    return;
  }

  const [coupon] = await db
    .update(couponsTable)
    .set({ isActive: !existing.isActive })
    .where(eq(couponsTable.id, id))
    .returning();

  await logAudit({
    adminId: req.userId!,
    adminEmail: req.dbUser?.email,
    action: "seller_coupon.toggle",
    targetType: "coupon",
    targetId: String(coupon.id),
    after: { isActive: coupon.isActive },
  });

  res.json(formatCoupon(coupon));
}));

router.delete("/sellers/me/coupons/:id", requireSeller, asyncHandler(async (req: ApiRequest, res) => {
  const sellerId = req.dbSeller!.id;
  const id = parseInt(req.params.id);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid coupon ID" });
    return;
  }

  // Scope the DELETE by sellerId so a seller can only delete their own
  // coupons. Returns 404 (not 403) when the coupon doesn't exist or
  // belongs to someone else -- avoids leaking which coupon IDs exist.
  const [deleted] = await db
    .delete(couponsTable)
    .where(and(eq(couponsTable.id, id), eq(couponsTable.sellerId, sellerId)))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Coupon not found" });
    return;
  }

  await logAudit({
    adminId: req.userId!,
    adminEmail: req.dbUser?.email,
    action: "seller_coupon.delete",
    targetType: "coupon",
    targetId: String(deleted.id),
    after: { code: deleted.code },
  });

  res.json({ message: "Coupon deleted" });
}));

export default router;
