import { pgTable, serial, integer, text, timestamp, numeric, pgEnum, index } from "drizzle-orm/pg-core";
import { ordersTable } from "./orders";
import { usersTable } from "./users";

export const returnStatusEnum = pgEnum("return_status", [
  "requested", "approved", "rejected", "completed"
]);

export const returnsTable = pgTable(
  "returns",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => ordersTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.clerkId, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    status: returnStatusEnum("status").notNull().default("requested"),
    adminNote: text("admin_note"),
    // FIX: was `text("refund_amount")` — money stored as a string, impossible
    // to sum/arithmetic without casts. Now numeric(10,2), matching every
    // other money column in the codebase.
    refundAmount: numeric("refund_amount", { precision: 10, scale: 2 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // P0-2: Previously this table had ZERO indexes. Both "returns for this
    // order" (admin) and "my returns" (buyer) seq-scanned.
    index("returns_order_id_idx").on(table.orderId),
    index("returns_user_id_idx").on(table.userId),
  ],
);
