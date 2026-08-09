import { pgTable, serial, text, jsonb, timestamp, boolean } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const abandonedCartsTable = pgTable("abandoned_carts", {
  id: serial("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => usersTable.clerkId, { onDelete: "cascade" }),
  email: text("email"),
  items: jsonb("items").$type<{ productId: number; quantity: number; name: string; price: number; image: string }[]>().notNull().default([]),
  emailSentAt: timestamp("email_sent_at"),
  recovered: boolean("recovered").notNull().default(false),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
