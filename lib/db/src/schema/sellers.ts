import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { type z } from "zod/v4";
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
  // Single square logo/avatar shown on buyer-facing seller cards (distinct
  // from nurseryImages, which is a gallery of nursery photos, not a
  // profile-picture-shaped image). Nullable -- most sellers won't have
  // uploaded one, and the frontend falls back to a placeholder.
  logoUrl: text("logo_url"),

  // "pending_verification" | "active" | "suspended" | "vacation"
  status: text("status").notNull().default("pending_verification"),

  // Public "verified seller" badge (Amazon/Daraz-style trust checkmark),
  // shown on buyer-facing seller listing cards. Deliberately separate from
  // `status` above: status is an account on/off switch (gates whether the
  // seller's listings appear at all), verification is an earned trust
  // signal an already-active seller can request and an admin can grant --
  // the two are independent and a seller can be active but not verified.
  // "none" | "requested" | "approved" | "rejected"
  verificationRequestStatus: text("verification_request_status").notNull().default("none"),
  isVerified: boolean("is_verified").notNull().default(false),
  verificationRequestedAt: timestamp("verification_requested_at"),
  verificationDecidedAt: timestamp("verification_decided_at"),
  // Optional note from admin on rejection (shown to the seller so they know
  // what to fix before re-requesting).
  verificationRejectionReason: text("verification_rejection_reason"),

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
  // FIX: soft-delete column. Previously, hard-deleting a seller cascaded to
  // wipe listings, reviews, conversations, follows, payment configs, payout
  // accounts — destroying financial/communication history that should be
  // retained for compliance. Now sellers are soft-deleted (set deleted_at
  // instead of DELETE) and filtered out at the API layer. The DB row stays
  // for audit trail.
  deletedAt: timestamp("deleted_at"),
});

export const insertSellerSchema = createInsertSchema(sellersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSeller = z.infer<typeof insertSellerSchema>;
export type Seller = typeof sellersTable.$inferSelect;
