import { Router } from "express";
import { db } from "@workspace/db";
import { couponsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAdmin, requireSeller } from "../middlewares/auth";
import { logAudit } from "../lib/audit";

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

router.post("/coupons/validate", async (req, res) => {
  try {
    const { code, orderAmount } = req.body;

    if (!code || typeof code !== "string") {
      res.status(400).json({ error: "Coupon code is required" });
      return;
    }

    // Sanitize coupon code - only alphanumeric + dashes
    const sanitizedCode = code.toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (!sanitizedCode) {
      res.status(400).json({ error: "Invalid coupon code format" });
      return;
    }

    const [coupon] = await db
      .select()
      .from(couponsTable)
      .where(eq(couponsTable.code, sanitizedCode))
      .limit(1);

    if (!coupon || !coupon.isActive) {
      res.status(404).json({ error: "Invalid or expired coupon" });
      return;
    }
    if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
      res.status(400).json({ error: "Coupon has expired" });
      return;
    }
    if (
      coupon.minOrderAmount &&
      Number(orderAmount) < Number(coupon.minOrderAmount)
    ) {
      res.status(400).json({
        error: `Minimum order amount is ৳${coupon.minOrderAmount}`,
      });
      return;
    }
    res.json(formatCoupon(coupon));
  } catch (err) {
    res.status(500).json({ error: "Failed to validate coupon" });
  }
});

router.get("/coupons", requireAdmin, async (_req, res) => {
  try {
    const coupons = await db
      .select()
      .from(couponsTable)
      .orderBy(couponsTable.createdAt);
    res.json(coupons.map(formatCoupon));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch coupons" });
  }
});

router.post("/coupons", requireAdmin, async (req: any, res) => {
  try {
    const { code, discountType, discountValue, minOrderAmount, expiryDate } =
      req.body;

    // Validate inputs
    if (!code || typeof code !== "string" || code.trim().length === 0) {
      res.status(400).json({ error: "Coupon code is required" });
      return;
    }
    if (!VALID_DISCOUNT_TYPES.includes(discountType)) {
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
          minOrderAmount != null && minOrderAmount !== ""
            ? String(minOrderAmount)
            : null,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
      })
      .returning();
    res.status(201).json(formatCoupon(coupon));
  } catch (err: any) {
    // Handle unique constraint violation on coupon code
    if (err?.code === "23505") {
      res.status(409).json({ error: "A coupon with this code already exists" });
      return;
    }
    res.status(500).json({ error: "Failed to create coupon" });
  }
});

router.put("/coupons/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid coupon ID" });
      return;
    }
    const { code, discountType, discountValue, minOrderAmount, expiryDate } =
      req.body;

    if (discountType && !VALID_DISCOUNT_TYPES.includes(discountType)) {
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
          minOrderAmount != null && minOrderAmount !== ""
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
  } catch (err) {
    res.status(500).json({ error: "Failed to update coupon" });
  }
});

router.patch("/coupons/:id/toggle", requireAdmin, async (req: any, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ error: "Failed to toggle coupon" });
  }
});

router.delete("/coupons/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid coupon ID" });
      return;
    }
    await db.delete(couponsTable).where(eq(couponsTable.id, id));
    res.json({ message: "Coupon deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete coupon" });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  Seller-scoped coupon routes
//
//  These power the "Coupons" tab in the seller dashboard (coupons were
//  shifted out of the admin panel and into the seller dashboard so each
//  seller can manage their own discount codes). All routes require an
//  active seller account (requireSeller) and scope every read/write to
//  req.dbSeller.id -- a seller can only ever see / edit / delete coupons
//  where coupons.seller_id === their own seller id.
//
//  Platform-wide coupons (seller_id IS NULL, e.g. welcome codes generated
//  by the referral system) are NOT visible through these routes -- they
//  remain managed by the system / admin API.
// ══════════════════════════════════════════════════════════════════════════

router.get("/sellers/me/coupons", requireSeller, async (req: any, res) => {
  try {
    const sellerId = req.dbSeller.id;
    const coupons = await db
      .select()
      .from(couponsTable)
      .where(eq(couponsTable.sellerId, sellerId))
      .orderBy(couponsTable.createdAt);
    res.json(coupons.map(formatCoupon));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch your coupons" });
  }
});

router.post("/sellers/me/coupons", requireSeller, async (req: any, res) => {
  try {
    const sellerId = req.dbSeller.id;
    const { code, discountType, discountValue, minOrderAmount, expiryDate } =
      req.body;

    if (!code || typeof code !== "string" || code.trim().length === 0) {
      res.status(400).json({ error: "Coupon code is required" });
      return;
    }
    if (!VALID_DISCOUNT_TYPES.includes(discountType)) {
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
          minOrderAmount != null && minOrderAmount !== ""
            ? String(minOrderAmount)
            : null,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
        sellerId,
      })
      .returning();

    await logAudit({
      adminId: req.userId,
      adminEmail: req.dbUser?.email,
      action: "seller_coupon.create",
      targetType: "coupon",
      targetId: String(coupon.id),
      after: { code: sanitizedCode, discountType, discountValue: discountNum, sellerId },
    });

    res.status(201).json(formatCoupon(coupon));
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: "A coupon with this code already exists" });
      return;
    }
    res.status(500).json({ error: "Failed to create coupon" });
  }
});

router.put("/sellers/me/coupons/:id", requireSeller, async (req: any, res) => {
  try {
    const sellerId = req.dbSeller.id;
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
      req.body;

    if (discountType && !VALID_DISCOUNT_TYPES.includes(discountType)) {
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
          minOrderAmount != null && minOrderAmount !== ""
            ? String(minOrderAmount)
            : null,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
      })
      .where(eq(couponsTable.id, id))
      .returning();

    await logAudit({
      adminId: req.userId,
      adminEmail: req.dbUser?.email,
      action: "seller_coupon.update",
      targetType: "coupon",
      targetId: String(coupon.id),
      after: { code: coupon.code, discountType: coupon.discountType, discountValue: Number(coupon.discountValue) },
    });

    res.json(formatCoupon(coupon));
  } catch (err) {
    res.status(500).json({ error: "Failed to update coupon" });
  }
});

router.patch("/sellers/me/coupons/:id/toggle", requireSeller, async (req: any, res) => {
  try {
    const sellerId = req.dbSeller.id;
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
      adminId: req.userId,
      adminEmail: req.dbUser?.email,
      action: "seller_coupon.toggle",
      targetType: "coupon",
      targetId: String(coupon.id),
      after: { isActive: coupon.isActive },
    });

    res.json(formatCoupon(coupon));
  } catch (err) {
    res.status(500).json({ error: "Failed to toggle coupon" });
  }
});

router.delete("/sellers/me/coupons/:id", requireSeller, async (req: any, res) => {
  try {
    const sellerId = req.dbSeller.id;
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
      adminId: req.userId,
      adminEmail: req.dbUser?.email,
      action: "seller_coupon.delete",
      targetType: "coupon",
      targetId: String(deleted.id),
      after: { code: deleted.code },
    });

    res.json({ message: "Coupon deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete coupon" });
  }
});

export default router;
