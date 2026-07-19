import { Router } from "express";
import { db } from "@workspace/db";
import { listingAttributeOptionsTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

const VALID_ATTRIBUTE_NAMES = ["height", "pot_size", "age", "root_type"];

function toOption(o: typeof listingAttributeOptionsTable.$inferSelect) {
  return {
    id: o.id,
    categoryId: o.categoryId,
    attributeName: o.attributeName,
    value: o.value,
    displayOrder: o.displayOrder,
  };
}

/**
 * Public: fetch the controlled option set for a single category (a
 * subcategory, e.g. "Mango"), optionally filtered to one attribute. Used by
 * the seller upload-listing form to render height/pot_size/age/root_type as
 * dropdowns instead of free text (plan doc §3a). No auth required -- same
 * trust level as GET /categories, since this is just taxonomy data, not
 * anything seller- or order-specific.
 */
router.get("/categories/:categoryId/listing-attribute-options", async (req: any, res) => {
  try {
    const categoryId = parseInt(req.params.categoryId);
    if (isNaN(categoryId) || categoryId <= 0) {
      res.status(400).json({ error: "Invalid category id" });
      return;
    }
    const { attributeName } = req.query as { attributeName?: string };
    if (attributeName !== undefined && !VALID_ATTRIBUTE_NAMES.includes(attributeName)) {
      res.status(400).json({ error: `attributeName must be one of ${VALID_ATTRIBUTE_NAMES.join(", ")}` });
      return;
    }

    const rows = await db
      .select()
      .from(listingAttributeOptionsTable)
      .where(
        attributeName
          ? and(
              eq(listingAttributeOptionsTable.categoryId, categoryId),
              eq(listingAttributeOptionsTable.attributeName, attributeName),
            )
          : eq(listingAttributeOptionsTable.categoryId, categoryId),
      )
      .orderBy(asc(listingAttributeOptionsTable.attributeName), asc(listingAttributeOptionsTable.displayOrder));

    res.json(rows.map(toOption));
  } catch (err) {
    console.error("List listing attribute options error:", err);
    res.status(500).json({ error: "Failed to fetch listing attribute options" });
  }
});

/**
 * Admin: add a single option value to a category/attribute pair (e.g. add
 * "3-4 ft" to Mango's height options). Per plan doc §3a, admin is expected
 * to seed a category's full option sets as part of creating that category --
 * this endpoint is the one-at-a-time primitive that a bulk-seed UI or script
 * would call repeatedly, not a bulk endpoint itself.
 */
router.post("/admin/listing-attribute-options", requireAdmin, async (req, res) => {
  try {
    const { categoryId, attributeName, value, displayOrder } = req.body as {
      categoryId?: number;
      attributeName?: string;
      value?: string;
      displayOrder?: number;
    };

    if (!categoryId || isNaN(Number(categoryId))) {
      res.status(400).json({ error: "categoryId is required" });
      return;
    }
    if (!attributeName || !VALID_ATTRIBUTE_NAMES.includes(attributeName)) {
      res.status(400).json({ error: `attributeName must be one of ${VALID_ATTRIBUTE_NAMES.join(", ")}` });
      return;
    }
    if (!value || typeof value !== "string" || !value.trim()) {
      res.status(400).json({ error: "value is required" });
      return;
    }

    const [o] = await db
      .insert(listingAttributeOptionsTable)
      .values({
        categoryId: Number(categoryId),
        attributeName,
        value: value.trim(),
        displayOrder: displayOrder ?? 0,
      })
      .returning();

    res.status(201).json(toOption(o));
  } catch (err) {
    console.error("Create listing attribute option error:", err);
    res.status(500).json({ error: "Failed to create listing attribute option" });
  }
});

router.put("/admin/listing-attribute-options/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid option id" });
      return;
    }
    const { value, displayOrder } = req.body as { value?: string; displayOrder?: number };
    const updates: Record<string, unknown> = {};
    if (value !== undefined) {
      if (typeof value !== "string" || !value.trim()) {
        res.status(400).json({ error: "value cannot be empty" });
        return;
      }
      updates.value = value.trim();
    }
    if (displayOrder !== undefined) updates.displayOrder = displayOrder;

    const [o] = await db
      .update(listingAttributeOptionsTable)
      .set(updates)
      .where(eq(listingAttributeOptionsTable.id, id))
      .returning();
    if (!o) {
      res.status(404).json({ error: "Option not found" });
      return;
    }
    res.json(toOption(o));
  } catch (err) {
    console.error("Update listing attribute option error:", err);
    res.status(500).json({ error: "Failed to update listing attribute option" });
  }
});

/**
 * Admin: delete an option value. Existing seller_listings rows that already
 * reference this value in a text column (height/potSize/age/rootType) are
 * NOT retroactively invalidated -- this only removes it from future
 * dropdowns/validation, matching how removing a coupon doesn't unwind past
 * orders that used it.
 */
router.delete("/admin/listing-attribute-options/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid option id" });
      return;
    }
    await db.delete(listingAttributeOptionsTable).where(eq(listingAttributeOptionsTable.id, id));
    res.json({ message: "Option deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete listing attribute option" });
  }
});

export default router;
