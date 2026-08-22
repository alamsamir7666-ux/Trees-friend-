import { Router } from "express";
import type { z } from "zod";
import { db } from "@workspace/db";
import {
  blogPostsTable,
  productsTable,
  productVariantsTable,
  sellerListingsTable,
  sellerListingVariantsTable,
  sellersTable,
} from "@workspace/db";
import { normalizeSlug } from "@workspace/db/logic";
import { eq, desc, and, inArray } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import { isPgError, PG_ERROR_CODE, asyncHandler, HttpError } from "../lib/errors";
import { validateBody, validateParams } from "../lib/validateRequest";
import { CreateBlogPostBody, UpdateBlogPostBody, IdParam } from "../lib/schemas";
import type { ApiRequest } from "../types/apiRequest";

/**
 * Parse arbitrary admin input into a valid integer read time (minutes).
 *
 * Mirrors the frontend `parseReadTimeInput` in
 * `tree-friend/src/lib/blog.ts` so both layers agree on parsing rules.
 *
 * Extracts the FIRST contiguous run of digits — so "10-15 minutes" → 10
 * (not 1015, which the old `replace(/\D/g, "")` produced). Clamps to
 * [1, 600]. Returns 5 (default) if no digits are found.
 */
function parseReadTimeInput(input: unknown): number {
  if (input == null) return 5;
  if (typeof input === "number" && Number.isFinite(input)) {
    return Math.min(600, Math.max(1, Math.floor(input)));
  }
  const str = String(input).trim();
  if (str === "") return 5;
  const match = str.match(/\d+/);
  if (!match) return 5;
  const n = parseInt(match[0], 10);
  if (!Number.isFinite(n)) return 5;
  return Math.min(600, Math.max(1, n));
}

const router = Router();

