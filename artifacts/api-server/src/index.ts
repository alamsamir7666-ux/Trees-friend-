import app from "./app";
import { logger } from "./lib/logger";
import { archiveLastMonth } from "./routes/monthlyRecords";
import {
  runSellerSubscriptionReminderJob,
  runSellerSubscriptionExpiryJob,
} from "./jobs/sellerSubscriptionJob";
import { runPaymentExpirationJob } from "./jobs/paymentExpirationJob";
import { runAiSessionCleanup } from "./jobs/aiSessionCleanup";
import { runKbEmbeddingJob } from "./jobs/kbEmbeddingJob";
import { runKbToneProfileJob } from "./jobs/kbToneProfileJob";
import { startBm25StatsJob } from "./jobs/bm25StatsJob";

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

  // AI session TTL cleanup — runs daily, deletes anonymous chat sessions
  // inactive for AI_SESSION_TTL_DAYS (default 30). Keeps the ai_chat_*
  // tables from growing unbounded.
  scheduleAiSessionCleanup();

  // KB embedding generation — runs every 30 seconds, generates Gemini
  // gemini-embedding-001 vectors (BUG-E1 fix, was text-embedding-004)
  // for KB entries with embedding_status = 'pending'. Phase 2 background
  // job. On Vercel (serverless), this runs via POST /api/cron/kb-embeddings
  // instead.
  scheduleKbEmbeddingJob();

  // KB tone profile generation — runs every 5 minutes, generates +
  // regenerates creator tone profiles for creators with 10+ entries.
  // Phase 4 background job. On Vercel (serverless), this runs via
  // POST /api/cron/kb-tone-profiles instead.
  scheduleKbToneProfileJob();

  // v5.0: BM25 term stats refresh — runs every 6 hours, rebuilds the
  // ai_kb_term_stats table (IDF values for every lexeme in the KB).
  // Critical for BM25 scoring accuracy — without fresh stats, rare-vs-
  // common term weighting drifts. On Vercel (serverless), this runs via
  // POST /api/cron/kb-bm25-stats instead.
  startBm25StatsJob();
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

/**
 * AI session TTL cleanup scheduler (Render long-lived process).
 * Runs every 24 hours -- deletes anonymous chat sessions whose
 * updated_at is older than AI_SESSION_TTL_DAYS (default 30).
 *
 * On Vercel (serverless), this runs via POST /api/cron/ai-session-cleanup
 * instead (see routes/cron.ts + vercel.json).
 *
 * The first run is scheduled 24h after server start (not immediately) to
 * avoid doing cleanup work during the startup burst.
 */
function scheduleAiSessionCleanup() {
  const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  setInterval(() => {
    runAiSessionCleanup().catch((err) => {
      logger.warn({ err }, "AI session cleanup job failed");
    });
  }, CHECK_INTERVAL_MS);

  logger.info("AI session cleanup scheduler started (runs every 24h)");
}

/**
 * KB embedding generation scheduler (Render long-lived process).
 * Runs every 30 seconds — generates Gemini gemini-embedding-001 vectors
 * (BUG-E1 fix, was text-embedding-004) for KB entries with
 * `embedding_status = 'pending'` (up to 10 per run).
 *
 * On Vercel (serverless), this runs via POST /api/cron/kb-embeddings
 * instead (see routes/cron.ts + vercel.json).
 *
 * The first run is scheduled 30s after server start (not immediately)
 * to avoid competing with the cold-start DB migration (ensureAiTables).
 */
function scheduleKbEmbeddingJob() {
  const CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

  // Delay the first run by 30s so it doesn't compete with the cold-start
  // migration (ensureAiTables runs at app.ts load time + takes ~1-2s).
  setTimeout(() => {
    runKbEmbeddingJob().catch((err) => {
      logger.warn({ err }, "KB embedding job failed at startup");
    });
    setInterval(() => {
      runKbEmbeddingJob().catch((err) => {
        logger.warn({ err }, "KB embedding job failed");
      });
    }, CHECK_INTERVAL_MS);
  }, CHECK_INTERVAL_MS);

  logger.info("KB embedding scheduler started (runs every 30s)");
}

/**
 * KB tone profile generation scheduler (Render long-lived process).
 * Runs every 5 minutes — generates + regenerates creator tone profiles
 * for creators with 10+ entries who need new/regenerated profiles.
 *
 * On Vercel (serverless), this runs via POST /api/cron/kb-tone-profiles
 * instead (see routes/cron.ts).
 *
 * The first run is delayed by 2 minutes so it doesn't compete with the
 * cold-start migration (ensureAiTables) + the embedding job's first run
 * (30s delay). Tone profiles are the lowest-priority background job —
 * they affect response tone, not correctness, so a 2 min startup delay
 * is fine.
 */
function scheduleKbToneProfileJob() {
  const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const STARTUP_DELAY_MS = 2 * 60 * 1000; // 2 minutes

  setTimeout(() => {
    runKbToneProfileJob().catch((err) => {
      logger.warn({ err }, "KB tone profile job failed at startup");
    });
    setInterval(() => {
      runKbToneProfileJob().catch((err) => {
        logger.warn({ err }, "KB tone profile job failed");
      });
    }, CHECK_INTERVAL_MS);
  }, STARTUP_DELAY_MS);

  logger.info("KB tone profile scheduler started (runs every 5 min, first run in 2 min)");
}
