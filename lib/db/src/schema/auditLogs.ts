import { pgTable, serial, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Audit log — append-only record of admin actions.
 *
 * FIX: previously had NO indexes at all. This table grows monotonically
 * (every admin write adds a row) and is queried by adminId ("what did
 * admin X do?"), targetType + targetId ("what happened to order Y?"),
 * and createdAt (chronological listing). Without indexes, every query
 * was a sequential scan on an ever-growing table — at 100k+ rows this
 * becomes unusably slow.
 *
 * Now indexed on:
 *   - adminId + createdAt DESC (admin activity history)
 *   - targetType + targetId (entity-level audit trail)
 *   - createdAt DESC (global chronological listing)
 *
 * No partitioning yet — declarative partitioning by month is a future
 * optimization if this table exceeds ~1M rows. For now, the indexes
 * keep query performance acceptable.
 *
 * No TTL/archival either — audit logs should be retained indefinitely
 * for compliance. If storage becomes an issue, archive rows older than
 * 2 years to cold storage (not implemented yet).
 */
export const auditLogsTable = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    adminId: text("admin_id").notNull(),
    adminEmail: text("admin_email"),
    action: text("action").notNull(),   // "order.status_changed", "product.deleted", etc.
    targetType: text("target_type"),    // "order", "product", "user", "coupon"
    targetId: text("target_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // Admin activity history: "show me everything admin X did, newest first"
    index("audit_logs_admin_created_idx").on(
      table.adminId,
      table.createdAt,
    ),
    // Entity-level audit trail: "show me every action taken on order Y"
    index("audit_logs_target_idx").on(
      table.targetType,
      table.targetId,
    ),
    // Global chronological listing (admin dashboard's "recent activity")
    index("audit_logs_created_idx").on(table.createdAt),
  ],
);
