import { pgTable, serial, text, integer, boolean, timestamp, numeric } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const referralsTable = pgTable("referrals", {
  id: serial("id").primaryKey(),
  referrerId: text("referrer_id")
    .notNull()
    .references(() => usersTable.clerkId, { onDelete: "restrict" }),
  referredId: text("referred_id")
    .references(() => usersTable.clerkId, { onDelete: "set null" }),
  referralCode: text("referral_code").notNull().unique(),
  discountAmount: numeric("discount_amount", { precision: 10, scale: 2 }).notNull().default("100"),
  used: boolean("used").notNull().default(false),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
