import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const productQATable = pgTable("product_qa", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull(),
  userId: text("user_id").notNull(),
  userName: text("user_name").notNull(),
  question: text("question").notNull(),
  answer: text("answer"),
  answeredAt: timestamp("answered_at"),
  isPublished: boolean("is_published").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
