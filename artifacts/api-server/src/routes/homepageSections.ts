import { Router } from "express";
import { db } from "@workspace/db";
import { homepageSectionsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

function toSection(s: typeof homepageSectionsTable.$inferSelect) {
  return {
    id:           s.id,
    key:          s.key,
    label:        s.label,
    displayOrder: s.displayOrder,
    createdAt:    s.createdAt.toISOString(),
    updatedAt:    s.updatedAt.toISOString(),
  };
}

// ── GET /homepage-sections — public, used by homepage + product modal ─────────
router.get("/homepage-sections", async (_req, res) => {
  const sections = await db
    .select()
    .from(homepageSectionsTable)
    .orderBy(asc(homepageSectionsTable.displayOrder), asc(homepageSectionsTable.createdAt));
  res.json(sections.map(toSection));
});

// ── POST /homepage-sections — admin creates a new section ────────────────────
router.post("/homepage-sections", requireAdmin, async (req: any, res) => {
  const { label } = req.body as { label: string };
  if (!label?.trim()) {
    res.status(400).json({ error: "label is required" });
    return;
  }

  // Generate a unique key from label e.g. "Fruit Trees" → "best_fruit_trees"
  const baseKey = "best_" + label.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");

  // Ensure key uniqueness by appending a counter if needed
  const existing = await db.select().from(homepageSectionsTable);
  let key = baseKey;
  let counter = 2;
  while (existing.some(s => s.key === key)) {
    key = `${baseKey}_${counter++}`;
  }

  const maxOrder = existing.reduce((max, s) => Math.max(max, s.displayOrder), -1);

  const [section] = await db
    .insert(homepageSectionsTable)
    .values({ key, label: label.trim(), displayOrder: maxOrder + 1 })
    .returning();

  res.status(201).json(toSection(section));
});

// ── PATCH /homepage-sections/reorder — admin drag-reorders tabs ──────────────
// Body: { ids: number[] }  — ordered array of section ids
router.patch("/homepage-sections/reorder", requireAdmin, async (req: any, res) => {
  const { ids } = req.body as { ids: number[] };
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids array is required" });
    return;
  }

  await Promise.all(
    ids.map((id, index) =>
      db
        .update(homepageSectionsTable)
        .set({ displayOrder: index, updatedAt: new Date() })
        .where(eq(homepageSectionsTable.id, id))
    )
  );

  const updated = await db
    .select()
    .from(homepageSectionsTable)
    .orderBy(asc(homepageSectionsTable.displayOrder));

  res.json(updated.map(toSection));
});

// ── DELETE /homepage-sections/:id — admin deletes a section ─────────────────
router.delete("/homepage-sections/:id", requireAdmin, async (req: any, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  await db.delete(homepageSectionsTable).where(eq(homepageSectionsTable.id, id));
  res.json({ success: true });
});

export default router;
