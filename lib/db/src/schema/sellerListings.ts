import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { productsTable } from "./products";
import { sellersTable } from "./sellers";

/**
 * A seller's sellable instance of an admin-owned variety (productsTable).
 * Admin owns the variety/taxonomy; sellers own listings against it. Many
 * sellers can list against the same product, each with their own price,
 * stock, condition, images, etc.
 *
 * This REPLACES productVariantsTable's customer-facing role. productVariants
 * is deprecated once migration to this table is complete (see plan doc §2)
 * -- it is not deleted here, and existing data/routes on it are untouched
 * by this file alone.
 *
 * height/pot_size/age/root_type are comparison-critical fields and MUST be
 * validated server-side against listingAttributeOptionsTable for the
 * listing's product's category before accepting a write (plan doc §3a).
 * This file does not enforce that -- it belongs in the API route/service
 * layer, not the schema.
 */
export const sellerListingsTable = pgTable("seller_listings", {
  id: serial("id").primaryKey(),
  productId: integer("product_id")
    .notNull()
    .references(() => productsTable.id, { onDelete: "cascade" }),
  sellerId: integer("seller_id")
    .notNull()
    .references(() => sellersTable.id, { onDelete: "cascade" }),

  form: text("form"), // "seed" | "sapling" | "grafted" | "potted"

  // Comparison-critical -- must be a controlled value from
  // listingAttributeOptionsTable, enforced at the API layer.
  rootType: text("root_type"),
  potSize: text("pot_size"),
  age: text("age"),
  height: text("height"),

  // Free text -- no standardization needed.
  condition: text("condition"),

  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  discountPrice: numeric("discount_price", { precision: 10, scale: 2 }),
  stock: integer("stock").notNull().default(0),
  availableQuantity: integer("available_quantity").notNull().default(0),

  deliveryTimeDays: integer("delivery_time_days"),
  warrantyDays: integer("warranty_days"),
  returnPolicyText: text("return_policy_text"),

  // "cod" | "advance" | "both". "advance"/"both" only valid if the seller
  // has a verified seller_payment_configs row -- enforced at API layer.
  paymentMethod: text("payment_method").notNull().default("cod"),

  images: jsonb("images").$type<string[]>().notNull().default([]),
  videoUrl: text("video_url"),
  description: text("description"),
  offerText: text("offer_text"),
  certification: text("certification"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),

  // "public" | "hidden"
  visibility: text("visibility").notNull().default("public"),
  // Set only when visibility = "hidden" due to an automated cause, so a
  // later cause-specific restore doesn't accidentally un-hide a listing the
  // seller hid on purpose (or vice versa). "subscription_expired" is set by
  // the subscription-enforcement job and cleared (both this field and
  // visibility) when an admin marks that seller's subscription as paid.
  // Null when hidden manually by the seller, or when visible.
  hiddenReason: text("hidden_reason"),

  // "pending" | "approved" | "rejected"
  approvalStatus: text("approval_status").notNull().default("pending"),
  rejectionReason: text("rejection_reason"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSellerListingSchema = createInsertSchema(sellerListingsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSellerListing = z.infer<typeof insertSellerListingSchema>;
export type SellerListing = typeof sellerListingsTable.$inferSelect;
