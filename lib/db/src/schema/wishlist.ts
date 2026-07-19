import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { productsTable } from "./products";

export const wishlistTable = pgTable(
  "wishlist",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    productId: integer("product_id")
      .notNull()
      .references(() => productsTable.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (table) => [unique("wishlist_user_product_unique").on(table.userId, table.productId)],
);

export type WishlistItem = typeof wishlistTable.$inferSelect;
