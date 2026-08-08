import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const addressesTable = pgTable(
  "addresses",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    fullName: text("full_name").notNull(),
    phone: text("phone").notNull(),
    street: text("street").notNull(),
    city: text("city").notNull(),
    district: text("district").notNull(),
    postalCode: text("postal_code"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // P0-2: index on userId — every per-user address lookup
    // (routes/users.ts: GET /users/me/addresses) filters WHERE user_id = ?.
    // Without this index, the address-book page seq-scans the addresses
    // table for every signed-in user.
    index("addresses_user_id_idx").on(table.userId),
  ],
);

export const insertAddressSchema = createInsertSchema(addressesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAddress = z.infer<typeof insertAddressSchema>;
export type Address = typeof addressesTable.$inferSelect;
