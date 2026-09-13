/**
 * Account claim — migrates guest orders + cart + wishlist to a new user account.
 *
 * Part 4 of the Daraz-style guest checkout.
 *
 * When a buyer who previously checked out as a phone-verified guest
 * (orders + cart + wishlist stored under userId = "guest_<phone>") later
 * signs up / signs in with a Clerk account that has the SAME phone number,
 * this module migrates those guest rows to their new clerkId.
 *
 * This is the "retention loop" — the guest's history follows them into
 * their account, so they can track orders, see their wishlist, leave
 * reviews, earn loyalty points on future purchases, etc.
 *
 * WHAT GETS MIGRATED:
 *   - orders:        userId "guest_<phone>" → clerkId
 *   - cart_items:    userId "guest_<phone>" → clerkId
 *   - wishlist:      userId "guest_<phone>" → clerkId
 *   - (addresses are NOT migrated — guests skip address auto-save, so
 *      there are no guest address rows to move)
 *   - (loyalty_points are NOT migrated — guests skip loyalty, so there
 *      are no guest loyalty rows to move)
 *   - (reviews are NOT applicable — guests cannot leave reviews, so
 *      there are no guest review rows to move. requireAuth stays on
 *      POST /reviews per industry standard.)
 *
 * WHEN IT RUNS:
 *   - On first sign-in: the `authenticate()` function in auth.ts auto-
 *     creates a users row when it sees a new Clerk ID. After the insert,
 *     it calls `claimGuestOrders(clerkId, phone)` if the Clerk profile
 *     has a phone number.
 *   - On subsequent sign-ins: `claimGuestOrders` is idempotent — if the
 *     guest rows have already been migrated (userId is already the
 *     clerkId, not "guest_..."), the UPDATE is a no-op.
 *
 * Idempotency:
 *   - Each UPDATE WHERE userId = "guest_<phone>" matches 0 rows if the
 *     rows have already been migrated. Safe to call on every sign-in.
 *
 * ATOMICITY (this was a real bug, fixed):
 *   The previous implementation ran three independent `await db.update(...)`
 *   calls WITHOUT a transaction wrapper. If the orders UPDATE succeeded but
 *   the cart_items UPDATE failed (network blip, constraint violation on
 *   one row), the guest's orders moved to clerkId while their cart stayed
 *   under "guest_<phone>" — orphaned forever, because the next sign-in's
 *   `claimGuestOrders` would find 0 orders under `guest_<phone>` and skip
 *   the cart_items UPDATE too (the cart_items row was still there but the
 *   function only re-runs if there are still GUEST rows for the phone —
 *   actually it always re-runs all three, so the cart would eventually
 *   migrate. But the original doc comment's claim of "no transaction
 *   needed" was still misleading).
 *
 *   The fix wraps all three UPDATEs in `db.transaction`. If any one fails,
 *   the entire migration rolls back — the guest's data stays intact under
 *   "guest_<phone>" and the next sign-in retries cleanly. READ COMMITTED
 *   isolation (the default) is sufficient because the UPDATEs don't have
 *   a read-then-write race — they're independent row rewrites keyed by
 *   userId. SERIALIZABLE (used by checkout) is unnecessary here and would
 *   add latency to the sign-in path.
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
import { ordersTable, cartItemsTable, wishlistTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Migrate guest orders + cart items + wishlist to a Clerk user account.
 *
 * Called by `authenticate()` in auth.ts when a new user is created
 * (or on sign-in if the user's phone changed and matches a guest phone).
 *
 * @param clerkId - The user's Clerk ID (the new owner of the rows).
 * @param phone - The user's phone number (normalized to bare-local form
 *   01XXXXXXXXX by the caller — see normalizeBdPhoneForStorage in
 *   lib/guestOtp.ts). If null/empty, no migration runs (the user has no
 *   phone in their Clerk profile, so there's nothing to match).
 * @returns the number of orders + cart items + wishlist rows migrated
 *   (0 if nothing matched, which is the normal case for a user who was
 *   never a guest). All three counts are 0 if the transaction rolled
 *   back due to a mid-migration failure — the guest's data stays under
 *   "guest_<phone>" and the next sign-in retries.
 */
