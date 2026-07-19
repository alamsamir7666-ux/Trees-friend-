import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const newsletterTable = pgTable("newsletter_subscribers", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
