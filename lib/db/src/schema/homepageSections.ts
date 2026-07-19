import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Homepage Sections — admin-created tabs for the "Best Plants & Trees" section.
 *
 * Admin creates sections (e.g. "Fruit Trees") here.
 * Each section gets a unique key (e.g. "best_fruit_trees") used as homepageTag on products.
 * displayOrder controls drag-reordered tab position on the homepage.
 */
export const homepageSectionsTable = pgTable("homepage_sections", {
  id:           serial("id").primaryKey(),
  key:          text("key").notNull().unique(),   // e.g. "best_fruit_trees"
  label:        text("label").notNull(),          // e.g. "Fruit Trees"
  displayOrder: integer("display_order").notNull().default(0),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
});

export const insertHomepageSectionSchema = createInsertSchema(homepageSectionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertHomepageSection = z.infer<typeof insertHomepageSectionSchema>;
export type HomepageSection = typeof homepageSectionsTable.$inferSelect;
