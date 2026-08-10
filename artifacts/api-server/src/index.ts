import app from "./app";
import { logger } from "./lib/logger";
import { archiveLastMonth } from "./routes/monthlyRecords";
import {
  runSellerSubscriptionReminderJob,
  runSellerSubscriptionExpiryJob,
} from "./jobs/sellerSubscriptionJob";
import { runPaymentExpirationJob } from "./jobs/paymentExpirationJob";

// Note: ensureConversationsTables() is invoked from app.ts at module load,
// so it runs on every cold start (including Vercel serverless). We do NOT
// call it again here to avoid a redundant DB round-trip on long-lived
// processes.

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Monthly archiving scheduler — runs every hour, archives on the 1st of the month
  scheduleMonthlyArchive();

  // Seller subscription reminder + expiry enforcement — runs every hour
  scheduleSellerSubscriptionChecks();

  // Payment-pending order expiration — runs every 5 minutes, cancels
  // bKash orders abandoned at the hosted payment page for 60+ minutes.
  // Restores stock so the inventory is available to other buyers.
  schedulePaymentExpiration();
});

// ─── Keep-alive: ping self every 14 min so Render free tier never sleeps ─────
// Render free instances sleep after 15 min of inactivity. This self-ping
// prevents that without any external service.
if (process.env.NODE_ENV === "production" && process.env.RENDER_EXTERNAL_URL) {
  const PING_INTERVAL_MS = 14 * 60 * 1000; // 14 minutes
  setInterval(async () => {
    try {
      await fetch(`${process.env.RENDER_EXTERNAL_URL}/health`);
      logger.info("Keep-alive ping sent");
    } catch (err) {
      logger.warn({ err }, "Keep-alive ping failed");
    }
  }, PING_INTERVAL_MS);
}

function scheduleMonthlyArchive() {
  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  async function tryArchive() {
    const now = new Date();
    if (now.getDate() === 1) {
      try {
        const result = await archiveLastMonth();
        if (result.archived) {
          logger.info({ msg: result.message }, "Monthly archive completed");
        }
      } catch (err) {
        logger.error({ err }, "Monthly archive failed");
      }
    }
  }

  // Run once at startup in case we missed it
  tryArchive().catch(() => {});

  setInterval(tryArchive, CHECK_INTERVAL_MS);
}

function scheduleSellerSubscriptionChecks() {
  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  async function runChecks() {
    // Expiry runs first: a seller whose deadline has already passed should
    // be expired-and-hidden this run, not sent a "7 days left" reminder on
    // the same pass if some clock skew put them in both windows.
    await runSellerSubscriptionExpiryJob();
    await runSellerSubscriptionReminderJob();
  }

  // Run once at startup in case we missed it
  runChecks().catch(() => {});

  setInterval(() => {
    runChecks().catch(() => {});
  }, CHECK_INTERVAL_MS);
}

/**
 * Payment-pending order expiration scheduler (Render long-lived process).
 * Runs every 5 minutes — cancels bKash orders that have been in
 * payment_pending for 60+ minutes and restores their stock. On Vercel
 * (serverless), this runs via POST /api/cron/payment-expiration instead
 * (see routes/cron.ts + vercel.json).
 */
function schedulePaymentExpiration() {
  const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  // Run once at startup in case we missed expired orders while down.
  runPaymentExpirationJob().catch((err) => {
    logger.warn({ err }, "Payment expiration job failed at startup");
  });

  setInterval(() => {
    runPaymentExpirationJob().catch((err) => {
      logger.warn({ err }, "Payment expiration job failed");
    });
  }, CHECK_INTERVAL_MS);
}