function fmtPost(p: typeof blogPostsTable.$inferSelect, linkedProducts: any[] = []) {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    excerpt: p.excerpt,
    // Migration 0011: `content` is now native `jsonb`, so no JSON.parse
    // needed — Drizzle returns the parsed array directly. Coalesce to []
    // defensively in case a row somehow has NULL (shouldn't happen — column
    // is NOT NULL with DEFAULT '[]').
    content: Array.isArray(p.content) ? p.content : [],
    category: p.category,
    readTime: p.readTime,
    image: p.image,
    featured: p.featured,
    publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    linkedProductIds: p.linkedProductIds,
    linkedProducts,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

async function resolveLinkedProducts(post: typeof blogPostsTable.$inferSelect) {
  const ids = post.linkedProductIds;
  if (!Array.isArray(ids) || ids.length === 0) return [];

  const rows = await db
    .select({
      id: productsTable.id,
      name: productsTable.name,
      slug: productsTable.slug,
      images: productsTable.images,
    })
    .from(productsTable)
    .where(inArray(productsTable.id, ids));

  const productIds = rows.map((r) => r.id);

  const variantRows = await db
    .select()
    .from(productVariantsTable)
    .where(inArray(productVariantsTable.productId, productIds));
  const variantsByProduct = new Map<number, typeof variantRows>();
  for (const v of variantRows) {
    const list = variantsByProduct.get(v.productId) ?? [];
    list.push(v);
    variantsByProduct.set(v.productId, list);
  }

  // Phase 2 marketplace fallback -- same rationale as routes/search.ts and
  // routes/wishlist.ts: admin variants are legacy-only going forward, so a
  // linked product with none needs a marketplace-sourced price/stock
  // signal or "Related Products" on every new blog post would show no
  // price at all.
  const listingRows = productIds.length > 0
    ? await db
        .select({
          productId: sellerListingsTable.productId,
          price: sellerListingVariantsTable.price,
          discountPrice: sellerListingVariantsTable.discountPrice,
          availableQuantity: sellerListingVariantsTable.availableQuantity,
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
          ),
        )
    : [];
  const listingsByProduct = new Map<number, typeof listingRows>();
  for (const r of listingRows) {
    const list = listingsByProduct.get(r.productId) ?? [];
    list.push(r);
    listingsByProduct.set(r.productId, list);
  }

  const withPricing = rows.map((r) => {
    const variants = variantsByProduct.get(r.id) ?? [];
    const effectivePrices = variants.map((v) => v.discountPrice != null ? Number(v.discountPrice) : Number(v.price));
    const adminPrice = effectivePrices.length > 0 ? Math.min(...effectivePrices) : null;
    const adminInStock = variants.some((v) => v.stock > 0);

    const listings = listingsByProduct.get(r.id) ?? [];
    const qualifyingListings = listings.filter((l) => l.availableQuantity > 0);
    const listingPrices = qualifyingListings.map((l) => l.discountPrice != null ? Number(l.discountPrice) : Number(l.price));
    const marketplacePrice = listingPrices.length > 0 ? Math.min(...listingPrices) : null;
    const marketplaceInStock = qualifyingListings.length > 0;

    const startingPrice = adminPrice ?? marketplacePrice;
    const inStock = variants.length > 0 ? adminInStock : marketplaceInStock;
    return { ...r, startingPrice, inStock };
  });

  // preserve admin-selected order
  const byId = new Map(withPricing.map(r => [r.id, r]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}

// GET /blog-posts — public list
router.get("/blog-posts", asyncHandler(async (_req, res) => {
  const posts = await db.select().from(blogPostsTable).orderBy(desc(blogPostsTable.createdAt));
  res.json(posts.map(p => fmtPost(p)));
}));

// GET /blog-posts/:slug — public single post
router.get("/blog-posts/:slug", asyncHandler(async (req, res) => {
  const [post] = await db.select().from(blogPostsTable).where(eq(blogPostsTable.slug, req.params.slug)).limit(1);
  if (!post) throw new HttpError(404, "Post not found");
  const linkedProducts = await resolveLinkedProducts(post);
  res.json(fmtPost(post, linkedProducts));
}));

// POST /admin/blog-posts — create
router.post(
  "/admin/blog-posts",
  requireAdmin,
  validateBody(CreateBlogPostBody, "CreateBlogPostBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof CreateBlogPostBody>>, res) => {
    const { slug, title, excerpt, content, category, readTime, image, featured, publishedAt, linkedProductIds } = req.body;
    try {
      const [post] = await db.insert(blogPostsTable).values({
        slug: normalizeSlug(slug),
        title: title.trim(),
        excerpt: excerpt?.trim() ?? "",
        content: Array.isArray(content) ? content : [],
        category: category?.trim() ?? "",
        readTime: parseReadTimeInput(readTime),
        image: image?.trim() || "",
        featured: featured ?? false,
        publishedAt: publishedAt ? new Date(publishedAt) : null,
        linkedProductIds: linkedProductIds ?? [],
      }).returning();
      const linkedProducts = await resolveLinkedProducts(post);
      res.status(201).json(fmtPost(post, linkedProducts));
    } catch (err) {
      if (isPgError(err) && err.code === PG_ERROR_CODE.UNIQUE_VIOLATION) {
        throw new HttpError(409, "A post with this slug already exists");
      }
      throw err;
    }
  }),
);

// PATCH /admin/blog-posts/:id — update
router.patch(
  "/admin/blog-posts/:id",
  requireAdmin,
  validateParams(IdParam, "IdParam"),
  validateBody(UpdateBlogPostBody, "UpdateBlogPostBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof UpdateBlogPostBody>, z.infer<typeof IdParam>>, res) => {
    const { id } = req.params;
    const body = req.body;
    const updates: Partial<typeof blogPostsTable.$inferInsert> = { updatedAt: new Date() };
    if (body.slug !== undefined) updates.slug = normalizeSlug(body.slug);
    if (body.title !== undefined) updates.title = body.title.trim();
    if (body.excerpt !== undefined) updates.excerpt = body.excerpt?.trim() ?? "";
    if (body.content !== undefined) updates.content = Array.isArray(body.content) ? body.content : [];
    if (body.category !== undefined) updates.category = body.category?.trim() ?? "";
    if (body.readTime !== undefined) {
      updates.readTime = parseReadTimeInput(body.readTime);
    }
    if (body.image !== undefined) updates.image = body.image?.trim() || "";
    if (body.featured !== undefined) updates.featured = body.featured;
    if (body.publishedAt !== undefined) {
      updates.publishedAt = body.publishedAt ? new Date(body.publishedAt) : null;
    }
    if (body.linkedProductIds !== undefined) updates.linkedProductIds = body.linkedProductIds ?? [];
    const [updated] = await db.update(blogPostsTable).set(updates).where(eq(blogPostsTable.id, id)).returning();
    if (!updated) throw new HttpError(404, "Post not found");
    const linkedProducts = await resolveLinkedProducts(updated);
    res.json(fmtPost(updated, linkedProducts));
  }),
);

// DELETE /admin/blog-posts/:id — delete
router.delete(
  "/admin/blog-posts/:id",
  requireAdmin,
  validateParams(IdParam, "IdParam"),
  asyncHandler(async (req: ApiRequest<unknown, z.infer<typeof IdParam>>, res) => {
    const { id } = req.params;
    await db.delete(blogPostsTable).where(eq(blogPostsTable.id, id));
    res.json({ message: "Blog post deleted" });
  }),
);

export default router;
