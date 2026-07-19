import { logAudit } from "../lib/audit";
import { Router } from "express";
import multerPkg from "multer";
import { v2 as cloudinaryV2 } from "cloudinary";
import { db } from "@workspace/db";
import {
  productsTable,
  productVariantsTable,
  categoriesTable,
  reviewsTable,
} from "@workspace/db";
import { eq, ilike, gte, lte, and, desc, sql, inArray, or } from "drizzle-orm";
import { requireAdmin, requireAuth } from "../middlewares/auth";
import { notifyStockAlerts } from "./stockAlerts";
import { notifyPreOrderCustomers } from "./preOrders";

cloudinaryV2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadStorage = multerPkg.memoryStorage();
const uploadMiddleware = multerPkg({ storage: uploadStorage, limits: { fileSize: 10 * 1024 * 1024 } });

const router = Router();

type VariantRow = typeof productVariantsTable.$inferSelect;

function toVariant(v: VariantRow) {
  return {
    id: v.id,
    productId: v.productId,
    name: v.name,
    variantType: v.variantType,
    form: v.form ?? null,
    price: Number(v.price),
    discountPrice: v.discountPrice != null ? Number(v.discountPrice) : null,
    stock: v.stock,
    deliveryCharge: Number(v.deliveryCharge),
    sku: v.sku ?? null,
  };
}

function toProduct(
  p: typeof productsTable.$inferSelect,
  variants: VariantRow[],
  avgRating: number,
  reviewCount: number,
) {
  const effectivePrices = variants.map((v) =>
    v.discountPrice != null ? Number(v.discountPrice) : Number(v.price)
  );
  const startingPrice = effectivePrices.length > 0 ? Math.min(...effectivePrices) : null;
  const totalStock = variants.reduce((sum, v) => sum + v.stock, 0);
  const inStock = variants.some((v) => v.stock > 0);

  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    categoryId: p.categoryId,
    scientificName: p.scientificName ?? null,
    description: p.description,

    sunlight: p.sunlight ?? null,
    watering: p.watering ?? null,
    soilType: p.soilType ?? null,
    matureHeight: p.matureHeight ?? null,
    climateZone: p.climateZone ?? null,
    growthRate: p.growthRate ?? null,
    bloomSeason: p.bloomSeason ?? null,

    keyBenefits: (p.keyBenefits as string[]) ?? [],
    bestFor: (p.bestFor as string[]) ?? [],
    careTips: (p.careTips as string[]) ?? [],

    images: p.images as string[],
    videoUrl: p.videoUrl ?? null,
    homepageTag: p.homepageTag,
    productStatus: p.productStatus ?? "in_stock",

    startingPrice,
    totalStock,
    inStock,
    variants: variants.map(toVariant),

    averageRating: avgRating,
    reviewCount,
    createdAt: p.createdAt.toISOString(),
  };
}

async function fetchReviewStats(productIds: number[]): Promise<Map<number, { avg: number; count: number }>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({
      productId: reviewsTable.productId,
      avg: sql<string>`COALESCE(AVG(${reviewsTable.rating}), 0)`,
      count: sql<string>`COUNT(*)`,
    })
    .from(reviewsTable)
    .where(inArray(reviewsTable.productId, productIds))
    .groupBy(reviewsTable.productId);

  const map = new Map<number, { avg: number; count: number }>();
  for (const r of rows) {
    map.set(r.productId, {
      avg: Number(Number(r.avg).toFixed(1)),
      count: Number(r.count),
    });
  }
  return map;
}

async function fetchVariantsFor(productIds: number[]): Promise<Map<number, VariantRow[]>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(productVariantsTable)
    .where(inArray(productVariantsTable.productId, productIds));
  const map = new Map<number, VariantRow[]>();
  for (const v of rows) {
    const list = map.get(v.productId) ?? [];
    list.push(v);
    map.set(v.productId, list);
  }
  return map;
}

