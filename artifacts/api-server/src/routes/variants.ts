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

router.post("/products/:productId/variants", requireAdmin, async (req: any, res) => {
  try {
    const productId = parseInt(req.params.productId);
    if (isNaN(productId)) { res.status(400).json({ error: "Invalid product ID" }); return; }
    const { name, variantType, price, discountPrice, stock, sku } = req.body;
    if (!name?.trim() || !variantType?.trim()) {
      res.status(400).json({ error: "name and variantType are required" }); return;
    }
    if (isNaN(Number(price)) || Number(price) <= 0) {
      res.status(400).json({ error: "Valid price is required" }); return;
    }
    const [v] = await db.insert(productVariantsTable).values({
      productId, name: name.trim(), variantType: variantType.trim(),
      price: String(price),
      discountPrice: discountPrice != null ? String(discountPrice) : null,
      stock: Number(stock ?? 0),
      sku: sku?.trim() ?? null,
    }).returning();
    res.status(201).json(fmt(v));
  } catch { res.status(500).json({ error: "Failed to create variant" }); }
});

router.put("/products/:productId/variants/:variantId", requireAdmin, async (req: any, res) => {
  try {
    const variantId = parseInt(req.params.variantId);
    if (isNaN(variantId)) { res.status(400).json({ error: "Invalid variant ID" }); return; }
    const { name, price, discountPrice, stock, sku } = req.body;
    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name.trim();
    if (price !== undefined) updates.price = String(price);
    if (discountPrice !== undefined) updates.discountPrice = discountPrice != null ? String(discountPrice) : null;
    if (stock !== undefined) updates.stock = Number(stock);
    if (sku !== undefined) updates.sku = sku?.trim() ?? null;
    const [v] = await db.update(productVariantsTable).set(updates)
      .where(eq(productVariantsTable.id, variantId)).returning();
    if (!v) { res.status(404).json({ error: "Variant not found" }); return; }
    res.json(fmt(v));
  } catch { res.status(500).json({ error: "Failed to update variant" }); }
});

router.delete("/products/:productId/variants/:variantId", requireAdmin, async (req: any, res) => {
  try {
    const variantId = parseInt(req.params.variantId);
    if (isNaN(variantId)) { res.status(400).json({ error: "Invalid variant ID" }); return; }
    await db.delete(productVariantsTable).where(eq(productVariantsTable.id, variantId));
    res.json({ message: "Variant deleted" });
  } catch { res.status(500).json({ error: "Failed to delete variant" }); }
});

export default router;
