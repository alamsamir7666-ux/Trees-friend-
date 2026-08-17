/**
 * Daily cost-reset + summary job.
 *
 * Runs at 9 AM UTC (configured in vercel.json / Render cron) to:
 *   1. Fire the daily summary email/webhook (yesterday's total spend).
 *   2. Rollover the daily counter (Redis keys naturally roll over because
 *      they include the date, but this job logs the rollover for observability).
 *
 * The circuit auto-resets at UTC midnight because the circuit-open key
 * also includes the date — so this job doesn't NEED to clear it. But it
 * DOES need to fire the summary alert so the admin gets a daily report
 * even on quiet days (no email otherwise).
 *
 * Vercel: scheduled via `vercel.json` crons → POST /api/cron/ai-cost-daily-reset
 * Render: setInterval in src/index.ts
 */

import { rolloverDay, getDailyBudgetUsd } from "../lib/costTracker";
import { sendDailySummary } from "../lib/costAlerts";
import { logger } from "../lib/logger";

export async function runCostDailyReset(): Promise<void> {
  const budget = getDailyBudgetUsd();
  logger.info({ budget }, "costDailyReset: running daily cost rollover + summary");

  try {
    // rolloverDay returns yesterday's spend (the counter is naturally
    // date-keyed so it "rolled over" at UTC midnight already; this just
    // snapshots the value for the summary email).
    const { yesterdaySpend } = await rolloverDay();

    // Fire the daily summary alert (email + webhook + in-app event).
    // No-op if both email + webhook are unset.
    await sendDailySummary(yesterdaySpend);

    logger.info({ yesterdaySpend }, "costDailyReset: completed — summary alert dispatched");
  } catch (err) {
    logger.error(
      { err: (err as Error)?.message ?? String(err) },
      "costDailyReset: failed (non-fatal — circuit + counter still work)",
    );
  }
}