router.get("/products/featured", async (_req, res) => {
  try {
    const products = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.homepageTag, "trending"))
      .limit(8);

    const ids = products.map((p) => p.id);
    const [statsMap, variantsMap] = await Promise.all([
      fetchReviewStats(ids),
      fetchVariantsFor(ids),
    ]);
    const result = products.map((p) => {
      const stats = statsMap.get(p.id) ?? { avg: 0, count: 0 };
      return toProduct(p, variantsMap.get(p.id) ?? [], stats.avg, stats.count);
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch featured products" });
  }
});

router.get("/products/tag-counts", async (_req, res) => {
  try {
    const { isNotNull } = await import("drizzle-orm");
    const rows = await db
      .select({ tag: productsTable.homepageTag, count: sql<number>`cast(count(*) as int)` })
      .from(productsTable)
      .where(isNotNull(productsTable.homepageTag))
      .groupBy(productsTable.homepageTag);
    const counts: Record<string, number> = {};
    rows.forEach(r => { if (r.tag) counts[r.tag] = r.count; });
    res.json(counts);
  } catch (e) {
    console.error("tag-counts error:", e);
    res.status(500).json({ error: "Failed to fetch tag counts" });
  }
});

router.get("/products/homepage", async (_req, res) => {
  try {
    const [topProducts, bottomProducts] = await Promise.all([
      db
        .select()
        .from(productsTable)
        .where(eq(productsTable.homepageTag, "trending"))
        .orderBy(desc(productsTable.createdAt)),
      db
        .select()
        .from(productsTable)
        .where(eq(productsTable.homepageTag, "new_arrivals"))
        .orderBy(desc(productsTable.createdAt)),
    ]);

    const allProducts = [...topProducts, ...bottomProducts];
    const ids = allProducts.map((p) => p.id);
    const [statsMap, variantsMap] = await Promise.all([
      fetchReviewStats(ids),
      fetchVariantsFor(ids),
    ]);

    function withStats(products: typeof topProducts) {
      return products.map((p) => {
        const stats = statsMap.get(p.id) ?? { avg: 0, count: 0 };
        return toProduct(p, variantsMap.get(p.id) ?? [], stats.avg, stats.count);
      });
    }

    res.json({
      top: withStats(topProducts),
      bottom: withStats(bottomProducts),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch homepage products" });
  }
});

router.post("/products/upload-image", requireAuth, requireAdmin, uploadMiddleware.array("images", 4), async (req: any, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: "No files uploaded" }); return;
    }
    const rawName = req.body.productName;
    const productName = Array.isArray(rawName) ? String(rawName[0] ?? "") : String(rawName ?? "");
    const slug = productName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    const startIndex = parseInt(req.body.startIndex ?? "0") || 0;
    const urls = await Promise.all(files.map((file, idx) => new Promise<string>((resolve, reject) => {
      const absoluteIdx = startIndex + idx;
      const publicId = slug ? `${slug}-${absoluteIdx + 1}-${Date.now()}` : undefined;
      const isPrimary = absoluteIdx === 0;
      const stream = cloudinaryV2.uploader.upload_stream(
        { folder: "envyenhance/products", ...(isPrimary ? {} : { quality: 75, format: "webp" }), ...(publicId ? { public_id: publicId } : {}) },
        (err, result) => {
          if (err || !result) { console.error("Cloudinary error:", err); return reject(err ?? new Error("Upload failed")); }
          const url = isPrimary
            ? result.secure_url.replace("/upload/", "/upload/f_jpg/")
            : result.secure_url;
          resolve(url);
        }
      );
      stream.end(file.buffer);
    })));
    res.json({ urls });
  } catch (err) {
    console.error("Upload endpoint error:", err);
    res.status(500).json({ error: "Upload failed", details: String(err) });
  }
});

router.get("/products/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid product ID" });
      return;
    }
    const [p] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, id));
    if (!p) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    const variants = await db
      .select()
      .from(productVariantsTable)
      .where(eq(productVariantsTable.productId, p.id));
    const [stats] = await db
      .select({
        avg: sql<string>`COALESCE(AVG(${reviewsTable.rating}), 0)`,
        count: sql<string>`COUNT(*)`,
      })
      .from(reviewsTable)
      .where(eq(reviewsTable.productId, p.id));
    res.json(
      toProduct(
        p,
        variants,
        Number(Number(stats.avg).toFixed(1)),
        Number(stats.count),
      ),
    );
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

