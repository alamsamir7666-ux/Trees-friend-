import { Router } from "express";
import { db } from "@workspace/db";
import { categoriesTable, productsTable } from "@workspace/db";
import { eq, asc, inArray } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import { deleteCloudinaryAssets } from "../lib/cloudinary";

const router = Router();

function toCategory(c: typeof categoriesTable.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    icon: c.icon,
    iconImage: (c as any).iconImage ?? null,
    image: c.image,
    displayOrder: c.displayOrder,
    parentId: (c as any).parentId ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

router.get("/categories", async (_req, res) => {
  const t0 = Date.now();
  const cats = await db
    .select()
    .from(categoriesTable)
    .orderBy(asc(categoriesTable.displayOrder), asc(categoriesTable.name));
  const t1 = Date.now();
  console.log("[timing] /categories DB query took", t1 - t0, "ms");
  res.json(cats.map(toCategory));
  const t2 = Date.now();
  console.log("[timing] /categories serialize+send took", t2 - t1, "ms, total handler:", t2 - t0, "ms");
});

router.post("/categories", requireAdmin, async (req: any, res) => {
  const { name, slug, icon, iconImage, image, displayOrder, parentId } = req.body;
  const generatedSlug = slug || name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const [c] = await db
    .insert(categoriesTable)
    .values({ name, slug: generatedSlug, icon: icon || null, iconImage: iconImage || null, image: image || null, displayOrder: displayOrder ?? 0, parentId: parentId || null })
    .returning();
  res.status(201).json(toCategory(c));
});

router.put("/categories/:id", requireAdmin, async (req: any, res) => {
  const id = parseInt(req.params.id);
  const { name, slug, icon, iconImage, image, displayOrder, parentId } = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name;
  if (slug !== undefined) updates.slug = slug;
  if (icon !== undefined) updates.icon = icon;
  if (iconImage !== undefined) (updates as any).iconImage = iconImage;
  if (image !== undefined) updates.image = image;
  if (displayOrder !== undefined) updates.displayOrder = displayOrder;
  if (parentId !== undefined) (updates as any).parentId = parentId || null;

  // Fetch before the write so we can tell which image(s), if any, this
  // update is replacing/clearing -- needed to clean them up in Cloudinary
  // below. iconImage and image are single URLs here (not arrays like
  // products/listings), so each is just an old-vs-new string comparison.
  const [existingCategory] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, id)).limit(1);

  const [c] = await db
    .update(categoriesTable)
    .set(updates)
    .where(eq(categoriesTable.id, id))
    .returning();
  if (!c) { res.status(404).json({ error: "Not found" }); return; }

  // Best-effort cleanup after the DB write succeeds. Only runs for fields
  // this request actually touched and only when the value actually changed
  // (e.g. cleared to null, or replaced with a newly-uploaded image) --
  // never blocks/fails the response.
  if (existingCategory) {
    const removed: string[] = [];
    if (iconImage !== undefined && existingCategory.iconImage && existingCategory.iconImage !== iconImage) {
      removed.push(existingCategory.iconImage);
    }
    if (image !== undefined && existingCategory.image && existingCategory.image !== image) {
      removed.push(existingCategory.image);
    }
    if (removed.length > 0) {
      deleteCloudinaryAssets(removed).catch(() => {});
    }
  }

  res.json(toCategory(c));
});

