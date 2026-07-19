// Fast autocomplete endpoint — add this to routes/index.ts
import { Router } from "express";
import { db } from "@workspace/db";
import { productsTable, productVariantsTable, categoriesTable } from "@workspace/db";
import { ilike, or, eq, sql, inArray } from "drizzle-orm";

const router = Router();

// GET /search/autocomplete?q=mango
// Returns up to 6 product suggestions + 3 category matches
router.get("/search/autocomplete", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) {
      res.json({ products: [], categories: [] });
      return;
    }

    const pattern = `%${q}%`;

    const [products, categories] = await Promise.all([
      db
        .select({
          id: productsTable.id,
          name: productsTable.name,
          slug: productsTable.slug,
          categoryId: productsTable.categoryId,
          scientificName: productsTable.scientificName,
          images: productsTable.images,
          averageRating: sql<number>`COALESCE(
                (SELECT ROUND(AVG(r.rating)::numeric, 1) FROM reviews r WHERE r.product_id = ${productsTable.id}), 0
                )`,
        })
        .from(productsTable)
        .where(
          or(
            ilike(productsTable.name, pattern),
            ilike(productsTable.description, pattern),
            ilike(productsTable.scientificName, pattern),
          ),
        )
        .limit(6),

      db
        .select({ name: categoriesTable.name, slug: categoriesTable.slug })
        .from(categoriesTable)
        .where(ilike(categoriesTable.name, pattern))
        .limit(3),
    ]);

    const productIds = products.map((p) => p.id);
    const variantRows = productIds.length > 0
      ? await db.select().from(productVariantsTable).where(inArray(productVariantsTable.productId, productIds))
      : [];
    const variantsByProduct = new Map<number, typeof variantRows>();
    for (const v of variantRows) {
      const list = variantsByProduct.get(v.productId) ?? [];
      list.push(v);
      variantsByProduct.set(v.productId, list);
    }

    res.json({
      products: products.map((p) => {
        const variants = variantsByProduct.get(p.id) ?? [];
        const effectivePrices = variants.map((v) => v.discountPrice != null ? Number(v.discountPrice) : Number(v.price));
        const startingPrice = effectivePrices.length > 0 ? Math.min(...effectivePrices) : null;
        return {
          id: p.id,
          name: p.name,
          slug: p.slug,
          categoryId: p.categoryId,
          startingPrice,
          image: (p.images as string[])?.[0] ?? null,
          averageRating: Number(p.averageRating),
        };
      }),
      categories,
    });
  } catch {
    res.status(500).json({ error: "Search failed" });
  }
});

export default router;

// ─── Add this to artifacts/api-server/src/routes/index.ts ───────────────────
// import searchRouter from "./search";
// router.use(searchRouter);
