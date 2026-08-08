import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { categoriesTable } from "./categories";

/**
 * A product is one named variety, e.g. "Alphonso Mango", "Honeycrisp Apple".
 * It has NO price/stock of its own -- those always live on productVariants
 * (seed / sapling / grafted / potted), each with its own price, stock, and
 * deliveryCharge. A product must have at least one variant to be sellable.
 *
 * categoryId always points to a SUBCATEGORY row in categoriesTable
 * (e.g. "Mango" under "Fruit Trees"), never a top-level category.
 */
export const productsTable = pgTable(
  "products",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),

    categoryId: integer("category_id")
      .notNull()
      .references(() => categoriesTable.id, { onDelete: "restrict" }),

    scientificName: text("scientific_name"),      // e.g. "Mangifera indica"
    description: text("description").notNull(),

    // --- Care info ---
    sunlight: text("sunlight"),                   // "full_sun" | "partial_shade" | "full_shade"
    watering: text("watering"),                   // "low" | "moderate" | "high"
    soilType: text("soil_type"),                  // e.g. "well-drained loamy soil"
    matureHeight: text("mature_height"),          // e.g. "15-20 ft"
    climateZone: text("climate_zone"),            // e.g. "Zone 9-11" or free text
    growthRate: text("growth_rate"),              // "slow" | "moderate" | "fast"
    bloomSeason: text("bloom_season"),            // e.g. "Spring", "Year-round"

    keyBenefits: jsonb("key_benefits").$type<string[]>().notNull().default([]),
    bestFor: jsonb("best_for").$type<string[]>().notNull().default([]),        // e.g. ["Indoor", "Balcony", "Garden"]
    careTips: jsonb("care_tips").$type<string[]>().notNull().default([]),

    images: jsonb("images").$type<string[]>().notNull().default([]),
    videoUrl: text("video_url"),
    homepageTag: text("homepage_tag"),            // "trending" | "new_arrivals" | null
    productStatus: text("product_status").notNull().default("in_stock"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    // FIX: soft-delete column. Products should be soft-deleted (hidden from
    // buyers) rather than hard-deleted, so historical orders/reviews that
    // reference the product still have a valid FK target. The API layer
    // filters WHERE deleted_at IS NULL on buyer-facing queries.
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    // P0-2: index on categoryId — supports /products?category= and the
    // category-products page (routes/products.ts:570-578). Without this
    // index the category filter seq-scans the products table.
    index("products_category_id_idx").on(table.categoryId),
    // P0-2: composite index on homepageTag + deletedAt — supports the
    // featured-products and homepage-products queries
    // (routes/products.ts:383, 425, 430) which filter
    // WHERE homepage_tag = ? AND deleted_at IS NULL. A partial index scoped
    // to non-deleted rows would be marginally faster, but a plain composite
    // also serves admin queries that filter by homepage_tag without the
    // soft-delete filter.
    index("products_homepage_tag_deleted_idx").on(
      table.homepageTag,
      table.deletedAt,
    ),
  ],
);

export const insertProductSchema = createInsertSchema(productsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof productsTable.$inferSelect;
