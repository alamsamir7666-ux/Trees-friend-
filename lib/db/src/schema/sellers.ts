import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * A seller is one business = one nursery = one location. No multi-location
 * sellers, no separate nursery entity.
 *
 * Becoming a seller is ADDITIVE to a user, not a role replacement -- the
 * user keeps users.role = "user" and gets this separate row. Do not repurpose
 * users.role to include "seller"; that breaks existing binary role checks.
 *
 * subscription_status/trial_ends_at/subscription_expires_at drive whether the
 * seller's listings are visible on buyer-facing pages. Exact enforcement
 * point + grace period are an OPEN DECISION (see plan doc §5) -- not encoded
 * here, must not be guessed at in application logic either.
 */
export const sellersTable = pgTable("sellers", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),

  businessName: text("business_name").notNull(),
  nurseryName: text("nursery_name").notNull(), // can differ from businessName

  ownerName: text("owner_name").notNull(),
  nidOrTradeLicenseUrl: text("nid_or_trade_license_url"),

  contactPhone: text("contact_phone").notNull(),
  contactEmail: text("contact_email").notNull(),

  location: text("location").notNull(),
  description: text("description"),
  nurseryImages: jsonb("nursery_images").$type<string[]>().notNull().default([]),

  // "pending_verification" | "active" | "suspended" | "vacation"
  status: text("status").notNull().default("pending_verification"),

  // "trial" | "active" | "expired"
  subscriptionStatus: text("subscription_status").notNull().default("trial"),
  trialEndsAt: timestamp("trial_ends_at"),
  subscriptionExpiresAt: timestamp("subscription_expires_at"),

  // Set when the pre-expiry payment-reminder email has been sent for the
  // CURRENT trial/subscription cycle, so the hourly job doesn't re-send it
  // every run. Cleared back to null whenever trialEndsAt or
  // subscriptionExpiresAt is (re)set to a new cycle -- e.g. on subscription
  // renewal via the admin mark-as-paid action -- so the next cycle gets its
  // own reminder. Mirrors abandonedCartsTable.emailSentAt.
  reminderSentAt: timestamp("reminder_sent_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSellerSchema = createInsertSchema(sellersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSeller = z.infer<typeof insertSellerSchema>;
export type Seller = typeof sellersTable.$inferSelect;
