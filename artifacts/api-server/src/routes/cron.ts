import { Router } from "express";
import { logger } from "../lib/logger";
import { runSellerSubscriptionExpiryJob, runSellerSubscriptionReminderJob } from "../jobs/sellerSubscriptionJob";
import { runLowStockAlert } from "../jobs/lowStockJob";
import { archiveLastMonth } from "./monthlyRecords";
import { runAbandonedCartJob } from "./abandonedCart";
import type { ApiRequest } from "../types/apiRequest";

const router = Router();

/**
 * Vercel Cron Jobs
 * ─────────────────
 * Vercel's `crons` field in vercel.json schedules HTTP requests to these
 * paths. Each request carries an `Authorization: Bearer <CRON_SECRET>`
 * header that Vercel sets from the project's CRON_SECRET env var — we
 * verify it here so an attacker can't trigger background jobs by hitting
 * these paths directly.
 *
 * Why this exists:
 *   On Render (long-lived process), background jobs run via setInterval
 *   in src/index.ts. On Vercel (serverless), setInterval doesn't work —
 *   each invocation is a fresh Lambda that freezes between requests.
 *   Without these cron endpoints, seller subscription expiry, monthly
 *   archiving, low-stock alerts, and abandoned-cart recovery emails
 *   would silently never run on Vercel deployments.
 *
 * CRON_SECRET:
 *   Set this in your Vercel project env vars. Generate with:
 *     openssl rand -base64 32
 *   Vercel automatically sends it as a Bearer token on every cron
 *   invocation. We compare with a constant-time check to prevent timing
 *   attacks (same pattern as courierWebhooks.ts's safeCompare).
 *
 * Idempotency:
 *   Every job here is idempotent by design — running it twice in the
 *   same hour does the same thing as running it once. This matters
 *   because Vercel retries failed cron invocations, and because the
 *   seller-subscription and monthly-archive crons both run hourly but
 *   only act on the 1st of the month / when a deadline is actually
 *   reached.
 */

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Constant-time string comparison to prevent timing attacks on the
 * secret. Returns true if the strings match, false otherwise. Handles
 * length mismatch safely (still does a full comparison to avoid leaking
 * length info via timing).
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a comparison to keep timing constant — use the longer
    // string's length so we always do the same amount of work.
    const maxLen = Math.max(a.length, b.length);
    let diff = 1;
    for (let i = 0; i < maxLen; i++) {
      diff |= (a.charCodeAt(i % a.length) ?? 0) ^ (b.charCodeAt(i % b.length) ?? 0);
    }
    return false; // length mismatch → not equal (loop above ran for constant-time)
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verifies the Vercel cron secret. Returns true if authorized, false
 * (and sends a 401) otherwise. If CRON_SECRET is not set, allows the
 * request in development but blocks it in production (fail-closed).
 */
function requireCronAuth(req: ApiRequest, res: any): boolean {
  if (!CRON_SECRET) {
    if (process.env.NODE_ENV === "production") {
      logger.error("CRON_SECRET env var is not set — cron jobs cannot be authenticated. Set it in your Vercel project env vars.");
      res.status(500).json({ error: "Cron authentication not configured" });
      return false;
    }
    // Dev: allow without secret so local testing works
    return true;
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing cron authorization" });
    return false;
  }
  const token = authHeader.slice("Bearer ".length);
  if (!safeCompare(token, CRON_SECRET)) {
    res.status(401).json({ error: "Invalid cron authorization" });
    return false;
  }
  return true;
}

/**
 * POST /api/cron/seller-subscriptions
 * Hourly. Runs both the expiry enforcement (hides listings for sellers
 * whose trial/subscription has lapsed) and the 7-day reminder email.
 */
router.post("/cron/seller-subscriptions", async (req, res) => {
  if (!requireCronAuth(req, res)) return;
  try {
    logger.info("Cron: running seller subscription jobs");
    // Expiry first: a seller whose deadline just passed should be
    // expired-and-hidden this run, not sent a "7 days left" reminder on
    // the same pass if some clock skew put them in both windows.
    await runSellerSubscriptionExpiryJob();
    await runSellerSubscriptionReminderJob();
    res.json({ ok: true, ran: ["expiry", "reminder"] });
  } catch (err) {
    logger.error({ err }, "Cron: seller subscription jobs failed");
    res.status(500).json({ error: "Cron job failed" });
  }
});

/**
 * POST /api/cron/monthly-archive
 * Hourly. Archives last month's order/revenue snapshot into
 * monthly_records, but only acts on the 1st of each month (the
 * archiveLastMonth function checks the date internally).
 */
router.post("/cron/monthly-archive", async (req, res) => {
  if (!requireCronAuth(req, res)) return;
  try {
    logger.info("Cron: running monthly archive check");
    const result = await archiveLastMonth();
    if (result.archived) {
      logger.info({ message: result.message }, "Cron: monthly archive completed");
    }
    res.json({ ok: true, archived: result.archived, message: result.message });
  } catch (err) {
    logger.error({ err }, "Cron: monthly archive failed");
    res.status(500).json({ error: "Cron job failed" });
  }
});

/**
 * POST /api/cron/low-stock
 * Daily at 9 AM. Sends a low-stock alert email to the admin if any
 * product variants are at or below the LOW_STOCK_THRESHOLD.
 */
router.post("/cron/low-stock", async (req, res) => {
  if (!requireCronAuth(req, res)) return;
  try {
    logger.info("Cron: running low-stock alert check");
    await runLowStockAlert();
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Cron: low-stock alert failed");
    res.status(500).json({ error: "Cron job failed" });
  }
});

/**
 * POST /api/cron/abandoned-cart
 * Hourly. Sends recovery emails to carts abandoned 24+ hours ago.
 */
router.post("/cron/abandoned-cart", async (req, res) => {
  if (!requireCronAuth(req, res)) return;
  try {
    logger.info("Cron: running abandoned cart recovery job");
    await runAbandonedCartJob();
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Cron: abandoned cart job failed");
    res.status(500).json({ error: "Cron job failed" });
  }
});

export default router;
