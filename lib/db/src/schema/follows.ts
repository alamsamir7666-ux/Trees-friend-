import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sellersTable } from "./sellers";
import { usersTable } from "./users";

/**
 * A buyer following a seller's store (Seller Store Page, "Follow" button).
 * One row per (userId, sellerId) pair -- enforced by the unique() table
 * constraint below.
 *
 * userId references users.clerk_id (text) with ON DELETE CASCADE — when a
 * user is deleted, their follows are auto-cleaned.
 */
export const followsTable = pgTable(
  "follows",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.clerkId, { onDelete: "cascade" }),
    sellerId: integer("seller_id")
      .notNull()
      .references(() => sellersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("follows_user_seller_unique").on(table.userId, table.sellerId),
  ],
);

export type Follow = typeof followsTable.$inferSelect;
