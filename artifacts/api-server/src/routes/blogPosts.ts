import { Router } from "express";
import { db } from "@workspace/db";
import { blogPostsTable, productsTable, productVariantsTable } from "@workspace/db";
import { eq, desc, inArray } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import { logAudit } from "../lib/audit";

const router = Router();

function fmtPost(p: typeof blogPostsTable.$inferSelect, linkedProducts: any[] = []) {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    excerpt: p.excerpt,
    content: (() => { try { return JSON.parse(p.content); } catch { return []; } })(),
    category: p.category,
    readTime: p.readTime,
    image: p.image,
    featured: p.featured,
    publishedAt: p.publishedAt,
    linkedProductIds: (() => { try { return JSON.parse(p.linkedProductIds); } catch { return []; } })(),
    linkedProducts,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

async function resolveLinkedProducts(post: typeof blogPostsTable.$inferSelect) {
  let ids: number[] = [];
  try { ids = JSON.parse(post.linkedProductIds); } catch { ids = []; }
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

  const variantRows = await db
    .select()
    .from(productVariantsTable)
    .where(inArray(productVariantsTable.productId, rows.map((r) => r.id)));
  const variantsByProduct = new Map<number, typeof variantRows>();
  for (const v of variantRows) {
    const list = variantsByProduct.get(v.productId) ?? [];
    list.push(v);
    variantsByProduct.set(v.productId, list);
  }

  const withPricing = rows.map((r) => {
    const variants = variantsByProduct.get(r.id) ?? [];
    const effectivePrices = variants.map((v) => v.discountPrice != null ? Number(v.discountPrice) : Number(v.price));
    const startingPrice = effectivePrices.length > 0 ? Math.min(...effectivePrices) : null;
    const inStock = variants.some((v) => v.stock > 0);
    return { ...r, startingPrice, inStock };
  });

  // preserve admin-selected order
  const byId = new Map(withPricing.map(r => [r.id, r]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}

// GET /blog-posts — public list
router.get("/blog-posts", async (_req, res) => {
  try {
    const posts = await db.select().from(blogPostsTable).orderBy(desc(blogPostsTable.createdAt));
    res.json(posts.map(p => fmtPost(p)));
  } catch { res.status(500).json({ error: "Failed to fetch blog posts" }); }
});

// GET /blog-posts/:slug — public single post
router.get("/blog-posts/:slug", async (req, res) => {
  try {
    const [post] = await db.select().from(blogPostsTable).where(eq(blogPostsTable.slug, req.params.slug)).limit(1);
    if (!post) { res.status(404).json({ error: "Post not found" }); return; }
    const linkedProducts = await resolveLinkedProducts(post);
    res.json(fmtPost(post, linkedProducts));
  } catch { res.status(500).json({ error: "Failed to fetch blog post" }); }
});

// POST /admin/blog-posts — create
router.post("/admin/blog-posts", requireAdmin, async (req: any, res) => {
  try {
    const { slug, title, excerpt, content, category, readTime, image, featured, publishedAt, linkedProductIds } = req.body;
    if (!slug?.trim() || !title?.trim() || !excerpt?.trim() || !category?.trim()) {
      res.status(400).json({ error: "slug, title, excerpt and category are required" }); return;
    }
    if (linkedProductIds !== undefined && (!Array.isArray(linkedProductIds) || linkedProductIds.length > 3)) {
      res.status(400).json({ error: "linkedProductIds must be an array of at most 3 product ids" }); return;
    }
    const [post] = await db.insert(blogPostsTable).values({
      slug: slug.trim().toLowerCase().replace(/\s+/g, "-"),
      title: title.trim(),
      excerpt: excerpt.trim(),
      content: JSON.stringify(content ?? []),
      category: category.trim(),
      readTime: readTime?.trim() || "5 min read",
      image: image?.trim() || "",
      featured: featured ?? false,
      publishedAt: publishedAt?.trim() || new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      linkedProductIds: JSON.stringify(linkedProductIds ?? []),
    }).returning();
    const linkedProducts = await resolveLinkedProducts(post);
    res.status(201).json(fmtPost(post, linkedProducts));
  } catch (err: any) {
    if (err?.code === "23505") { res.status(409).json({ error: "A post with this slug already exists" }); return; }
    res.status(500).json({ error: "Failed to create blog post" });
  }
});

// PATCH /admin/blog-posts/:id — update
router.patch("/admin/blog-posts/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
    const { slug, title, excerpt, content, category, readTime, image, featured, publishedAt, linkedProductIds } = req.body;
    if (linkedProductIds !== undefined && (!Array.isArray(linkedProductIds) || linkedProductIds.length > 3)) {
      res.status(400).json({ error: "linkedProductIds must be an array of at most 3 product ids" }); return;
    }
    const updates: Record<string, any> = { updatedAt: new Date() };
    if (slug !== undefined) updates.slug = slug.trim().toLowerCase().replace(/\s+/g, "-");
    if (title !== undefined) updates.title = title.trim();
    if (excerpt !== undefined) updates.excerpt = excerpt.trim();
    if (content !== undefined) updates.content = JSON.stringify(content);
    if (category !== undefined) updates.category = category.trim();
    if (readTime !== undefined) updates.readTime = readTime.trim();
    if (image !== undefined) updates.image = image.trim();
    if (featured !== undefined) updates.featured = featured;
    if (publishedAt !== undefined) updates.publishedAt = publishedAt.trim();
    if (linkedProductIds !== undefined) updates.linkedProductIds = JSON.stringify(linkedProductIds);
    const [updated] = await db.update(blogPostsTable).set(updates).where(eq(blogPostsTable.id, id)).returning();
    if (!updated) { res.status(404).json({ error: "Post not found" }); return; }
    const linkedProducts = await resolveLinkedProducts(updated);
    res.json(fmtPost(updated, linkedProducts));
  } catch { res.status(500).json({ error: "Failed to update blog post" }); }
});

// DELETE /admin/blog-posts/:id — delete
router.delete("/admin/blog-posts/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
    await db.delete(blogPostsTable).where(eq(blogPostsTable.id, id));
    res.json({ message: "Blog post deleted" });
  } catch { res.status(500).json({ error: "Failed to delete blog post" }); }
});

export default router;
