import {
  pgTable,
  serial,
  integer,
  numeric,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const monthlyRecordsTable = pgTable(
  "monthly_records",
  {
    id: serial("id").primaryKey(),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    totalRevenue: numeric("total_revenue", { precision: 12, scale: 2 }).notNull().default("0"),
    totalOrders: integer("total_orders").notNull().default(0),
    archivedAt: timestamp("archived_at").defaultNow().notNull(),
  },
  (table) => [
    // P0-2: unique constraint on (year, month) — the monthly-archive cron
    // job (routes/monthlyRecords.ts / routes/cron.ts → monthly-archive) checks
    // for an existing row for a given (year, month) before inserting, to
    // prevent duplicate archive rows when the cron fires twice in the same
    // month (e.g. after a Render restart). Without a DB-level unique
    // constraint, a race between two concurrent cron invocations could
    // insert two rows for the same month; this constraint makes the
    // idempotency check atomic at the DB layer.
    unique("monthly_records_year_month_unique").on(
      table.year,
      table.month,
    ),
  ],
);

export type MonthlyRecord = typeof monthlyRecordsTable.$inferSelect;
