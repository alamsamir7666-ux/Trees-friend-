import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sellersTable } from "./sellers";

/**
 * Per-seller bKash PAYOUT destination (new payments design, Part 1 of 4 --
 * see PART1_HANDOFF.md). Replaces what used to be per-seller bKash
 * MERCHANT API credentials (sellerPaymentConfigsTable, left in place
 * un-migrated this part -- see that table's file and PART1_HANDOFF.md's
 * open items). Under the new model a seller does not need merchant API
 * access at all: buyers pay into the platform's own single bKash merchant
 * account (platformPaymentConfigTable), and after courier delivery is
 * confirmed the platform disburses the seller's share OUT to the plain
 * phone number stored here, via bKash's B2C/disbursement API (Part 3 --
 * not built here).
 *
 * bkashNumber is NOT encrypted, unlike merchantAppKey/etc. on the old
 * table. This is a deliberate distinction, not an oversight: a bKash
 * *account number* is a phone number the seller would give out to receive
 * money anyway (visible in the bKash app's own transaction history,
 * shareable by design) -- it is not a secret that grants API access the
 * way an app key/secret/password does. Treating it as a credential
 * requiring the same AES-256-GCM machinery as
 * platformPaymentConfigTable/sellerPaymentConfigsTable would be
 * over-engineering for a value with no confidentiality requirement, and
 * would block the admin's plausible-future need to eyeball/search these
 * in plain SQL when reconciling payouts by hand.
 *
 * sellerId has .unique() (one payout account per seller), FK
 * sellersTable, cascade delete -- mirrors sellerPaymentConfigsTable's and
 * sellerCourierConfigsTable's precedent exactly. A seller with no row here
 * cannot receive payouts; Part 3's disbursement logic is expected to skip
 * disbursement and hold the payout in a "pending"/"failed" state (see
 * payoutsTable.status doc comment) rather than crash, though that check
 * is Part 3's job, not encoded here.
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
 * forms `isValidBdPhone()` below accepts), unchanged. See that helper's own
 * doc comment for the full sourcing/reasoning on why bare-local-digits was
 * chosen over `whatsapp.ts`'s own opposite `+880`-prefixing convention.
 */
export const sellerPayoutAccountsTable = pgTable("seller_payout_accounts", {
  id: serial("id").primaryKey(),
  sellerId: integer("seller_id")
    .notNull()
    .unique()
    .references(() => sellersTable.id, { onDelete: "cascade" }),

  // Plain bKash account number, NOT encrypted -- see doc comment above.
  // Stored as submitted (post format-check) rather than normalized to a
  // single canonical form (e.g. always-with-880-prefix) -- there is no
  // existing normalization convention elsewhere in this codebase to match
  // (whatsapp.ts's +880-prefixing is a send-time transform for Twilio, not
  // a storage convention; nothing currently normalizes contactPhone/
  // shippingAddress.phone/etc. at write time either) -- so this doesn't
  // invent one unilaterally. Flagged as an open question in
  // PART1_HANDOFF.md for whoever builds Part 3's actual B2C API call,
  // since bKash's disbursement API may have its own required format.
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
