// Fast autocomplete endpoint — add this to routes/index.ts
import { Router } from "express";
import { db } from "@workspace/db";
import {
  productsTable,
  productVariantsTable,
  categoriesTable,
  sellerListingsTable,
  sellerListingVariantsTable,
  sellersTable,
} from "@workspace/db";
import { ilike, or, eq, and, sql, inArray } from "drizzle-orm";

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

    // Phase 2: admin variants are legacy data now (admin no longer creates
    // productVariantsTable rows -- see routes/products.ts). For any product
    // created post-Phase-2, `variantRows` below will always be empty, so
    // the price shown here needs a marketplace fallback or every new
    // product's search result would silently show no price at all.
    const [variantRows, listingVariantRows] = await Promise.all([
      productIds.length > 0
        ? db.select().from(productVariantsTable).where(inArray(productVariantsTable.productId, productIds))
        : Promise.resolve([]),
      productIds.length > 0
        ? db
            .select({
              productId: sellerListingsTable.productId,
              price: sellerListingVariantsTable.price,
              discountPrice: sellerListingVariantsTable.discountPrice,
            })
            .from(sellerListingVariantsTable)
            .innerJoin(sellerListingsTable, eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id))
            .innerJoin(sellersTable, eq(sellerListingsTable.sellerId, sellersTable.id))
            .where(
              and(
                inArray(sellerListingsTable.productId, productIds),
                eq(sellerListingsTable.visibility, "public"),
                eq(sellerListingsTable.approvalStatus, "approved"),
                eq(sellersTable.status, "active"),
                sql`${sellerListingVariantsTable.availableQuantity} > 0`,
              ),
            )
        : Promise.resolve([]),
    ]);

    const variantsByProduct = new Map<number, typeof variantRows>();
    for (const v of variantRows) {
      const list = variantsByProduct.get(v.productId) ?? [];
      list.push(v);
      variantsByProduct.set(v.productId, list);
    }
    const listingPricesByProduct = new Map<number, number[]>();
    for (const r of listingVariantRows) {
      const price = r.discountPrice != null ? Number(r.discountPrice) : Number(r.price);
      const list = listingPricesByProduct.get(r.productId) ?? [];
      list.push(price);
      listingPricesByProduct.set(r.productId, list);
    }

    res.json({
      products: products.map((p) => {
        const variants = variantsByProduct.get(p.id) ?? [];
        const effectivePrices = variants.map((v) => v.discountPrice != null ? Number(v.discountPrice) : Number(v.price));
        // Admin variant price wins if any legacy rows exist (unchanged
        // behavior for pre-Phase-2 products); otherwise fall back to the
        // cheapest qualifying marketplace listing variant. This endpoint's
        // `startingPrice` field means "the price to show for this search
        // result" -- distinct from routes/products.ts's toProduct(), where
        // `startingPrice` specifically means "admin-set price" and
        // marketplace data instead gets its own separate
        // listingMinPrice/listingMaxPrice fields. There's no such
        // admin-vs-marketplace distinction visible in this autocomplete
        // dropdown response shape, so one field serving as "best available
        // price, whichever source has one" is the correct behavior here,
        // not an inconsistency with that convention.
        const adminPrice = effectivePrices.length > 0 ? Math.min(...effectivePrices) : null;
        const listingPrices = listingPricesByProduct.get(p.id) ?? [];
        const marketplacePrice = listingPrices.length > 0 ? Math.min(...listingPrices) : null;
        const startingPrice = adminPrice ?? marketplacePrice;
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
