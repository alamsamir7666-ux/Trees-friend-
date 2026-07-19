import { pgTable, serial, text, integer, boolean, timestamp, numeric } from "drizzle-orm/pg-core";

export const referralsTable = pgTable("referrals", {
  id: serial("id").primaryKey(),
  referrerId: text("referrer_id").notNull(),
  referredId: text("referred_id"),
  referralCode: text("referral_code").notNull().unique(),
  discountAmount: numeric("discount_amount", { precision: 10, scale: 2 }).notNull().default("100"),
  used: boolean("used").notNull().default(false),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
