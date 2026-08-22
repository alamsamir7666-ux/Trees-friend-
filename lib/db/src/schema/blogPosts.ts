import { pgTable, serial, text, boolean, timestamp, varchar, jsonb, integer } from "drizzle-orm/pg-core";

/**
 * Blog post content block — stored as native `jsonb` array since migration
 * 0011. Previously `text` storing a JSON-stringified array, which (a) was
 * inconsistent with `linked_product_ids` (already `jsonb`), (b) prevented
 * native Postgres JSON operators/indexing, and (c) required a
 * `JSON.parse(...)` + `JSON.stringify(...)` round-trip on every read/write.
 *
 * The shape is an array of discriminated-union blocks:
 *   { type: "h2" | "h3" | "p" | "tip", text: string }
 *   { type: "ul", items: string[] }
 *
 * Kept as `jsonb` (not `jsonb(jsonb[])`) so future block types can be added
 * without a schema migration — same rationale as `key_benefits` / `care_tips`
 * on `productsTable`.
 */
export type BlogContentBlock =
  | { type: "h2" | "h3" | "p" | "tip"; text: string }
  | { type: "ul"; items: string[] };

export const blogPostsTable = pgTable("blog_posts", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 200 }).notNull().unique(),
  title: text("title").notNull(),
  excerpt: text("excerpt").notNull(),
  // FIX (migration 0011): was `text` storing a JSON-stringified array.
  // Now native `jsonb` — supports native Postgres JSON operators and
  // avoids the JSON.parse/stringify round-trip on every read/write.
  // DEFAULT '[]' keeps existing INSERT behavior (empty content array).
  content: jsonb("content").$type<BlogContentBlock[]>().notNull().default([]),
  category: varchar("category", { length: 100 }).notNull(),
  // FIX (migration 0005): was varchar(50) storing display strings like "5 min read".
  // Now integer (minutes) — supports sorting/filtering by read time.
  readTime: integer("read_time").notNull().default(5),
  image: text("image").notNull().default(""),
  featured: boolean("featured").notNull().default(false),
  // FIX (migration 0005): was varchar(50) storing display strings like "August 2025".
  // Now a real timestamp — supports sorting/filtering by publication date.
  publishedAt: timestamp("published_at"),
  // FIX (migration 0005): was text storing JSON-stringified arrays like '[1,2,3]'.
  // Now native jsonb — supports indexing + native array operations.
  linkedProductIds: jsonb("linked_product_ids").$type<number[]>().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
