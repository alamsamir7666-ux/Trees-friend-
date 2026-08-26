import { eq } from "drizzle-orm";
import { db } from "../index";
import { sellerPayoutAccountsTable } from "../schema";

/**
 * Listing-eligibility gate for the platform-custodial payments model.
 *
 * Under the new (post-migration) payments design:
 *   - The platform holds ONE bKash merchant account (platformPaymentConfigTable),
 *     configured by an admin. Buyers pay the platform directly.
 *   - Each seller registers a plain bKash PERSONAL number (sellerPayoutAccountsTable)
 *     where the platform disburses their share after courier-confirmed delivery.
 *   - Per-seller bKash merchant credentials (the old sellerPaymentConfigsTable)
 *     no longer exist — sellers never touch merchant API credentials.
 *
 * The real invariant for "can this seller offer paymentMethod = 'advance' | 'both'
 * on a listing" is therefore: **the platform must have somewhere to send the
 * seller's money**. If a seller has no payout account on file, they cannot
 * accept advance payments — the platform would collect money it has nowhere
 * to disburse. Cash-on-delivery is unaffected (the buyer pays the courier
 * directly, no platform-side settlement involved).
 *
 * This function replaces the pre-migration `hasVerifiedPaymentConfig(sellerId)`
 * which read the old sellerPaymentConfigsTable. Callers (sellerListings.ts
 * POST/PUT routes) now call this instead — same signature, same boolean
 * return, but the underlying check is "payout account exists" rather than
 * "merchant credentials verified by an admin".
 *
 * Unlike the old check, there is no separate "verified" flag to flip: a
 * payout account is just a phone number the seller typed in, and its
 * existence is the only eligibility signal. (The number's actual validity
 * is enforced at write time by isValidBdPhone, and at disbursement time by
 * bKash's B2C API call — neither needs an admin-gated "isVerified" toggle
 * here.)
 */
export async function hasSellerPayoutAccount(sellerId: number): Promise<boolean> {
  const [account] = await db
    .select({ id: sellerPayoutAccountsTable.id })
    .from(sellerPayoutAccountsTable)
    .where(eq(sellerPayoutAccountsTable.sellerId, sellerId))
    .limit(1);
  return !!account;
}
