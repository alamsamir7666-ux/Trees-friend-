import { pgTable, serial, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  adminId: text("admin_id").notNull(),
  adminEmail: text("admin_email"),
  action: text("action").notNull(),   // "order.status_changed", "product.deleted", etc.
  targetType: text("target_type"),    // "order", "product", "user", "coupon"
  targetId: text("target_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
