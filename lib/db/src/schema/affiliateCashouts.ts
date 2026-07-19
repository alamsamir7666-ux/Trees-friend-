import { pgTable, serial, integer, numeric, text, timestamp } from "drizzle-orm/pg-core";
import { affiliatesTable } from "./affiliates";

export const affiliateCashoutsTable = pgTable("affiliate_cashouts", {
  id: serial("id").primaryKey(),
  affiliateId: integer("affiliate_id").notNull().references(() => affiliatesTable.id),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | rejected | paid
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
