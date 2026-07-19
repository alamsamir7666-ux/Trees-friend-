import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Category tree — 2 DB levels, 3 browsing levels:
 *
 *  1. Category   (parentId = NULL)   e.g. "Fruit Trees"
 *       Clicking it shows its CHILD SUBCATEGORIES as tiles (Mango, Guava,
 *       Avocado, Banana...) — NOT products directly.
 *
 *  2. Subcategory (parentId = <category id>)  e.g. "Mango"
 *       Clicking it shows the PRODUCTS whose categoryId points here
 *       (Alphonso Mango, Langra Mango, Himsagar Mango...).
 *
 *  3. Product (Alphonso Mango, etc. — lives in products.ts, not here)
 *       Clicking it shows the full product detail page.
 *
 * Rule: products.categoryId ALWAYS points to a subcategory (level 2) row.
 * It never points directly to a top-level category. A category's product
 * listing is computed on the fly by joining through its subcategories —
 * there is no direct category-to-product link stored anywhere.
 *
 * Deletion rule: deleting a subcategory (or a category, which cascades to
 * its subcategories) does NOT delete its products. Any orphaned products
 * are automatically reassigned to a reserved "Uncategorized" subcategory
 * (see uncategorized handling in the categories admin route) so nothing
 * is ever silently lost.
 */
export const categoriesTable = pgTable("categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),        // "Fruit Trees" (L1) or "Mango" (L2)
  slug: text("slug").notNull().unique(),
  description: text("description"),
  icon: text("icon"),
  iconImage: text("icon_image"), // uploaded icon, alternative to emoji
  image: text("image"),
  displayOrder: integer("display_order").notNull().default(0),
  // NULL = top-level category. Set = subcategory nested under that category.
  parentId: integer("parent_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCategorySchema = createInsertSchema(categoriesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCategory = z.infer<typeof insertCategorySchema>;
export type Category = typeof categoriesTable.$inferSelect;
