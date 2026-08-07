import { pgTable, serial, text, boolean, timestamp, varchar } from "drizzle-orm/pg-core";

export const blogPostsTable = pgTable("blog_posts", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 200 }).notNull().unique(),
  title: text("title").notNull(),
  excerpt: text("excerpt").notNull(),
  content: text("content").notNull(), // JSON stringified array of content blocks
  category: varchar("category", { length: 100 }).notNull(),
  readTime: varchar("read_time", { length: 50 }).notNull().default("5 min read"),
  image: text("image").notNull().default(""),
  featured: boolean("featured").notNull().default(false),
  publishedAt: varchar("published_at", { length: 50 }).notNull().default(""),
  linkedProductIds: text("linked_product_ids").notNull().default("[]"), // JSON stringified array of product ids, max 3
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
