import { Router } from "express";
import { logger } from "../lib/logger";
import {
  runSellerSubscriptionExpiryJob,
  runSellerSubscriptionReminderJob,
} from "../jobs/sellerSubscriptionJob";
import { runLowStockAlert } from "../jobs/lowStockJob";
import { runPaymentExpirationJob } from "../jobs/paymentExpirationJob";
import { runAiFeedbackDigest } from "../jobs/aiFeedbackDigest";
import { runAiSessionCleanup } from "../jobs/aiSessionCleanup";
import { runKbEmbeddingJob } from "../jobs/kbEmbeddingJob";
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
    let _diff = 1;
    for (let i = 0; i < maxLen; i++) {
      _diff |= (a.charCodeAt(i % a.length) ?? 0) ^ (b.charCodeAt(i % b.length) ?? 0);
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
      logger.error(
        "CRON_SECRET env var is not set — cron jobs cannot be authenticated. Set it in your Vercel project env vars.",
      );
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

/**
 * POST /api/cron/payment-expiration
 * Every 5 minutes. Cancels bKash orders that have been in
 * payment_pending for more than 60 minutes (the buyer abandoned the
 * hosted payment page without completing). Restores stock for each
 * cancelled order so the inventory is available to other buyers.
 */
router.post("/cron/payment-expiration", async (req, res) => {
  if (!requireCronAuth(req, res)) return;
  try {
    logger.info("Cron: running payment-pending expiration job");
    await runPaymentExpirationJob();
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Cron: payment expiration job failed");
    res.status(500).json({ error: "Cron job failed" });
  }
});

/**
 * POST /api/cron/ai-feedback-digest
 * Weekly (Mondays 9 AM). Sends a digest email to ADMIN_EMAIL with the
 * week's 👎 feedback + headline stats. Skipped silently if
 * RESEND_API_KEY or ADMIN_EMAIL is not configured.
 */
router.post("/cron/ai-feedback-digest", async (req, res) => {
  if (!requireCronAuth(req, res)) return;
  try {
    logger.info("Cron: running AI feedback digest");
    const result = await runAiFeedbackDigest();
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err }, "Cron: AI feedback digest failed");
    res.status(500).json({ error: "Cron job failed" });
  }
});

/**
 * POST /api/cron/ai-session-cleanup
 * Daily at 3 AM. Deletes anonymous AI chat sessions whose updated_at is
 * older than AI_SESSION_TTL_DAYS (default 30). CASCADE deletes the
 * associated messages, feedback, and events.
 *
 * Only anonymous sessions (user_id IS NULL) are deleted -- logged-in
 * users' sessions are part of their history and persist indefinitely.
 */
router.post("/cron/ai-session-cleanup", async (req, res) => {
  if (!requireCronAuth(req, res)) return;
  try {
    logger.info("Cron: running AI session cleanup");
    const result = await runAiSessionCleanup();
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err }, "Cron: AI session cleanup failed");
    res.status(500).json({ error: "Cron job failed" });
  }
});

/**
 * POST /api/cron/kb-embeddings
 * Every 5 minutes. Generates Gemini text-embedding-004 vectors for KB
 * entries with `embedding_status = 'pending'`. Processes up to 10 entries
 * per run (configurable via the `limit` query param, max 50). Stops
 * early if Gemini returns 429 (rate limit) — the next run will retry.
 *
 * On long-lived Render processes, this also runs via setInterval in
 * src/index.ts (every 30 seconds). The cron endpoint is for Vercel
 * serverless, where setInterval doesn't work.
 *
 * Idempotent: pending entries are processed at most once per run. If
 * two runs overlap (interval + cron fire at the same time), the second
 * run's UPDATE is a no-op (it overwrites the same embedding with the
 * same value).
 */
router.post("/cron/kb-embeddings", async (req, res) => {
  if (!requireCronAuth(req, res)) return;
  try {
    logger.info("Cron: running KB embedding job");
    await runKbEmbeddingJob();
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Cron: KB embedding job failed");
    res.status(500).json({ error: "Cron job failed" });
  }
});

export default router;
