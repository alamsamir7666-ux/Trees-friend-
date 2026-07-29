import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sellersTable } from "./sellers";

/**
 * A buyer following a seller's store (Seller Store Page, "Follow" button).
 * One row per (userId, sellerId) pair -- enforced by the unique() table
 * constraint below, same follow-source-of-truth pattern as wishlist.ts's
 * userId column: this stores the Clerk id directly (text), not
 * usersTable.id, since that's what every route on this project already
 * has on hand via req.userId / req.dbUser.clerkId and how wishlist/
 * reviews/cart already key on the user.
 *
 * Cascades on delete like wishlist's productId/sellerListingVariantId FKs --
 * a follow row for a seller that no longer exists is meaningless.
 */
export const followsTable = pgTable(
  "follows",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
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
