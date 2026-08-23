/**
 * Account claim — migrates guest orders + cart to a new user account.
 *
 * Part 4 of the Daraz-style guest checkout.
 *
 * When a buyer who previously checked out as a phone-verified guest
 * (orders stored under userId = "guest_<phone>") later signs up / signs
 * in with a Clerk account that has the SAME phone number, this module
 * migrates their guest orders + cart items to their new clerkId.
 *
 * This is the "retention loop" — the guest's order history follows them
 * into their account, so they can track orders, leave reviews, earn
 * loyalty points on future purchases, etc.
 *
 * WHAT GETS MIGRATED:
 *   - orders: userId "guest_<phone>" → clerkId
 *   - cart_items: userId "guest_<phone>" → clerkId
 *   - (addresses are NOT migrated — guests skip address auto-save, so
 *      there are no guest address rows to move)
 *   - (loyalty_points are NOT migrated — guests skip loyalty, so there
 *      are no guest loyalty rows to move)
 *
 * WHEN IT RUNS:
 *   - On first sign-in: the `authenticate()` function in auth.ts auto-
 *     creates a users row when it sees a new Clerk ID. After the insert,
 *     it calls `claimGuestOrders(clerkId, phone)` if the Clerk profile
 *     has a phone number.
 *   - On subsequent sign-ins: `claimGuestOrders` is idempotent — if the
 *     guest orders have already been migrated (userId is already the
 *     clerkId, not "guest_..."), the UPDATE is a no-op.
 *
 * IDempotency:
 *   - The UPDATE WHERE userId = "guest_<phone>" matches 0 rows if the
 *     orders have already been migrated. Safe to call on every sign-in.
 *   - No transaction needed — the updates are independent (orders +
 *     cart_items have no FK between them). A partial failure leaves the
 *     guest's data intact (still under "guest_<phone>"), and the next
 *     sign-in retries.
 *
 * WHAT IT DOESN'T DO:
 *   - Doesn't delete the guest OTP row (guest_otps table) — that row
 *     expires naturally (session_expires_at). Keeping it lets the guest
 *     JWT remain valid until it expires, so an in-flight guest session
 *     doesn't break mid-checkout if the buyer signs up in another tab.
 *   - Doesn't invalidate the guest JWT — the buyer's TokenSync clears
 *     the guest session on sign-in (App.tsx), so the guest JWT is
 *     removed from localStorage and not sent on subsequent requests.
 */

import { db } from "@workspace/db";
import { ordersTable, cartItemsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Migrate guest orders + cart items to a Clerk user account.
 *
 * Called by `authenticate()` in auth.ts when a new user is created
 * (or on sign-in if the user's phone changed and matches a guest phone).
 *
 * @param clerkId - The user's Clerk ID (the new owner of the orders).
 * @param phone - The user's phone number (normalized to bare-local form
 *   01XXXXXXXXX by the caller — see normalizeBdPhoneForStorage in
 *   lib/guestOtp.ts). If null/empty, no migration runs (the user has no
 *   phone in their Clerk profile, so there's nothing to match).
 * @returns the number of orders + cart items migrated (0 if nothing
 *   matched, which is the normal case for a user who was never a guest).
 */
export async function claimGuestOrders(
  clerkId: string,
  phone: string | null | undefined,
): Promise<{ ordersMigrated: number; cartItemsMigrated: number }> {
  if (!phone) {
    return { ordersMigrated: 0, cartItemsMigrated: 0 };
  }

  const guestUserId = `guest_${phone}`;

  try {
    // Migrate orders — UPDATE WHERE userId = "guest_<phone>"
    const ordersResult = await db
      .update(ordersTable)
      .set({ userId: clerkId, updatedAt: new Date() })
      .where(eq(ordersTable.userId, guestUserId));

    // Migrate cart items — UPDATE WHERE userId = "guest_<phone>"
    const cartResult = await db
      .update(cartItemsTable)
      .set({ userId: clerkId, updatedAt: new Date(), expiresAt: sql`NOW() + INTERVAL '30 days'` })
      .where(eq(cartItemsTable.userId, guestUserId));

    const ordersMigrated = (ordersResult as any)?.rowCount ?? 0;
    const cartItemsMigrated = (cartResult as any)?.rowCount ?? 0;

    if (ordersMigrated > 0 || cartItemsMigrated > 0) {
      logger.info(
        { clerkId, phone, ordersMigrated, cartItemsMigrated },
        "[accountClaim] Migrated guest orders + cart to new account",
      );
    }

    return { ordersMigrated, cartItemsMigrated };
  } catch (err) {
    // Non-fatal — the guest's data stays under "guest_<phone>" and can
    // be retried on the next sign-in. Don't throw — account creation
    // must succeed even if the migration fails.
    logger.error(
      { err, clerkId, phone },
      "[accountClaim] Failed to migrate guest orders (non-fatal — guest data stays intact)",
    );
    return { ordersMigrated: 0, cartItemsMigrated: 0 };
  }
}