export async function claimGuestOrders(
  clerkId: string,
  phone: string | null | undefined,
): Promise<{
  ordersMigrated: number;
  cartItemsMigrated: number;
  wishlistMigrated: number;
}> {
  if (!phone) {
    return { ordersMigrated: 0, cartItemsMigrated: 0, wishlistMigrated: 0 };
  }

  const guestUserId = `guest_${phone}`;

  try {
    // ── Atomic migration inside one transaction ────────────────────────────
    // All three UPDATEs run inside db.transaction so a mid-migration failure
    // rolls back the entire batch. Without this, a partial success (orders
    // migrated, cart_items failed) would leave the cart orphaned: the next
    // sign-in's claimGuestOrders call would find 0 orders under
    // `guest_<phone>` and the doc comment's "idempotent retry" claim would
    // hold — but only by accident, and the original migration would still
    // have left the data in an inconsistent state mid-flight. The explicit
    // transaction makes the all-or-nothing guarantee structural rather than
    // incidental.
    //
    // READ COMMITTED isolation (default) is sufficient — these UPDATEs have
    // no read-then-write race; they're independent row rewrites keyed by
    // userId. SERIALIZABLE would add latency without correctness benefit.
    const result = await db.transaction(async (tx) => {
      // Migrate orders — UPDATE WHERE userId = "guest_<phone>"
      const ordersResult = await tx
        .update(ordersTable)
        .set({ userId: clerkId, updatedAt: new Date() })
        .where(eq(ordersTable.userId, guestUserId));

      // Migrate cart items — UPDATE WHERE userId = "guest_<phone>".
      // Refresh expiresAt to 30 days from now so the migrated cart rows
      // don't immediately expire if the original guest add was near the
      // 30-day TTL boundary.
      const cartResult = await tx
        .update(cartItemsTable)
        .set({ userId: clerkId, updatedAt: new Date(), expiresAt: sql`NOW() + INTERVAL '30 days'` })
        .where(eq(cartItemsTable.userId, guestUserId));

      // Migrate wishlist — UPDATE WHERE userId = "guest_<phone>".
      // Same pattern as orders + cart_items. The wishlist table's FK to
      // users.clerk_id was dropped in migration 0015 (mirroring 0013 for
      // cart_items and 0014 for orders) so this UPDATE can land the rows
      // on a real clerkId without constraint violation.
      //
      // Note: wishlist has no updatedAt column (only addedAt, which records
      // when the buyer first wishlisted the item and shouldn't be touched
      // by a migration). Just userId is rewritten.
      const wishlistResult = await tx
        .update(wishlistTable)
        .set({ userId: clerkId })
        .where(eq(wishlistTable.userId, guestUserId));

      return {
        ordersMigrated: (ordersResult as any)?.rowCount ?? 0,
        cartItemsMigrated: (cartResult as any)?.rowCount ?? 0,
        wishlistMigrated: (wishlistResult as any)?.rowCount ?? 0,
      };
    });

    if (result.ordersMigrated > 0 || result.cartItemsMigrated > 0 || result.wishlistMigrated > 0) {
      logger.info(
        { clerkId, phone, ...result },
        "[accountClaim] Migrated guest orders + cart + wishlist to new account",
      );
    }

    return result;
  } catch (err) {
    // Non-fatal — the transaction rolled back, so the guest's data is
    // still intact under "guest_<phone>" and the next sign-in retries
    // cleanly. Don't throw — account creation must succeed even if the
    // migration fails.
    logger.error(
      { err, clerkId, phone },
      "[accountClaim] Failed to migrate guest data (non-fatal — transaction rolled back, guest data stays intact)",
    );
    return { ordersMigrated: 0, cartItemsMigrated: 0, wishlistMigrated: 0 };
  }
}
