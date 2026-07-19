import {
  pgTable,
  serial,
  integer,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";

export const monthlyRecordsTable = pgTable("monthly_records", {
  id: serial("id").primaryKey(),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  totalRevenue: numeric("total_revenue", { precision: 12, scale: 2 }).notNull().default("0"),
  totalOrders: integer("total_orders").notNull().default(0),
  archivedAt: timestamp("archived_at").defaultNow().notNull(),
});

export type MonthlyRecord = typeof monthlyRecordsTable.$inferSelect;
