import { pgTable, serial, text, boolean, timestamp, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { type z } from "zod/v4";

/**
 * The PLATFORM's own bKash merchant credentials (new payments design,
 * Part 1 of 4 — see PART1_HANDOFF.md for the full old-vs-new model). There
 * is exactly ONE of these rows, ever: buyers pay into this single admin-
 * owned bKash merchant account (not into any per-seller merchant account),
 * and the platform later disburses each seller's share out to their
 * registered payout number (sellerPayoutAccountsTable, this same file's
 * sibling) via bKash B2C — that disbursement call is Part 3's job, not
 * built here.
 *
 * This intentionally reuses the OLD per-seller shape (app key/secret,
 * username, password) unchanged -- it's the same bKash Merchant/Checkout
 * credential set, just held by one admin account instead of N seller
 * accounts. Encrypted at rest via the SAME utility as
 * sellerPaymentConfigsTable/sellerCourierConfigsTable
 * (artifacts/api-server/src/lib/credentialEncryption.ts,
 * CREDENTIAL_ENCRYPTION_KEY-backed AES-256-GCM) -- do not invent a second
 * encryption scheme for this table. Never log these fields; never return
 * them un-masked in any API response body (see routes/platformPaymentConfig.ts's
 * toMasked, mirroring sellerPaymentConfigs.ts's convention exactly).
 *
 * isVerified follows the same convention as the old per-seller table: the
 * create/replace route never sets it true itself (no live bKash API call
 * happens in this part -- see this project's Part-1 scope note). It starts
 * false and stays false until some future admin-side verification step
 * flips it. Nothing reads isVerified yet in this part (Part 2's
 * checkout/payment-execute logic is the first consumer) -- documenting the
 * intended meaning now so Part 2 doesn't have to guess: an admin should not
 * be able to accept real buyer payments into this account until it's
 * verified, the same gate the old model used per-seller.
 *
 * SINGLE-ROW ENFORCEMENT — judgment call, documenting the reasoning:
 * There is no natural unique business key here (unlike sellerId on the old
 * per-seller table) to hang a DB-level UNIQUE constraint on, since there is
 * only ever one admin account and no tenant column to be unique per. Two
 * options considered:
 *   (a) A literal singleton-key column (e.g. `singleton: text().notNull()
 *       .unique().default("singleton")`) so Postgres itself refuses a
 *       second row.
 *   (b) No DB constraint at all; enforce "at most one row" purely at the
 *       application layer (route always does delete-then-insert, same
 *       upsert pattern sellerPaymentConfigs.ts/sellerCourierConfigs.ts
 *       already use for their own one-row-per-seller invariant).
 * Chose (a). Reasoning: this table guards the platform's own live payment
 * credentials -- a place where "the app-layer route happens to always
 * upsert correctly" is a weaker guarantee than "the database physically
 * cannot hold two rows," and the cost of the extra constraint is a single
 * throwaway column. A stray direct-DB insert (migration script, manual
 * fix, future admin tool that forgets the delete-then-insert convention)
 * fails loudly at the DB layer instead of silently creating a second,
 * ambiguous "which one is real" config row that routes/platformPaymentConfig.ts's
 * `.limit(1)` read would then pick from nondeterministically. The `id`
 * serial PK still exists (matches every other table's convention, and
 * `.returning()` callers elsewhere in this codebase expect an `id` field)
 * -- `singleton` is purely a constraint mechanism, not a real business
 * column, and is never read or written by application code beyond the
 * insert itself.
 */
export const platformPaymentConfigTable = pgTable("platform_payment_config", {
  id: serial("id").primaryKey(),

  // Constraint-only column -- see doc comment above. Always the literal
  // string "singleton"; the UNIQUE constraint is what actually prevents a
  // second row from ever being inserted.
  singleton: text("singleton").notNull().unique().default("singleton"),

  provider: text("provider").notNull().default("bkash"), // "bkash" (only provider this schema supports today, matches old table)

  // Encrypted at rest (AES-256-GCM via credentialEncryption.ts). Never
  // returned verbatim via API -- see routes/platformPaymentConfig.ts's
  // toMasked.
  merchantAppKey: text("merchant_app_key").notNull(),
  merchantAppSecret: text("merchant_app_secret").notNull(),
  merchantUsername: text("merchant_username").notNull(),
  merchantPassword: text("merchant_password").notNull(),

  isVerified: boolean("is_verified").notNull().default(false),
  // Configurable gift wrap fee in taka. Previously hardcoded at 50 in
  // CheckoutPage.tsx — now admins can set this via the platform config
  // UI. Defaults to 50 for backward compatibility. NULL is treated as
  // the default (50) by the checkout route.
  giftWrapCost: numeric("gift_wrap_cost", { precision: 10, scale: 2 }).default("50"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPlatformPaymentConfigSchema = createInsertSchema(
  platformPaymentConfigTable,
).omit({
  id: true,
  singleton: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPlatformPaymentConfig = z.infer<typeof insertPlatformPaymentConfigSchema>;
export type PlatformPaymentConfig = typeof platformPaymentConfigTable.$inferSelect;
