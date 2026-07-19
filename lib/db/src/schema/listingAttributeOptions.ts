import { pgTable, serial, integer, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { categoriesTable } from "./categories";

/**
 * Controlled option sets for seller_listings' comparison-critical fields
 * (height, pot_size, age, root_type). Without this, "2ft" vs "2 feet" vs
 * "24 inch" break filter/sort across sellers on the same variety.
 *
 * Scoped per SUBCATEGORY (categoryId here points to a categoriesTable row
 * with parentId set, e.g. "Mango"), not globally -- a mango's realistic
 * height range doesn't apply to a succulent.
 *
 * Enforce at the API layer: validate submitted seller_listings values
 * exist here for that category/attribute before accepting a write. Client
 * dropdowns alone don't stop direct API calls.
 *
 * Adding a new category requires admin to seed its option sets as part of
 * category creation -- one-time per category, part of the "create
 * category" admin flow.
 */
export const listingAttributeOptionsTable = pgTable("listing_attribute_options", {
  id: serial("id").primaryKey(),
  categoryId: integer("category_id")
    .notNull()
    .references(() => categoriesTable.id, { onDelete: "cascade" }),
  attributeName: text("attribute_name").notNull(), // "height" | "pot_size" | "age" | "root_type"
  value: text("value").notNull(), // e.g. "2-3 ft", "12 inch", "1-1.5 years", "Grafted"
  displayOrder: integer("display_order").notNull().default(0),
});

export const insertListingAttributeOptionSchema = createInsertSchema(
  listingAttributeOptionsTable,
).omit({
  id: true,
});
export type InsertListingAttributeOption = z.infer<typeof insertListingAttributeOptionSchema>;
export type ListingAttributeOption = typeof listingAttributeOptionsTable.$inferSelect;