router.get("/products", async (req, res) => {
  try {
    const {
      category,
      search,
      minPrice,
      maxPrice,
      page = "1",
      limit = "20",
    } = req.query as Record<string, string>;

    const minRating = req.query.minRating ? Number(req.query.minRating) : null;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    if (category) {
      const slugs = category.split(",").map(s => s.trim()).filter(Boolean);
      const matchingCats = await db
        .select({ id: categoriesTable.id })
        .from(categoriesTable)
        .where(inArray(categoriesTable.slug, slugs));
      const categoryIds = matchingCats.map((c) => c.id);
      conditions.push(
        categoryIds.length > 0
          ? inArray(productsTable.categoryId, categoryIds)
          : sql`false`
      );
    }
    if (search) conditions.push(or(ilike(productsTable.name, `%${search}%`), ilike(productsTable.description, `%${search}%`)));

    const homepageTagFilter = req.query.homepageTag as string | undefined;
    if (homepageTagFilter) conditions.push(eq(productsTable.homepageTag, homepageTagFilter));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [{ total }] = await db
      .select({ total: sql<string>`COUNT(*)` })
      .from(productsTable)
      .where(where);

    const products = await db
      .select()
      .from(productsTable)
      .where(where)
      .orderBy(desc(productsTable.createdAt))
      .limit(limitNum)
      .offset(offset);

    const ids = products.map((p) => p.id);
    const [statsMap, variantsMap] = await Promise.all([
      fetchReviewStats(ids),
      fetchVariantsFor(ids),
    ]);

    let result = products.map((p) => {
      const stats = statsMap.get(p.id) ?? { avg: 0, count: 0 };
      return toProduct(p, variantsMap.get(p.id) ?? [], stats.avg, stats.count);
    });

    if (minPrice) result = result.filter((p) => p.startingPrice != null && p.startingPrice >= Number(minPrice));
    if (maxPrice) result = result.filter((p) => p.startingPrice != null && p.startingPrice <= Number(maxPrice));

    if (minRating !== null && minRating > 0) {
      result = result.filter((p) => p.averageRating >= minRating);
    }

    const reportedTotal = (minRating !== null && minRating > 0) || minPrice || maxPrice
      ? result.length + offset
      : Number(total);

    res.json({
      products: result,
      total: reportedTotal,
      page: pageNum,
      totalPages: Math.ceil(reportedTotal / limitNum),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

type VariantInput = {
  name: string;
  variantType?: string;
  form?: string | null;
  price: number | string;
  discountPrice?: number | string | null;
  stock?: number;
  deliveryCharge?: number | string;
  sku?: string | null;
};

function validateVariants(variants: unknown): { ok: true; value: VariantInput[] } | { ok: false; error: string } {
  if (!Array.isArray(variants) || variants.length === 0) {
    return { ok: false, error: "At least one variant (e.g. Seed, Sapling, Grafted, Potted) is required" };
  }
  for (const v of variants) {
    if (!v || typeof v !== "object") return { ok: false, error: "Each variant must be an object" };
    if (!v.name || typeof v.name !== "string") return { ok: false, error: "Each variant needs a name" };
    if (v.price === undefined || isNaN(Number(v.price)) || Number(v.price) < 0) {
      return { ok: false, error: `Valid price is required for variant "${v.name}"` };
    }
    if (v.discountPrice != null && Number(v.discountPrice) >= Number(v.price)) {
      return { ok: false, error: `Discount price must be less than regular price for variant "${v.name}"` };
    }
  }
  return { ok: true, value: variants as VariantInput[] };
}

router.post("/products", requireAdmin, async (req: any, res) => {
  try {
    const {
      name,
      categoryId,
      scientificName,
      description,
      sunlight,
      watering,
      soilType,
      matureHeight,
      climateZone,
      growthRate,
      bloomSeason,
      images,
      homepageTag,
      keyBenefits,
      bestFor,
      careTips,
      variants,
    } = req.body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "Product name is required" });
      return;
    }
    if (!categoryId || isNaN(Number(categoryId))) {
      res.status(400).json({ error: "A subcategory is required" });
      return;
    }
    if (!description || typeof description !== "string") {
      res.status(400).json({ error: "Description is required" });
      return;
    }
    const variantCheck = validateVariants(variants);
    if (!variantCheck.ok) {
      res.status(400).json({ error: variantCheck.error });
      return;
    }

    const slug =
      name
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "") +
      "-" +
      Date.now();

    const [p] = await db
      .insert(productsTable)
      .values({
        name: name.trim(),
        slug,
        categoryId: Number(categoryId),
        scientificName: scientificName || null,
        description,
        sunlight: sunlight || null,
        watering: watering || null,
        soilType: soilType || null,
        matureHeight: matureHeight || null,
        climateZone: climateZone || null,
        growthRate: growthRate || null,
        bloomSeason: bloomSeason || null,
        keyBenefits: keyBenefits ?? [],
        bestFor: bestFor ?? [],
        careTips: careTips ?? [],
        videoUrl: req.body.videoUrl ?? null,
        images: images ?? [],
        homepageTag: homepageTag || null,
      })
      .returning();

    const insertedVariants = await db
      .insert(productVariantsTable)
      .values(
        variantCheck.value.map((v) => ({
          productId: p.id,
          name: v.name,
          variantType: v.variantType || "form",
          form: v.form ?? null,
          price: String(v.price),
          discountPrice: v.discountPrice != null ? String(v.discountPrice) : null,
          stock: v.stock ?? 0,
          deliveryCharge: String(v.deliveryCharge ?? 0),
          sku: v.sku ?? null,
        }))
      )
      .returning();

    res.status(201).json(toProduct(p, insertedVariants, 0, 0));
  } catch (err) {
    console.error("Create product error:", err);
    res.status(500).json({ error: "Failed to create product" });
  }
});

router.put("/products/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid product ID" });
      return;
    }
    const {
      name,
      categoryId,
      scientificName,
      description,
      sunlight,
      watering,
      soilType,
      matureHeight,
      climateZone,
      growthRate,
      bloomSeason,
      images,
      homepageTag,
      keyBenefits,
      bestFor,
      careTips,
      variants,
    } = req.body;

    if (variants !== undefined) {
      const variantCheck = validateVariants(variants);
      if (!variantCheck.ok) {
        res.status(400).json({ error: variantCheck.error });
        return;
      }
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name.trim();
    if (categoryId !== undefined) updates.categoryId = Number(categoryId);
    if (scientificName !== undefined) updates.scientificName = scientificName || null;
    if (description !== undefined) updates.description = description;
    if (sunlight !== undefined) updates.sunlight = sunlight || null;
    if (watering !== undefined) updates.watering = watering || null;
    if (soilType !== undefined) updates.soilType = soilType || null;
    if (matureHeight !== undefined) updates.matureHeight = matureHeight || null;
    if (climateZone !== undefined) updates.climateZone = climateZone || null;
    if (growthRate !== undefined) updates.growthRate = growthRate || null;
    if (bloomSeason !== undefined) updates.bloomSeason = bloomSeason || null;
    if (keyBenefits !== undefined) updates.keyBenefits = keyBenefits;
    if (bestFor !== undefined) updates.bestFor = bestFor;
    if (careTips !== undefined) updates.careTips = careTips;
    if (req.body.videoUrl !== undefined) updates.videoUrl = req.body.videoUrl;
    if (images !== undefined) updates.images = images;
    if (homepageTag !== undefined) updates.homepageTag = homepageTag || null;
    if (req.body.productStatus !== undefined) updates.productStatus = req.body.productStatus;
    updates.updatedAt = new Date();

    const before = await db
      .select()
      .from(productVariantsTable)
      .where(eq(productVariantsTable.productId, id));
    const wasOutOfStock = before.length > 0 && before.every((v) => v.stock === 0);

    const [beforeProduct] = await db
      .select({ productStatus: productsTable.productStatus })
      .from(productsTable)
      .where(eq(productsTable.id, id))
      .limit(1);

    const [p] = await db
      .update(productsTable)
      .set(updates)
      .where(eq(productsTable.id, id))
      .returning();
    if (!p) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    let currentVariants = before;
    if (variants !== undefined) {
      await db.delete(productVariantsTable).where(eq(productVariantsTable.productId, id));
      currentVariants = await db
        .insert(productVariantsTable)
        .values(
          (variants as VariantInput[]).map((v) => ({
            productId: id,
            name: v.name,
            variantType: v.variantType || "form",
            form: v.form ?? null,
            price: String(v.price),
            discountPrice: v.discountPrice != null ? String(v.discountPrice) : null,
            stock: v.stock ?? 0,
            deliveryCharge: String(v.deliveryCharge ?? 0),
            sku: v.sku ?? null,
          }))
        )
        .returning();
    }

    const nowInStock = currentVariants.some((v) => v.stock > 0);
    if (wasOutOfStock && nowInStock) {
      notifyStockAlerts(p.id, p.name).catch(() => {});
    }
    if (req.body.productStatus === "in_stock" && beforeProduct?.productStatus === "pre_order") {
      notifyPreOrderCustomers(p.id, p.name).catch(() => {});
    }

    const [stats] = await db
      .select({
        avg: sql<string>`COALESCE(AVG(${reviewsTable.rating}), 0)`,
        count: sql<string>`COUNT(*)`,
      })
      .from(reviewsTable)
      .where(eq(reviewsTable.productId, p.id));
    res.json(
      toProduct(
        p,
        currentVariants,
        Number(Number(stats.avg).toFixed(1)),
        Number(stats.count),
      ),
    );
  } catch (err) {
    console.error("Update product error:", err);
    res.status(500).json({ error: "Failed to update product" });
  }
});