router.delete("/categories/:id", requireAdmin, async (req: any, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid category id" });
    return;
  }

  const [target] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, id)).limit(1);
  if (!target) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (target.slug === "uncategorized" || target.slug === "uncategorized-general") {
    res.status(400).json({ error: "The reserved Uncategorized category can't be deleted" });
    return;
  }

  try {
    const imagesToClean: string[] = [];

    await db.transaction(async (tx) => {
      // Collect every subcategory row that's about to be deleted along with
      // `target` itself -- if `target` is top-level (parentId null), that's
      // all its children; if `target` is already a subcategory, it's just
      // itself. listing_attribute_options has a real DB-level FK with
      // onDelete: cascade (see schema/listingAttributeOptions.ts), so those
      // rows clean themselves up automatically -- nothing to do for them
      // here. products.categoryId has NO such FK, so any product pointing
      // at a deleted subcategory needs to be explicitly reassigned first or
      // it's left silently pointing at a row that no longer exists.
      const children = target.parentId == null
        ? await tx.select().from(categoriesTable).where(eq(categoriesTable.parentId, target.id))
        : [];
      const subcategoriesBeingDeleted = target.parentId == null ? children : [target];

      if (subcategoriesBeingDeleted.length > 0) {
        const uncategorized = await getOrCreateUncategorizedSubcategory(tx);
        const subIds = subcategoriesBeingDeleted.map((c) => c.id);
        await tx
          .update(productsTable)
          .set({ categoryId: uncategorized.id, updatedAt: new Date() })
          .where(inArray(productsTable.categoryId, subIds));
      }

      // Queue images for cleanup (done outside the transaction, after
      // commit -- Cloudinary isn't transactional and shouldn't block or be
      // rolled back by a DB-side failure).
      for (const c of [target, ...children]) {
        if (c.iconImage) imagesToClean.push(c.iconImage);
        if (c.image) imagesToClean.push(c.image);
      }

      // Delete children first (each is a subcategory with no further
      // children of its own -- categories are only 2 levels deep per the
      // table's doc comment), then the target itself.
      if (children.length > 0) {
        await tx.delete(categoriesTable).where(eq(categoriesTable.parentId, target.id));
      }
      await tx.delete(categoriesTable).where(eq(categoriesTable.id, target.id));
    });

    if (imagesToClean.length > 0) {
      deleteCloudinaryAssets(imagesToClean).catch(() => {});
    }

    res.json({ message: "Category deleted" });
  } catch (err) {
    console.error("Delete category error:", err);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

/**
 * Products must always point at a subcategory (schema rule, see table doc
 * comment) -- so the fallback for "the subcategory a product belonged to
 * just got deleted" has to itself be a real subcategory, not a top-level
 * category. Lazily creates a single global "Uncategorized" top-level
 * category + "Uncategorized" subcategory pair the first time it's needed,
 * then reuses it on every subsequent delete. Slugs are fixed/well-known so
 * concurrent calls converge on the same row (onConflictDoNothing +
 * re-select) rather than racing to create duplicates.
 */
async function getOrCreateUncategorizedSubcategory(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
  const PARENT_SLUG = "uncategorized";
  const CHILD_SLUG = "uncategorized-general";

  let [parent] = await tx.select().from(categoriesTable).where(eq(categoriesTable.slug, PARENT_SLUG)).limit(1);
  if (!parent) {
    await tx
      .insert(categoriesTable)
      .values({ name: "Uncategorized", slug: PARENT_SLUG, parentId: null, displayOrder: -1 })
      .onConflictDoNothing({ target: categoriesTable.slug });
    [parent] = await tx.select().from(categoriesTable).where(eq(categoriesTable.slug, PARENT_SLUG)).limit(1);
  }

  let [child] = await tx.select().from(categoriesTable).where(eq(categoriesTable.slug, CHILD_SLUG)).limit(1);
  if (!child) {
    await tx
      .insert(categoriesTable)
      .values({ name: "Uncategorized", slug: CHILD_SLUG, parentId: parent.id, displayOrder: -1 })
      .onConflictDoNothing({ target: categoriesTable.slug });
    [child] = await tx.select().from(categoriesTable).where(eq(categoriesTable.slug, CHILD_SLUG)).limit(1);
  }

  return child;
}

router.post("/categories/seed", requireAdmin, async (_req, res) => {
  const defaults: { name: string; slug: string; icon: string; displayOrder: number }[] = [];
  const inserted: ReturnType<typeof toCategory>[] = [];
  for (const cat of defaults) {
    try {
      const [c] = await db
        .insert(categoriesTable)
        .values(cat)
        .onConflictDoNothing()
        .returning();
      if (c) inserted.push(toCategory(c));
    } catch (_) {}
  }
  res.json({ inserted: inserted.length, categories: inserted });
});

export default router;
