import { pgTable, serial, integer, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ordersTable } from "./orders";
import { sellersTable } from "./sellers";

/**
 * One row per PAYOUT ATTEMPT against an order (new payments design, Part 1
 * of 4 -- see PART1_HANDOFF.md). Schema only in this part: nothing inserts
 * or updates rows here yet. Part 3 (bKash B2C/disbursement) is expected to
 * insert a row when it attempts a payout after courier delivery is
 * confirmed, and update `status`/`bkashTransactionId`/`failureReason` as
 * the disbursement call resolves.
 *
 * orderId deliberately has NO unique constraint, unlike
 * orderShipmentsTable.orderId (one continuous status track per order --
 * see that file's doc comment) or sellerPaymentConfigsTable/
 * sellerCourierConfigsTable/sellerPayoutAccountsTable's sellerId (one
 * config per seller, replaced wholesale on change). A payout is a
 * discrete ATTEMPT, not a continuously-updated status: a "failed" payout
 * (e.g. bKash B2C call times out, or the seller's payout number is
 * temporarily invalid) plausibly gets retried, and each retry is its own
 * attempt worth its own audit row with its own bkashTransactionId/
 * failureReason/timestamps -- collapsing retries into a single
 * update-in-place row would lose that history. The prompt's own framing
 * ("one row per payout attempt") matches this reading. Part 3/4, whoever
 * builds the actual disbursement + retry logic, should decide the retry
 * policy itself (e.g. whether a new "pending" row is inserted per retry or
 * an existing "failed" row is reused) -- not decided or encoded here.
 *
 * sellerId is stored directly (not derived by joining through orderId)
 * for the same reason ordersTable.items[] keeps a per-line sellerId
 * alongside ordersTable.sellerId: a payout is a per-seller financial
 * record and should be self-describing without a join, and because
 * ordersTable.sellerId is NULLABLE (null for pre-marketplace admin-direct
 * orders -- see schema/orders.ts) while a payout, by definition, only
 * exists for marketplace orders that actually have a seller to pay. FK'd
 * to sellersTable directly (not just trusting ordersTable.sellerId's
 * value) so this table's own FK constraint independently guarantees
 * referential integrity even if orders.sellerId is ever null or wrong.
 * No onDelete/cascade specified for either FK -- deliberately left to
 * Postgres's default (RESTRICT) rather than cascading, since a payout is a
 * financial audit record; deleting an order or a seller should not be
 * able to silently delete evidence of a payout that was attempted or
 * completed against them. If Part 3/4 needs a different policy (e.g. a
 * seller-deletion flow that must succeed regardless), that's an explicit
 * decision for whoever builds that flow, not a default to inherit
 * silently from this table.
 *
 * status: "pending" | "success" | "failed" today. Deliberately a plain
 * `text` column (not a DB enum type) so Part 3/4 can extend the set (e.g.
 * a future "reversed"/"clawed_back" state for the manual-case-by-case
 * returns-after-payout handling the top-level project context describes
 * as explicitly out of scope for all four parts) without a migration to
 * alter a Postgres enum type -- matches this codebase's existing
 * convention of plain-text "enum-shaped" columns with the allowed values
 * documented in a comment (see ordersTable.orderStatus,
 * sellersTable.status, orderShipmentsTable.status) rather than actual `pgEnum`.
 *
 * PART 3 ADDENDUM (see PART3_HANDOFF.md): the retry-policy question left
 * open above ("does a retry insert a new row or update the failed one") is
 * now decided: INSERT A NEW ROW PER ATTEMPT, always. See
 * `attemptSellerPayout()`'s own doc comment (originally in
 * `artifacts/api-server/src/routes/courierWebhooks.ts`; moved unchanged to
 * `artifacts/api-server/src/lib/payouts.ts` by Part 4, see that
 * addendum below) for the full reasoning (matches this file's own "one
 * row per attempt" framing above, and keeps the idempotency check simple:
 * look only for an existing `status: "success"` row for a given
 * `orderId`, with no need to special-case "is this a retry" separately
 * from "is this the first attempt").
 *
 * PART 4 ADDENDUM (see PART4_HANDOFF.md): two new nullable columns,
 * `adminNote` and `clawbackNotedAmount`, added for the project's explicit
 * "case-by-case, manual, never automated" returns-after-payout decision
 * (reiterated in this part's own prompt: if a buyer returns an item AFTER
 * a seller has already been paid out, an admin handles that manually
 * outside the app -- no clawback/balance-adjustment logic anywhere in
 * this codebase, ever). These two columns are PURELY a bookkeeping aid:
 * a free-text note field so an admin can record "buyer returned this,
 * handling refund manually with seller" against the specific payout row
 * it concerns, and an optional numeric field to note what amount that
 * manual follow-up involves, for the admin's own reference. Setting
 * either field does NOT trigger any bKash call, does NOT touch
 * sellerPayoutAccountsTable/sellersTable, does NOT recompute any balance
 * or ledger anywhere -- see routes/admin.ts's
 * `PATCH /admin/payouts/:id/note` (the only route that writes these
 * columns) for the enforcement of that boundary. Deliberately NOT called
 * "clawbackAmount" (a name that would imply the amount was actually
 * clawed back) -- named `clawbackNotedAmount` to keep the "this is a note,
 * not a transaction" framing honest in the column name itself, not just
 * in a comment someone might not read.
 *
 * Also as part of Part 4: `attemptSellerPayout()` (referenced above) moved
 * from routes/courierWebhooks.ts to `artifacts/api-server/src/lib/payouts.ts`,
 * unchanged in behavior, so both the courier-delivered webhook and the new
 * `POST /admin/payouts/:id/retry` admin route share one implementation
 * rather than two copies of the same guard/insert/disburse logic.
 */
export const payoutsTable = pgTable("payouts", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .notNull()
    .references(() => ordersTable.id),
  sellerId: integer("seller_id")
    .notNull()
    .references(() => sellersTable.id),

  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),

  // "pending" | "success" | "failed" -- see doc comment above; room left
  // for Part 3/4 to extend this set.
  status: text("status").notNull().default("pending"),

  bkashTransactionId: text("bkash_transaction_id"),
  failureReason: text("failure_reason"),

  // PART 4 -- manual, case-by-case returns-after-payout bookkeeping only.
  // See doc comment above: no automated clawback/balance logic reads or
  // acts on these; they exist purely so an admin can record that a
  // specific payout needs manual follow-up outside the app.
  adminNote: text("admin_note"),
  clawbackNotedAmount: numeric("clawback_noted_amount", { precision: 10, scale: 2 }),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPayoutSchema = createInsertSchema(payoutsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPayout = z.infer<typeof insertPayoutSchema>;
export type Payout = typeof payoutsTable.$inferSelect;
