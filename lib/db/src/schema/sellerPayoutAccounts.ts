import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { type z } from "zod/v4";
import { sellersTable } from "./sellers";

/**
 * Per-seller bKash PAYOUT destination (platform-custodial payments model).
 * The platform holds ONE bKash merchant account (platformPaymentConfigTable,
 * admin-configured); buyers pay the platform directly; after courier
 * delivery is confirmed the platform disburses the seller's share OUT to
 * the plain phone number stored here, via bKash's B2C/disbursement API
 * (lib/payouts.ts:attemptSellerPayout → lib/bkash.ts:disburseToSeller).
 *
 * This table REPLACED the old seller_payment_configs table (per-seller
 * bKash merchant API credentials), which has been dropped. Sellers no
 * longer touch merchant credentials at all.
 *
 * bkashNumber is NOT encrypted, unlike the old merchantAppKey/etc. fields
 * on the dropped table. This is a deliberate distinction, not an oversight:
 * a bKash *account number* is a phone number the seller would give out to
 * receive money anyway (visible in the bKash app's own transaction
 * history, shareable by design) -- it is not a secret that grants API
 * access the way an app key/secret/password does. Treating it as a
 * credential requiring the same AES-256-GCM machinery as
 * platformPaymentConfigTable would be over-engineering for a value with no
 * confidentiality requirement, and would block the admin's plausible-future
 * need to eyeball/search these in plain SQL when reconciling payouts by
 * hand.
 *
 * sellerId has .unique() (one payout account per seller), FK
 * sellersTable, cascade delete -- mirrors sellerCourierConfigsTable's
 * precedent exactly. A seller with no row here cannot receive payouts;
 * attemptSellerPayout records a "failed" payout row with
 * failureReason="No payout account on file for this seller" rather than
 * crashing.
 *
 * Listing-eligibility invariant: a seller must have a row here to set
 * paymentMethod = "advance" | "both" on their listings (see
 * lib/db/src/logic/sellerListings.ts:hasSellerPayoutAccount). Deleting
 * this row triggers reconciliation: routes/sellerPayoutAccounts.ts's
 * DELETE route flips any of the seller's "advance"/"both" listings back
 * to "cod", preserving the invariant.
 *
 * PART 3 ADDENDUM (see PART3_HANDOFF.md): the open question below --
 * "bkashNumber storage format is not normalized" -- is now resolved, but
 * deliberately NOT by changing this column or backfilling existing rows.
 * `disburseToSeller()` in `artifacts/api-server/src/lib/bkash.ts` is the
 * first real consumer that sends this number to an external API, and it
 * normalizes to bKash's own observed bare-local-digits MSISDN shape
 * (`01XXXXXXXXX`, no `+880`/`880` prefix) at CALL TIME ONLY, via that
 * file's `normalizeMsisdnForB2C()` helper -- same "transform right before
 * the external call, never rewrite the stored value" spirit as
 * `credentialEncryption.ts`'s decrypt-at-call-time convention. This column
 * still stores whatever the seller originally submitted (any of the three
 * forms `isValidBdPhone()` below accepts), unchanged.
 */
export const sellerPayoutAccountsTable = pgTable("seller_payout_accounts", {
  id: serial("id").primaryKey(),
  sellerId: integer("seller_id")
    .notNull()
    .unique()
    .references(() => sellersTable.id, { onDelete: "cascade" }),

  // Plain bKash account number, NOT encrypted -- see doc comment above.
  // Stored as submitted (post format-check) rather than normalized to a
  // single canonical form. Normalization to bKash's required MSISDN format
  // happens at call time in `disburseToSeller()` via
  // `normalizeMsisdnForB2C()`, never rewriting the stored value.
  bkashNumber: text("bkash_number").notNull(),

  // Optional -- lets an admin visually cross-check "does this name match
  // the seller's registered business/owner name" before trusting a payout
  // destination, without calling any bKash name-lookup API (none is used
  // anywhere in this part).
  accountHolderName: text("account_holder_name"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSellerPayoutAccountSchema = createInsertSchema(sellerPayoutAccountsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSellerPayoutAccount = z.infer<typeof insertSellerPayoutAccountSchema>;
export type SellerPayoutAccount = typeof sellerPayoutAccountsTable.$inferSelect;

/**
 * Simple BD mobile number format check -- NOT an existing pattern reused
 * from elsewhere, despite the prompt's suggestion to check for one first.
 * Verified by grep before writing this: routes/users.ts's phone field has
 * a comment claiming "Validate Bangladesh phone format" but the actual
 * code only checks `typeof === "string" && length <= 20`, no real format
 * regex; sellers.ts/addresses.ts/orders.ts's phone columns are all plain
 * `text().notNull()` with zero format validation at the schema layer
 * either. The only real BD-format evidence in this codebase is
 * lib/whatsapp.ts's `+88` prefixing logic and the literal example numbers
 * used in tests/seed scripts (`01636575741`, `01700000000`,
 * `01800000000`) -- all 11 digits, `01` + a second digit in [3-9]. This
 * regex matches that shape. Accepts an optional leading `+880` or `880`
 * country-code prefix (stripped before checking) since a seller typing
 * their number is at least as likely to include it as the checkout/
 * whatsapp examples are to omit it, and rejecting a correctly-formatted
 * +880 number would be a worse experience than being slightly permissive.
 */
export const BD_PHONE_REGEX = /^(?:\+?880|0)1[3-9]\d{8}$/;

export function isValidBdPhone(value: string): boolean {
  return BD_PHONE_REGEX.test(value.trim());
}
