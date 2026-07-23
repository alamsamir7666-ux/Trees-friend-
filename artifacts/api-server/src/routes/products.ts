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
  sellerListingsTable,
  sellerListingVariantsTable,
  sellersTable,
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
};

const EMPTY_MARKETPLACE_STATS: MarketplaceStats = {
  listingMinPrice: null,
  listingMaxPrice: null,
  listingCount: 0,
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
 * variant.availableQuantity>0. Mirrors the exact purchasability filter
 * routes/sellerListings.ts's buyer-facing GET
 * /products/:productId/seller-listings uses (reused conceptually, not
 * imported, since that route works per-product while this one batches
 * across an arbitrary product id list for list/browse pages).
 *
 * listingCount = number of DISTINCT LISTINGS (sellers) with at least one
 * qualifying variant for that product, not number of variants -- a seller
 * with 2 in-stock variants still counts once toward "Available From N
 * Sellers".
 */
async function fetchMarketplaceStatsFor(productIds: number[]): Promise<Map<number, MarketplaceStats>> {
  if (productIds.length === 0) return new Map();

  const rows = await db
    .select({
      productId: sellerListingsTable.productId,
      sellerListingId: sellerListingsTable.id,
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
    );

  const byProduct = new Map<number, { prices: number[]; listingIds: Set<number> }>();
  for (const r of rows) {
    const entry = byProduct.get(r.productId) ?? { prices: [], listingIds: new Set<number>() };
    const price = r.discountPrice != null ? Number(r.discountPrice) : Number(r.price);
    entry.prices.push(price);
    entry.listingIds.add(r.sellerListingId);
    byProduct.set(r.productId, entry);
  }

  const map = new Map<number, MarketplaceStats>();
  for (const [productId, entry] of byProduct) {
    map.set(productId, {
      listingMinPrice: entry.prices.length > 0 ? Math.min(...entry.prices) : null,
      listingMaxPrice: entry.prices.length > 0 ? Math.max(...entry.prices) : null,
      listingCount: entry.listingIds.size,
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
        },
        rating: stats.avg,
        reviewCount: stats.count,
      };
    })
    .filter((card) => card.hasQualifyingVariant)
    .map(({ hasQualifyingVariant, ...card }) => card);
}

router.get("/products/featured", async (_req, res) => {
  try {
    const products = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.homepageTag, "trending"))
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
    const [marketplaceMap, sellerListingCards] = await Promise.all([
      fetchMarketplaceStatsFor([p.id]),
      fetchSellerListingCardsFor(p.id),
    ]);
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
    const [statsMap, variantsMap, marketplaceMap] = await Promise.all([
      fetchReviewStats(ids),
      fetchVariantsFor(ids),
      fetchMarketplaceStatsFor(ids),
    ]);

    let result = products.map((p) => {
      const stats = statsMap.get(p.id) ?? { avg: 0, count: 0 };
      return toProduct(p, variantsMap.get(p.id) ?? [], stats.avg, stats.count, marketplaceMap.get(p.id));
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

    res.status(201).json(toProduct(p, [], 0, 0));
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
    } = req.body;

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
    if (req.body.videoUrl !== undefined) updates.videoUrl = req.body.videoUrl;
    if (images !== undefined) updates.images = images;
    if (homepageTag !== undefined) updates.homepageTag = homepageTag || null;
    if (req.body.productStatus !== undefined) updates.productStatus = req.body.productStatus;
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

    const nowInStock = before.some((v) => v.stock > 0);
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
        before,
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
    res.status(201).json(toProduct(copy, [], 0, 0));
  } catch {
    res.status(500).json({ error: "Failed to duplicate product" });
  }
});

export default router;
