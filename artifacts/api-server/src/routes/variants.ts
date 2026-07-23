import { Router } from "express";
import { db } from "@workspace/db";
import { productVariantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

function fmt(v: typeof productVariantsTable.$inferSelect) {
  return {
    id: v.id,
    productId: v.productId,
    name: v.name,
    variantType: v.variantType,
    price: Number(v.price),
    discountPrice: v.discountPrice != null ? Number(v.discountPrice) : null,
    stock: v.stock,
    sku: v.sku ?? null,
  };
}

router.get("/products/:productId/variants", async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    if (isNaN(productId)) { res.status(400).json({ error: "Invalid product ID" }); return; }
    const variants = await db
      .select()
      .from(productVariantsTable)
      .where(eq(productVariantsTable.productId, productId));
    res.json(variants.map(fmt));
  } catch { res.status(500).json({ error: "Failed to fetch variants" }); }
});

/**
 * Phase 2: POST/PUT/DELETE below are disabled (410 Gone), not deleted
 * outright. This standalone router isn't in the prompt's explicit
 * files-to-change list for products.ts, but it's a live, admin-reachable
 * side door directly onto productVariantsTable -- an admin (or any client
 * that knew this path) could freely create/edit rows here regardless of
 * what POST/PUT /products enforce, completely undermining "admin never
 * creates variant/price data" from routes/products.ts. Grepped the
 * frontend (artifacts/tree-friend/src/components/admin/modals/
 * ProductModal.tsx, the only admin UI that references "variants") and
 * confirmed it never calls these three endpoints directly -- it goes
 * through POST/PUT /products' own (now-ignored) `variants` field instead,
 * so disabling these is not a UI-breaking change. GET stays live: reading
 * existing legacy admin variants is still needed (see routes/products.ts,
 * routes/cart.ts, routes/orders.ts's own read-only productVariantsTable
 * usage for the guest/admin-direct checkout path this phase deliberately
 * did not touch).
 */
router.post("/products/:productId/variants", requireAdmin, async (_req, res) => {
  res.status(410).json({ error: "Admin no longer creates variant/price data directly. Sellers manage price and stock through seller listings instead." });
});

router.put("/products/:productId/variants/:variantId", requireAdmin, async (_req, res) => {
  res.status(410).json({ error: "Admin no longer edits variant/price data directly. Sellers manage price and stock through seller listings instead." });
});

router.delete("/products/:productId/variants/:variantId", requireAdmin, async (_req, res) => {
  res.status(410).json({ error: "Admin no longer deletes variant/price data directly." });
});

export default router;
