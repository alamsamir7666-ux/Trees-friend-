import { Router } from "express";
import { db } from "@workspace/db";
import { categoriesTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";

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

  const [c] = await db
    .update(categoriesTable)
    .set(updates)
    .where(eq(categoriesTable.id, id))
    .returning();
  if (!c) { res.status(404).json({ error: "Not found" }); return; }
  res.json(toCategory(c));
});

router.delete("/categories/:id", requireAdmin, async (req: any, res) => {
  const id = parseInt(req.params.id);
  await db.delete(categoriesTable).where(eq(categoriesTable.id, id));
  res.json({ message: "Category deleted" });
});

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
