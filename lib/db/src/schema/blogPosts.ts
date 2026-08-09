import { pgTable, serial, text, boolean, timestamp, varchar, jsonb, integer } from "drizzle-orm/pg-core";

export const blogPostsTable = pgTable("blog_posts", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 200 }).notNull().unique(),
  title: text("title").notNull(),
  excerpt: text("excerpt").notNull(),
  content: text("content").notNull(), // JSON stringified array of content blocks
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
