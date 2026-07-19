import { Router } from "express";
import { db } from "@workspace/db";
import { productsTable, productVariantsTable } from "@workspace/db";
import { and, isNotNull, desc, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";

const router = Router();

/**
 * Flash sales are products tagged homepageTag = "flash" that have at
 * least one variant with a discountPrice set. Discounts now live on
 * variants (not the product itself), since price is per-variant.
 */
router.get("/flash-sales", async (_req, res) => {
  try {
    // Products with at least one discounted variant, tagged as flash sale
    const discountedProductIds = await db
      .select({ productId: productVariantsTable.productId })
      .from(productVariantsTable)
      .where(isNotNull(productVariantsTable.discountPrice));
    const idSet = [...new Set(discountedProductIds.map((r) => r.productId))];

    if (idSet.length === 0) {
      res.json([]);
      return;
    }

    const products = await db
      .select()
      .from(productsTable)
      .where(
        and(
          sql`${productsTable.homepageTag} = 'flash'`,
          inArray(productsTable.id, idSet),
        ),
      )
      .orderBy(desc(productsTable.createdAt))
      .limit(12);

    const variantRows = await db
      .select()
      .from(productVariantsTable)
      .where(inArray(productVariantsTable.productId, products.map((p) => p.id)));
    const variantsByProduct = new Map<number, typeof variantRows>();
    for (const v of variantRows) {
      const list = variantsByProduct.get(v.productId) ?? [];
      list.push(v);
      variantsByProduct.set(v.productId, list);
    }

    res.json(
      products.map((p) => {
        const variants = variantsByProduct.get(p.id) ?? [];
        const effectivePrices = variants.map((v) => v.discountPrice != null ? Number(v.discountPrice) : Number(v.price));
        const originalPrices = variants.map((v) => Number(v.price));
        const startingPrice = effectivePrices.length > 0 ? Math.min(...effectivePrices) : null;
        const startingOriginalPrice = originalPrices.length > 0 ? Math.min(...originalPrices) : null;
        const inStock = variants.some((v) => v.stock > 0);
        return {
          id: p.id,
          name: p.name,
          slug: p.slug,
          categoryId: p.categoryId,
          images: p.images as string[],
          startingPrice,
          startingOriginalPrice,
          inStock,
          homepageTag: p.homepageTag,
        };
      }),
    );
  } catch {
    res.status(500).json({ error: "Failed to fetch flash sales" });
  }
});

export default router;