router.delete("/products/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid product ID" });
      return;
    }
    // productVariantsTable.productId has no DB-level FK/cascade, so variants
    // must be deleted explicitly here or they would be orphaned forever.
    await db.delete(productVariantsTable).where(eq(productVariantsTable.productId, id));
    await db.delete(productsTable).where(eq(productsTable.id, id));
    res.json({ message: "Product deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete product" });
  }
});

router.post("/products/:id/duplicate", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid product ID" });
      return;
    }
    const [original] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, id))
      .limit(1);

    if (!original) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const originalVariants = await db
      .select()
      .from(productVariantsTable)
      .where(eq(productVariantsTable.productId, id));

    const newSlug =
      original.slug.replace(/-\d+$/, "") + "-" + Date.now();

    const [copy] = await db
      .insert(productsTable)
      .values({
        name: `${original.name} (Copy)`,
        slug: newSlug,
        categoryId: original.categoryId,
        scientificName: original.scientificName,
        description: original.description,
        sunlight: original.sunlight,
        watering: original.watering,
        soilType: original.soilType,
        matureHeight: original.matureHeight,
        climateZone: original.climateZone,
        growthRate: original.growthRate,
        bloomSeason: original.bloomSeason,
        keyBenefits: original.keyBenefits,
        bestFor: original.bestFor,
        careTips: original.careTips,
        images: original.images,
        homepageTag: null,
      })
      .returning();

    const copiedVariants = originalVariants.length > 0
      ? await db
          .insert(productVariantsTable)
          .values(
            originalVariants.map((v) => ({
              productId: copy.id,
              name: v.name,
              variantType: v.variantType,
              form: v.form,
              price: v.price,
              discountPrice: v.discountPrice,
              stock: 0,
              deliveryCharge: v.deliveryCharge,
              sku: null,
            }))
          )
          .returning()
      : [];

    res.status(201).json(toProduct(copy, copiedVariants, 0, 0));
  } catch {
    res.status(500).json({ error: "Failed to duplicate product" });
  }
});

export default router;
