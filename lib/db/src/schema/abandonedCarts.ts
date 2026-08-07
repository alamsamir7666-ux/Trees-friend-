import { pgTable, serial, text, jsonb, timestamp, boolean } from "drizzle-orm/pg-core";

export const abandonedCartsTable = pgTable("abandoned_carts", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  email: text("email"),
  items: jsonb("items").$type<Array<{ productId: number; quantity: number; name: string; price: number; image: string }>>().notNull().default([]),
  emailSentAt: timestamp("email_sent_at"),
  recovered: boolean("recovered").notNull().default(false),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
