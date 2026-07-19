import { pgTable, serial, integer, text, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const returnStatusEnum = pgEnum("return_status", [
  "requested", "approved", "rejected", "completed"
]);

export const returnsTable = pgTable("returns", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull(),
  userId: text("user_id").notNull(),
  reason: text("reason").notNull(),
  status: returnStatusEnum("status").notNull().default("requested"),
  adminNote: text("admin_note"),
  refundAmount: text("refund_amount"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
