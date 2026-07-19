import { pgTable, serial, text, numeric, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const affiliatesTable = pgTable("affiliates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  code: text("code").notNull().unique(),
  commissionRate: numeric("commission_rate", { precision: 5, scale: 2 }).notNull().default("10"),
  totalSales: numeric("total_sales", { precision: 12, scale: 2 }).notNull().default("0"),
  totalOrders: integer("total_orders").notNull().default(0),
  totalCommission: numeric("total_commission", { precision: 12, scale: 2 }).notNull().default("0"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
