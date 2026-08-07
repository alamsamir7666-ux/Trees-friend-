import { db } from "@workspace/db";
import { sellersTable, sellerListingsTable, usersTable } from "@workspace/db";
import { eq, and, isNull, lte, or } from "drizzle-orm";
import { sendSubscriptionReminderEmail, sendSubscriptionExpiredEmail } from "../lib/email";
import { logger } from "../lib/logger";

const REMINDER_DAYS_BEFORE_EXPIRY = 7;

/**
 * The date a given seller's current free period ends: trialEndsAt while on
 * trial, subscriptionExpiresAt once they've paid at least once. A seller
 * with neither set has no deadline yet (e.g. still pending_verification)
 * and is skipped by both jobs below.
 */
function currentDeadline(seller: { trialEndsAt: Date | null; subscriptionExpiresAt: Date | null }) {
  return seller.subscriptionExpiresAt ?? seller.trialEndsAt ?? null;
}

/**
 * Sends a one-time reminder email ~7 days before a seller's trial or paid
 * subscription period ends, telling them to pay the 500 taka fee or their
 * listings will disappear from the site. Idempotent per cycle via
 * sellers.reminderSentAt -- admin's mark-as-paid action clears that field
 * when it extends subscriptionExpiresAt, so the next cycle gets its own
 * reminder.
 */
export async function runSellerSubscriptionReminderJob() {
  const now = new Date();
  const reminderCutoff = new Date(now.getTime() + REMINDER_DAYS_BEFORE_EXPIRY * 24 * 60 * 60 * 1000);

  try {
    const candidates = await db
      .select()
      .from(sellersTable)
      .where(
        and(
          isNull(sellersTable.reminderSentAt),
          or(
            and(isNull(sellersTable.subscriptionExpiresAt), lte(sellersTable.trialEndsAt, reminderCutoff)),
            lte(sellersTable.subscriptionExpiresAt, reminderCutoff),
          ),
        ),
      );

    let sent = 0;
    for (const seller of candidates) {
      const deadline = currentDeadline(seller);
      if (!deadline || deadline < now) continue; // already past due -- expiry job handles this, not the reminder

      if (!seller.contactEmail) continue;

      await sendSubscriptionReminderEmail({
        to: seller.contactEmail,
        businessName: seller.businessName,
        deadline,
      });

      await db
        .update(sellersTable)
        .set({ reminderSentAt: now })
        .where(eq(sellersTable.id, seller.id));

      sent++;
    }

    logger.info({ sent, checked: candidates.length }, "[seller-subscription] Reminder job complete");
  } catch (err) {
    logger.error({ err }, "[seller-subscription] Reminder job failed");
  }
}

/**
 * Enforces subscription expiry: any seller whose trial/subscription
 * deadline has passed without payment gets subscriptionStatus flipped to
 * "expired" and all of their currently-public listings hidden
 * (visibility = "hidden", hiddenReason = "subscription_expired").
 *
 * Listings are hidden, never deleted, per plan doc §5. hiddenReason
 * distinguishes this from a seller's own vacation-mode/manual hide, so
 * admin's mark-as-paid restore only un-hides listings THIS job hid.
 *
 * Idempotent by construction: a seller already subscriptionStatus =
 * "expired" is excluded from the query, so re-running hourly doesn't
 * re-send the expired email or redundantly re-hide already-hidden listings.
 */
export async function runSellerSubscriptionExpiryJob() {
  const now = new Date();

  try {
    const expiring = await db
      .select()
      .from(sellersTable)
      .where(
        and(
          eq(sellersTable.subscriptionStatus, "trial"),
          lte(sellersTable.trialEndsAt, now),
        ),
      );

    const expiringPaid = await db
      .select()
      .from(sellersTable)
      .where(
        and(
          eq(sellersTable.subscriptionStatus, "active"),
          lte(sellersTable.subscriptionExpiresAt, now),
        ),
      );

    const toExpire = [...expiring, ...expiringPaid];

    for (const seller of toExpire) {
      await db
        .update(sellersTable)
        .set({ subscriptionStatus: "expired", updatedAt: now })
        .where(eq(sellersTable.id, seller.id));

      await db
        .update(sellerListingsTable)
        .set({ visibility: "hidden", hiddenReason: "subscription_expired", updatedAt: now })
        .where(
          and(
            eq(sellerListingsTable.sellerId, seller.id),
            eq(sellerListingsTable.visibility, "public"),
          ),
        );

      if (seller.contactEmail) {
        await sendSubscriptionExpiredEmail({
          to: seller.contactEmail,
          businessName: seller.businessName,
        });
      }
    }

    logger.info({ expired: toExpire.length }, "[seller-subscription] Expiry job complete");
  } catch (err) {
    logger.error({ err }, "[seller-subscription] Expiry job failed");
  }
}
