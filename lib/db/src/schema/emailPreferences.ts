// lib/db/src/schema/emailPreferences.ts
import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const emailPreferencesTable = pgTable("email_preferences", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  orderUpdates: boolean("order_updates").notNull().default(true),
  promotions: boolean("promotions").notNull().default(true),
  restockAlerts: boolean("restock_alerts").notNull().default(true),
  newsletter: boolean("newsletter").notNull().default(true),
  abandonedCart: boolean("abandoned_cart").notNull().default(true),
  loyaltyUpdates: boolean("loyalty_updates").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEmailPreferencesSchema = createInsertSchema(emailPreferencesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEmailPreferences = z.infer<typeof insertEmailPreferencesSchema>;
export type EmailPreferences = typeof emailPreferencesTable.$inferSelect;
