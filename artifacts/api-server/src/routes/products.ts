import { asyncHandler } from "../lib/errors";
import { logAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { Router } from "express";
import multerPkg from "multer";
import {
  cloudinary,
  deleteCloudinaryAssets,
  cleanupRemovedImages,
} from "../lib/cloudinary";
import { db } from "@workspace/db";
import {
  productsTable,
  productVariantsTable,
  categoriesTable,
  reviewsTable,
  sellerListingsTable,
  sellerListingVariantsTable,
  sellersTable,
} from "@workspace/db";
import { eq, ilike, gte, lte, and, desc, sql, inArray, or, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { requireAdmin, requireAuth } from "../middlewares/auth";
import { notifyStockAlerts } from "./stockAlerts";
import { notifyPreOrderCustomers } from "./preOrders";
import { invalidateCatalogCache } from "../lib/catalogCache";
import type { ApiRequest } from "../types/apiRequest";
import type { z } from "zod";
import {
  CreateProductBody,
  UpdateProductBody,
  GetProductParams,
  UpdateProductParams,
  DeleteProductParams,
} from "@workspace/api-zod";
import { validateBody, validateParams } from "../lib/validateRequest";

// Use the shared Cloudinary singleton from lib/cloudinary.ts (configured once
// at module load). The previous `cloudinaryV2.config(...)` call here was
// redundant — the same SDK instance is shared across all imports.

const uploadStorage = multerPkg.memoryStorage();
const uploadMiddleware = multerPkg({
  storage: uploadStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  // MIME filter: only allow image uploads (defense-in-depth before Cloudinary
  // sees the file).
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

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

/**
 * Marketplace-derived stats for a product's qualifying seller listing
 * variants (visibility=public AND approvalStatus=approved AND
 * availableQuantity>0 at the VARIANT level -- see fetchMarketplaceStatsFor
 * below for the actual query). Deliberately separate fields from
 * startingPrice/totalStock/inStock (which stay admin-productVariants-based,
 * see toProduct doc note) rather than overloading them -- grepped the whole
 * repo for `startingPrice` first (see PHASE2_HANDOFF.md for the full list);
 * every remaining reference reads it as "the admin-set price", so repointing
 * it at marketplace data would silently change behavior for every one of
 * those call sites instead of adding new, clearly-named fields alongside.
 */
type MarketplaceStats = {
  listingMinPrice: number | null;
  listingMaxPrice: number | null;
  listingCount: number;
  // Phase 5: true if any qualifying seller listing variant has
  // isPreOrder=true. Replaces the admin-set productStatus === "pre_order"
  // badge (removed -- pre-order is per-variant seller data, not a
  // product-level admin concept post-Phase-2). Same qualifying filter as
  // listingCount/listingMinPrice/listingMaxPrice (public, approved, active
  // seller) -- deliberately NOT gated on availableQuantity>0 like those
  // are, since a variant can be legitimately pre-order-flagged while at
  // zero stock (that's the whole point of pre-order).
  listingHasPreOrder: boolean;
};

const EMPTY_MARKETPLACE_STATS: MarketplaceStats = {
  listingMinPrice: null,
  listingMaxPrice: null,
  listingCount: 0,
  listingHasPreOrder: false,
};

function toProduct(
  p: typeof productsTable.$inferSelect,
  variants: VariantRow[],
  avgRating: number,
  reviewCount: number,
  marketplaceStats: MarketplaceStats = EMPTY_MARKETPLACE_STATS,
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

    // startingPrice/totalStock/inStock/variants: UNCHANGED meaning --
    // still admin productVariantsTable-derived. As of Phase 2, admin never
    // writes to productVariantsTable (see POST/PUT /products below), so
    // these will read as null/0/false/[] for every product going forward
    // except legacy rows created before this phase. Kept as-is rather than
    // repointed at marketplace data -- see MarketplaceStats doc comment
    // above for why.
    startingPrice,
    totalStock,
    inStock,
    variants: variants.map(toVariant),

    // Phase 2 marketplace fields: derived from qualifying seller listing
    // variants (visibility=public AND approvalStatus=approved AND
    // availableQuantity>0 at the variant level). listingCount counts
    // LISTINGS (distinct sellers with >=1 qualifying variant), not
    // variants -- "Available From N Sellers" on the product detail page
    // means N sellers, not N variants.
    listingMinPrice: marketplaceStats.listingMinPrice,
    listingMaxPrice: marketplaceStats.listingMaxPrice,
    listingCount: marketplaceStats.listingCount,
    listingHasPreOrder: marketplaceStats.listingHasPreOrder,

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

/**
 * Batch marketplace stats (Phase 2) for a set of products -- qualifying
 * seller listing variants only: listing.visibility=public AND
 * listing.approvalStatus=approved AND seller.status=active AND
 * (variant.availableQuantity>0 OR variant.isPreOrder=true). Mirrors the
 * exact purchasability filter routes/sellerListings.ts's buyer-facing GET
 * /products/:productId/seller-listings uses (reused conceptually, not
 * imported, since that route works per-product while this one batches
 * across an arbitrary product id list for list/browse pages).
 *
 * listingCount = number of DISTINCT LISTINGS (sellers) with at least one
 * qualifying variant for that product, not number of variants -- a seller
 * with 2 in-stock variants still counts once toward "Available From N
 * Sellers".
 *
 * Phase 5: the WHERE clause was widened from availableQuantity>0 alone to
 * also include isPreOrder=true rows, so listingHasPreOrder can be computed
 * (a pre-order variant is typically AT zero stock -- that's the point of
 * pre-order -- so it would never appear under the original condition).
 * listingCount/listingMinPrice/listingMaxPrice deliberately keep their
 * original meaning and only aggregate over the availableQuantity>0 subset
 * of these now-wider rows, filtered in JS below, so this widening does not
 * silently change "Available From N Sellers" or price-range semantics for
 * any existing caller of this function.
 */
async function fetchMarketplaceStatsFor(productIds: number[]): Promise<Map<number, MarketplaceStats>> {
  if (productIds.length === 0) return new Map();

  const rows = await db
    .select({
      productId: sellerListingsTable.productId,
      sellerListingId: sellerListingsTable.id,
      price: sellerListingVariantsTable.price,
      discountPrice: sellerListingVariantsTable.discountPrice,
      availableQuantity: sellerListingVariantsTable.availableQuantity,
      isPreOrder: sellerListingVariantsTable.isPreOrder,
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
        sql`(${sellerListingVariantsTable.availableQuantity} > 0 OR ${sellerListingVariantsTable.isPreOrder} = true)`,
      ),
    );

  const byProduct = new Map<number, { prices: number[]; listingIds: Set<number>; hasPreOrder: boolean }>();
  for (const r of rows) {
    const entry = byProduct.get(r.productId) ?? { prices: [], listingIds: new Set<number>(), hasPreOrder: false };
    if (r.isPreOrder) entry.hasPreOrder = true;
    // listingCount/prices: only rows that qualify under the ORIGINAL
    // availableQuantity>0 condition -- unchanged semantics, see doc comment.
    if (r.availableQuantity > 0) {
      const price = r.discountPrice != null ? Number(r.discountPrice) : Number(r.price);
      entry.prices.push(price);
      entry.listingIds.add(r.sellerListingId);
    }
    byProduct.set(r.productId, entry);
  }

  const map = new Map<number, MarketplaceStats>();
  for (const [productId, entry] of byProduct) {
    map.set(productId, {
      listingMinPrice: entry.prices.length > 0 ? Math.min(...entry.prices) : null,
      listingMaxPrice: entry.prices.length > 0 ? Math.max(...entry.prices) : null,
      listingCount: entry.listingIds.size,
      listingHasPreOrder: entry.hasPreOrder,
    });
  }
  return map;
}

/**
 * Single-product version of routes/sellerListings.ts's GET
 * /products/:productId/seller-listings -- same purchasability filter, same
 * nested listing+variants shape, same "drop listings with zero qualifying
 * variants" rule (see that route's doc comment for the full rationale).
 * Not literally imported/called (that route is buyer-facing standalone,
 * this one packages the same data into the product detail response) but
 * deliberately kept in lockstep field-for-field so the "Available From N
 * Sellers" section on the product detail page and the standalone seller
 * cards list render identical data for the same product.
 */
async function fetchSellerListingCardsFor(productId: number) {
  const rows = await db
    .select({ listing: sellerListingsTable, seller: sellersTable })
    .from(sellerListingsTable)
    .innerJoin(sellersTable, eq(sellerListingsTable.sellerId, sellersTable.id))
    .where(
      and(
        eq(sellerListingsTable.productId, productId),
        eq(sellerListingsTable.visibility, "public"),
        eq(sellerListingsTable.approvalStatus, "approved"),
        eq(sellersTable.status, "active"),
      ),
    );

  const listingIds = rows.map((r) => r.listing.id);
  const [variantRows, statsRows] = await Promise.all([
    listingIds.length > 0
      ? db.select().from(sellerListingVariantsTable).where(inArray(sellerListingVariantsTable.sellerListingId, listingIds))
      : Promise.resolve([]),
    listingIds.length > 0
      ? db
          .select({
            sellerListingId: reviewsTable.sellerListingId,
            avg: sql<string>`COALESCE(AVG(${reviewsTable.rating}), 0)`,
            count: sql<string>`COUNT(*)`,
          })
          .from(reviewsTable)
          .where(inArray(reviewsTable.sellerListingId, listingIds))
          .groupBy(reviewsTable.sellerListingId)
      : Promise.resolve([]),
  ]);

  const variantsByListing = new Map<number, typeof variantRows>();
  for (const v of variantRows) {
    const list = variantsByListing.get(v.sellerListingId) ?? [];
    list.push(v);
    variantsByListing.set(v.sellerListingId, list);
  }
  const statsMap = new Map<number, { avg: number; count: number }>();
  for (const s of statsRows) {
    if (s.sellerListingId != null) {
      statsMap.set(s.sellerListingId, { avg: Number(Number(s.avg).toFixed(1)), count: Number(s.count) });
    }
  }

  return rows
    .map(({ listing, seller }) => {
      const variants = variantsByListing.get(listing.id) ?? [];
      const hasQualifyingVariant = variants.some((v) => v.availableQuantity > 0);
      const stats = statsMap.get(listing.id) ?? { avg: 0, count: 0 };
      return {
        hasQualifyingVariant,
        listing: {
          id: listing.id,
          productId: listing.productId,
          sellerId: listing.sellerId,
          deliveryTimeDays: listing.deliveryTimeDays ?? null,
          warrantyDays: listing.warrantyDays ?? null,
          returnPolicyText: listing.returnPolicyText ?? null,
          paymentMethod: listing.paymentMethod,
          images: listing.images,
          videoUrl: listing.videoUrl ?? null,
          description: listing.description ?? null,
          offerText: listing.offerText ?? null,
          certification: listing.certification ?? null,
          tags: listing.tags,
          visibility: listing.visibility,
          approvalStatus: listing.approvalStatus,
          variants: variants.map((v) => ({
            id: v.id,
            sellerListingId: v.sellerListingId,
            form: v.form ?? null,
            rootType: v.rootType ?? null,
            potSize: v.potSize ?? null,
            age: v.age ?? null,
            height: v.height ?? null,
            condition: v.condition ?? null,
            price: Number(v.price),
            discountPrice: v.discountPrice != null ? Number(v.discountPrice) : null,
            stock: v.stock,
            availableQuantity: v.availableQuantity,
            deliveryCharge: Number(v.deliveryCharge),
            isPreOrder: v.isPreOrder,
          })),
        },
        seller: {
          id: seller.id,
          businessName: seller.businessName,
          nurseryName: seller.nurseryName,
          location: seller.location,
          isVerified: seller.isVerified,
          logoUrl: seller.logoUrl,
        },
        rating: stats.avg,
        reviewCount: stats.count,
      };
    })
    .filter((card) => card.hasQualifyingVariant)
    .map(({ hasQualifyingVariant, ...card }) => card);
}

router.get("/products/featured", asyncHandler(async (_req, res) => {
  // PERF-6a: Cache-Control 5 min — featured products change only when an
  // admin edits product homepageTag. The browser/proxy cache eliminates
  // repeat DB queries on every page load. Stale-while-revalidate lets
  // the browser serve a stale response while fetching a fresh one in the
  // background (better UX than blocking on a cache-miss).
  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
  const products = await db
    .select()
    .from(productsTable)
    .where(and(eq(productsTable.homepageTag, "trending"), isNull(productsTable.deletedAt)))
    .limit(8);

  const ids = products.map((p) => p.id);
  const [statsMap, variantsMap, marketplaceMap] = await Promise.all([
    fetchReviewStats(ids),
    fetchVariantsFor(ids),
    fetchMarketplaceStatsFor(ids),
  ]);
  const result = products.map((p) => {
    const stats = statsMap.get(p.id) ?? { avg: 0, count: 0 };
    return toProduct(p, variantsMap.get(p.id) ?? [], stats.avg, stats.count, marketplaceMap.get(p.id));
  });
  res.json(result);
}));

router.get("/products/tag-counts", asyncHandler(async (_req, res) => {
  // PERF-6a: Cache-Control 5 min — tag counts change only when an admin
  // edits product homepageTag. Same rationale as /products/featured.
  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
  const { isNotNull } = await import("drizzle-orm");
  const rows = await db
    .select({ tag: productsTable.homepageTag, count: sql<number>`cast(count(*) as int)` })
    .from(productsTable)
    .where(isNotNull(productsTable.homepageTag))
    .groupBy(productsTable.homepageTag);
  const counts: Record<string, number> = {};
  rows.forEach(r => { if (r.tag) counts[r.tag] = r.count; });
  res.json(counts);
}));

router.get("/products/homepage", asyncHandler(async (_req, res) => {
  // PERF-6a: Cache-Control 5 min — homepage products change only when an
  // admin edits product homepageTag. Same rationale as /products/featured.
  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
  const [topProducts, bottomProducts] = await Promise.all([
    db
      .select()
      .from(productsTable)
      .where(and(eq(productsTable.homepageTag, "trending"), isNull(productsTable.deletedAt)))
      .orderBy(desc(productsTable.createdAt)),
    db
      .select()
      .from(productsTable)
      .where(and(eq(productsTable.homepageTag, "new_arrivals"), isNull(productsTable.deletedAt)))
      .orderBy(desc(productsTable.createdAt)),
  ]);

  const allProducts = [...topProducts, ...bottomProducts];
  const ids = allProducts.map((p) => p.id);
  const [statsMap, variantsMap, marketplaceMap] = await Promise.all([
    fetchReviewStats(ids),
    fetchVariantsFor(ids),
    fetchMarketplaceStatsFor(ids),
  ]);

  function withStats(products: typeof topProducts) {
    return products.map((p) => {
      const stats = statsMap.get(p.id) ?? { avg: 0, count: 0 };
      return toProduct(p, variantsMap.get(p.id) ?? [], stats.avg, stats.count, marketplaceMap.get(p.id));
    });
  }

  res.json({
    top: withStats(topProducts),
    bottom: withStats(bottomProducts),
  });
}));

router.post("/products/upload-image", requireAuth, requireAdmin, uploadMiddleware.array("images", 4), async (req: ApiRequest, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: "No files uploaded" }); return;
    }
    const rawName = (req.body as any).productName;
    const productName = Array.isArray(rawName) ? String(rawName[0] ?? "") : String(rawName ?? "");
    const slug = productName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    const startIndex = parseInt((req.body as any).startIndex ?? "0") || 0;
    const urls = await Promise.all(files.map((file, idx) => new Promise<string>((resolve, reject) => {
      const absoluteIdx = startIndex + idx;
      const publicId = slug ? `${slug}-${absoluteIdx + 1}-${Date.now()}` : undefined;
      const isPrimary = absoluteIdx === 0;
      const stream = cloudinary.uploader.upload_stream(
        { folder: "envyenhance/products", ...(isPrimary ? {} : { quality: 75, format: "webp" }), ...(publicId ? { public_id: publicId } : {}) },
        (err, result) => {
          if (err || !result) { logger.error({ err: err }, "Cloudinary error"); return reject(err ?? new Error("Upload failed")); }
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
    logger.error({ err }, "Product image upload failed");
    res.status(500).json({ error: "Upload failed" });
  }
});

/**
 * Phase 2: now also returns full seller-listing + nested-variant data for
 * the "Available From N Sellers" section (previously out of scope; the
 * plan explicitly puts it in scope this phase). Reuses
 * routes/sellerListings.ts's buyer-facing query shape/filter (visibility=
 * public AND approvalStatus=approved AND seller.status=active, variant
 * availableQuantity>0 to decide listing inclusion) rather than
 * reimplementing it, so the two endpoints can't silently drift -- see that
 * route's doc comment for the full purchasability-filter rationale and the
 * price-sort/qualifying-variant semantics, which are identical here.
 */
router.get("/products/:id/related", validateParams(GetProductParams, "GetProductParams"), async (req, res) => {
  try {
    const id = req.params.id as unknown as number;  // VAL-MIGRATE-5: validated + coerced
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid product ID" });
      return;
    }

    // Look up the source product to find its categoryId. Returns 404 if the
    // product doesn't exist (or was soft-deleted — buyers never see
    // soft-deleted products, so the related endpoint should behave the
    // same as the product-detail endpoint for consistency).
    const [source] = await db
      .select({ categoryId: productsTable.categoryId })
      .from(productsTable)
      .where(and(eq(productsTable.id, id), isNull(productsTable.deletedAt)));
    if (!source) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    // Parse the `limit` query param — default 4, clamp to [1, 12]. The
    // OpenAPI spec declares the same bounds; this is defense-in-depth.
    const rawLimit = parseInt(String(req.query.limit ?? "4"), 10);
    const limit = Math.min(12, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 4));

    // Fetch up to `limit * 3` candidate products in the same subcategory
    // (excluding the source product), then filter to `limit` after computing
    // stats. We over-fetch because some candidates may have been
    // soft-deleted between the candidate fetch and the stats join — though
    // the WHERE already excludes soft-deleted, so over-fetch is just
    // defensive padding for the stats lookup.
    const candidates = await db
      .select()
      .from(productsTable)
      .where(
        and(
          eq(productsTable.categoryId, source.categoryId),
          sql`${productsTable.id} <> ${id}`,
          isNull(productsTable.deletedAt),
        ),
      )
      .orderBy(desc(productsTable.createdAt))
      .limit(limit);

    if (candidates.length === 0) {
      res.json([]);
      return;
    }

    const candidateIds = candidates.map((p) => p.id);
    const [statsMap, variantsMap, marketplaceMap] = await Promise.all([
      fetchReviewStats(candidateIds),
      fetchVariantsFor(candidateIds),
      fetchMarketplaceStatsFor(candidateIds),
    ]);

    const related = candidates.map((p) => {
      const stats = statsMap.get(p.id) ?? { avg: 0, count: 0 };
      return toProduct(p, variantsMap.get(p.id) ?? [], stats.avg, stats.count, marketplaceMap.get(p.id));
    });

    res.json(related);
  } catch (err) {
    logger.error({ err }, "GET /products/:id/related: failed");
    res.status(500).json({ error: "Failed to fetch related products" });
  }
});

router.get("/products/:id", validateParams(GetProductParams, "GetProductParams"), async (req, res) => {
  try {
    const id = req.params.id as unknown as number;  // VAL-MIGRATE-5: validated + coerced
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid product ID" });
      return;
    }
    const [p] = await db
      .select()
      .from(productsTable)
      .where(and(eq(productsTable.id, id), isNull(productsTable.deletedAt)));
    if (!p) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    // PERF-4: Parallelize variants + stats + marketplace + seller listing
    // cards — all 4 only depend on p.id (already known). Was 3 sequential
    // awaits + 1 Promise.all (4 round-trips); now 1 Promise.all (1 round-trip).
    const [variants, statsResult, marketplaceMap, sellerListingCards] = await Promise.all([
      db
        .select()
        .from(productVariantsTable)
        .where(eq(productVariantsTable.productId, p.id)),
      db
        .select({
          avg: sql<string>`COALESCE(AVG(${reviewsTable.rating}), 0)`,
          count: sql<string>`COUNT(*)`,
        })
        .from(reviewsTable)
        .where(eq(reviewsTable.productId, p.id)),
      fetchMarketplaceStatsFor([p.id]),
      fetchSellerListingCardsFor(p.id),
    ]);
    const stats = statsResult[0];
    res.json({
      ...toProduct(
        p,
        variants,
        Number(Number(stats.avg).toFixed(1)),
        Number(stats.count),
        marketplaceMap.get(p.id),
      ),
      sellerListings: sellerListingCards,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

router.get("/products", asyncHandler(async (req, res) => {
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

  const conditions: SQL[] = [isNull(productsTable.deletedAt)]; // Always exclude soft-deleted
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
  if (search) {
    const searchCond = or(ilike(productsTable.name, `%${search}%`), ilike(productsTable.description, `%${search}%`));
    if (searchCond) conditions.push(searchCond);
  }

  const homepageTagFilter = req.query.homepageTag as string | undefined;
  if (homepageTagFilter) conditions.push(eq(productsTable.homepageTag, homepageTagFilter));

  const where = and(...conditions);

  // ─── PERF: price/rating filters must be applied BEFORE pagination ────────
  //
  // startingPrice and averageRating are computed fields (not columns on
  // productsTable) — they come from productVariantsTable and reviewsTable
  // respectively. The previous code applied LIMIT/OFFSET in SQL first, then
  // filtered in JS — a page of 20 could filter down to 3, and the total
  // count was wrong (`result.length + offset`).
  //
  // When price/rating filters are active, we now fetch ALL matching products
  // (no SQL LIMIT), apply the JS filters, THEN paginate the filtered result.
  // This is correct but fetches more rows when filters are active —
  // acceptable for a catalog of thousands of products. For very large
  // catalogs, a proper SQL fix would compute startingPrice/averageRating as
  // subqueries and filter in SQL — but that's a larger refactor.
  //
  // When NO price/rating filters are active, we keep the efficient SQL
  // LIMIT/OFFSET path with a correct COUNT(*) total.
  const hasPostFilters = (minRating !== null && minRating > 0) || !!minPrice || !!maxPrice;

  if (!hasPostFilters) {
    // ─── Efficient path: no post-fetch filtering needed ────────────────────
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
    const [statsMap, variantsMap, marketplaceMap] = await Promise.all([
      fetchReviewStats(ids),
      fetchVariantsFor(ids),
      fetchMarketplaceStatsFor(ids),
    ]);

    const result = products.map((p) => {
      const stats = statsMap.get(p.id) ?? { avg: 0, count: 0 };
      return toProduct(p, variantsMap.get(p.id) ?? [], stats.avg, stats.count, marketplaceMap.get(p.id));
    });

    const totalNum = Number(total);
    res.json({
      products: result,
      total: totalNum,
      page: pageNum,
      totalPages: Math.ceil(totalNum / limitNum),
    });
    return;
  }

  // ─── Filter path: fetch all matching, filter in JS, paginate result ──────
  const allProducts = await db
    .select()
    .from(productsTable)
    .where(where)
    .orderBy(desc(productsTable.createdAt));

  const allIds = allProducts.map((p) => p.id);
  const [allStatsMap, allVariantsMap, allMarketplaceMap] = await Promise.all([
    fetchReviewStats(allIds),
    fetchVariantsFor(allIds),
    fetchMarketplaceStatsFor(allIds),
  ]);

  let filtered = allProducts.map((p) => {
    const stats = allStatsMap.get(p.id) ?? { avg: 0, count: 0 };
    return toProduct(p, allVariantsMap.get(p.id) ?? [], stats.avg, stats.count, allMarketplaceMap.get(p.id));
  });

  if (minPrice) filtered = filtered.filter((p) => p.startingPrice != null && p.startingPrice >= Number(minPrice));
  if (maxPrice) filtered = filtered.filter((p) => p.startingPrice != null && p.startingPrice <= Number(maxPrice));
  if (minRating !== null && minRating > 0) {
    filtered = filtered.filter((p) => p.averageRating >= minRating);
  }

  const filteredTotal = filtered.length;
  const paged = filtered.slice(offset, offset + limitNum);

  res.json({
    products: paged,
    total: filteredTotal,
    page: pageNum,
    totalPages: Math.ceil(filteredTotal / limitNum),
  });
}));

/**
 * Phase 2: admin creates the product/variety ONLY -- no price/stock/variant
 * data of any kind. A `variants` field in the request body, if present, is
 * silently ignored (not an error) rather than rejected: rejecting it would
 * break any existing admin client that still sends an empty/legacy
 * `variants` array out of habit, for zero benefit, since it's simply never
 * read below. productVariantsTable is not written to by this route at all
 * as of this phase -- sellers create their own price/stock data via
 * seller-listings.ts instead (plan doc's overall goal for this migration).
 */
router.post("/products", requireAdmin, validateBody(CreateProductBody, "CreateProductBody"), async (req: ApiRequest<z.infer<typeof CreateProductBody>>, res) => {
  try {
    // VAL-MIGRATE-5: Zod validates shape (name: string, categoryId: number,
    // description: string, all optional fields typed). Manual typeof/isNaN
    // checks are superseded.
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
    } = req.body as any;  // VAL-MIGRATE-5: cast kept for videoUrl read below

    // VAL-MIGRATE-5: manual checks removed — Zod validates name (string),
    // categoryId (number), description (string) at the schema level.
    const catId = Number(categoryId);

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
        videoUrl: (req.body as any).videoUrl ?? null,
        images: images ?? [],
        homepageTag: homepageTag || null,
      })
      .returning();

    // Invalidate AI cache entries derived from the catalog (best-effort,
    // non-blocking — a missed invalidation just means the AI serves a
    // slightly stale response for up to 5 min, the tool-call TTL).
    invalidateCatalogCache("product.create").catch(() => {});

    res.status(201).json(toProduct(p, [], 0, 0));
  } catch (err) {
    logger.error({ err: err }, "Create product error");
    res.status(500).json({ error: "Failed to create product" });
  }
});

router.put("/products/:id", requireAdmin, validateParams(UpdateProductParams, "UpdateProductParams"), validateBody(UpdateProductBody, "UpdateProductBody"), async (req: ApiRequest<z.infer<typeof UpdateProductBody>>, res) => {
  try {
    const id = req.params.id as unknown as number;  // VAL-MIGRATE-5: validated + coerced
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
    } = req.body as any;

    // Phase 2: a `variants` field in the body, if present, is silently
    // ignored -- same rationale as POST /products above. admin no longer
    // writes to productVariantsTable at all.

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
    if ((req.body as any).videoUrl !== undefined) updates.videoUrl = (req.body as any).videoUrl;
    if (images !== undefined) updates.images = images;
    if (homepageTag !== undefined) updates.homepageTag = homepageTag || null;
    // Phase 5: productStatus is no longer admin-settable. There is no
    // admin-fulfilled inventory path post-Phase-2 -- every product is sold
    // through sellers, so a product-level "in_stock/pre_order/out_of_stock"
    // status has no legitimate meaning to write here. The column itself is
    // left in place (read below only for the legacy notify no-op comment,
    // and by CategoriesTab.tsx's display, being cleaned up separately) but
    // this route no longer accepts client input for it.
    updates.updatedAt = new Date();

    // Read-only as of Phase 2 (admin no longer writes productVariantsTable)
    // -- kept so wasOutOfStock/notifyStockAlerts still function correctly
    // for pre-Phase-2 legacy rows that already have admin variants. For any
    // product created after this phase, `before` will always be [] and this
    // whole notify path is naturally a no-op, not because it was special-
    // cased, but because there's nothing left to read.
    const before = await db
      .select()
      .from(productVariantsTable)
      .where(eq(productVariantsTable.productId, id));
    const wasOutOfStock = before.length > 0 && before.every((v) => v.stock === 0);

    // Read before the write so we know which images (if any) are being
    // dropped by this update -- needed to clean them up in Cloudinary below.
    const [existingProduct] = await db.select().from(productsTable).where(eq(productsTable.id, id)).limit(1);

    const [p] = await db
      .update(productsTable)
      .set(updates)
      .where(eq(productsTable.id, id))
      .returning();
    if (!p) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Only clean up Cloudinary AFTER the DB write succeeded, and only if
    // images were actually part of this update -- otherwise there's nothing
    // to diff. Never let a Cloudinary hiccup fail this request; the DB is
    // already the source of truth and the product was saved successfully.
    if (images !== undefined && existingProduct) {
      cleanupRemovedImages(existingProduct.images ?? [], images).catch(() => {});
    }

    const nowInStock = before.some((v) => v.stock > 0);
    if (wasOutOfStock && nowInStock) {
      notifyStockAlerts(p.id, p.name).catch(() => {});
    }
    // Phase 5: the old productStatus (pre_order -> in_stock) trigger for
    // notifyPreOrderCustomers was removed here -- admin no longer sets
    // productStatus at all (see updates above), so this condition could
    // never fire again anyway. The real trigger now lives in
    // routes/sellerListings.ts's PUT handler, keyed off a seller's variant
    // actually transitioning out of a pending-pre-order state. See that
    // route for the new trigger condition and reasoning.

    const [stats] = await db
      .select({
        avg: sql<string>`COALESCE(AVG(${reviewsTable.rating}), 0)`,
        count: sql<string>`COUNT(*)`,
      })
      .from(reviewsTable)
      .where(eq(reviewsTable.productId, p.id));

    // Invalidate AI cache entries derived from the catalog (best-effort,
    // non-blocking). The product's care info / description may have changed,
    // so any cached `get_product_care` or `search_catalog` responses are
    // now stale. The TTL would catch this in 5 min, but explicit
    // invalidation gives the next user a fresh response immediately.
    invalidateCatalogCache("product.update").catch(() => {});

    res.json(
      toProduct(
        p,
        before,
        Number(Number(stats.avg).toFixed(1)),
        Number(stats.count),
      ),
    );
  } catch (err) {
    logger.error({ err: err }, "Update product error");
    res.status(500).json({ error: "Failed to update product" });
  }
});

router.delete("/products/:id", requireAdmin, validateParams(DeleteProductParams, "DeleteProductParams"), async (req: ApiRequest, res) => {
  try {
    const id = req.params.id as unknown as number;  // VAL-MIGRATE-5: validated + coerced

    // SOFT-DELETE: set deleted_at instead of hard-deleting. This preserves
    // the product row for historical orders/reviews that reference it,
    // while hiding it from all buyer-facing queries (which filter
    // WHERE deleted_at IS NULL — see the GET routes above).
    //
    // Product variants are also soft-deleted (or rather, the product is
    // hidden so its variants are unreachable) — we don't touch
    // productVariantsTable here because a hard-delete would orphan
    // historical order items that reference those variants by ID.
    await db
      .update(productsTable)
      .set({ deletedAt: new Date(), productStatus: "discontinued" })
      .where(eq(productsTable.id, id));

    // Invalidate AI cache: search_catalog / get_product_care responses may
    // have referenced this product. Best-effort, non-blocking.
    invalidateCatalogCache("product.delete").catch(() => {});

    res.json({ message: "Product deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete product" });
  }
});

router.post("/products/:id/duplicate", requireAdmin, validateParams(GetProductParams, "GetProductParams"), async (req: ApiRequest, res) => {
  try {
    const id = req.params.id as unknown as number;  // VAL-MIGRATE-5: validated + coerced
    const [original] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, id))
      .limit(1);

    if (!original) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

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

    // Phase 2: no longer copies productVariantsTable rows -- this route
    // isn't in the prompt's explicit files-to-change list for products.ts,
    // but it's an admin route that was creating NEW productVariantsTable
    // rows, which directly conflicts with "admin will no longer create any
    // variant/price data at all -- not in productVariantsTable, not
    // anywhere." Flagging this as a fix made beyond the explicit list,
    // since leaving it would have been a side door around that rule. A
    // duplicated product now starts with zero variants, same as any
    // admin-created product post-Phase-2; sellers create their own listings
    // against it same as any other product.

    // Invalidate AI cache: a new product is now searchable, so any cached
    // "we don't have X" response is stale. Best-effort, non-blocking.
    invalidateCatalogCache("product.duplicate").catch(() => {});

    res.status(201).json(toProduct(copy, [], 0, 0));
  } catch (err) {
    logger.error({ err }, "Route handler error");
    res.status(500).json({ error: "Failed to duplicate product" });
  }
});

export default router;
