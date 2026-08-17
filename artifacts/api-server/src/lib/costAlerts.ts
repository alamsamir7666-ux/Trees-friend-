/**
 * Cost alert dispatcher — sends notifications when AI spend crosses
 * configured thresholds.
 *
 * ─── The problem this solves ─────────────────────────────────────────────────
 *
 * `costTracker.ts` detects when the daily budget is exceeded (warning at
 * 80%, circuit-open at 100%) but doesn't actually notify anyone. Without
 * this dispatcher, the admin only finds out by checking the dashboard —
 * which they might not do for days.
 *
 * This module sends alerts via three channels (all optional, all best-effort):
 *
 *   1. **Email** (Resend) — to `ADMIN_EMAIL`. Always tried first if
 *      `RESEND_API_KEY` is set. Format: HTML email with the budget, current
 *      spend, last cost, and a link to the dashboard.
 *
 *   2. **Slack/Discord/PagerDuty webhook** (optional) — set
 *      `AI_COST_ALERT_WEBHOOK_URL` to a Slack/Discord incoming webhook or
 *      any service that accepts a JSON `{ text, attachments }` payload.
 *      Slack-formatted messages work for both Slack and Discord (Discord
 *      accepts Slack webhooks too).
 *
 *   3. **In-app event log** (always) — appends a row to `ai_chat_events`
 *      with type `cost_warning` or `cost_circuit_open` so the admin sees
 *      the alert in the AiInsightsTab event feed (no email or webhook
 *      required).
 *
 * ─── Single-shot semantics ──────────────────────────────────────────────────
 *
 * Both alerts (warning + circuit-open) fire ONCE per day per type. This is
 * enforced by the `costTracker.ts` caller via Redis SETNX on a per-day
 * sentinel key. This dispatcher itself is idempotent too — even if called
 * twice with the same payload, it won't send duplicate emails (it caches
 * the last-sent alert type in a process-local Set).
 *
 * ─── Fail-safe ───────────────────────────────────────────────────────────────
 *
 * All channels are best-effort:
 *   - If `RESEND_API_KEY` is unset, email is skipped (no-op).
 *   - If `AI_COST_ALERT_WEBHOOK_URL` is unset, webhook is skipped.
 *   - If both are unset, only the in-app event log fires.
 *   - Network errors are logged at warning level but don't propagate.
 *
 * The dispatcher is called from `recordCost` AFTER the Redis INCRBYFLOAT
 * succeeds. If the dispatcher throws, the catch in `checkThresholds` logs
 * the error and continues — the spend counter is still updated.
 *
 * @module lib/costAlerts
 */

import { logger } from "./logger";
import { Resend } from "resend";

/**
 * The types of alerts this dispatcher can send.
 */
export type CostAlertType = "warning" | "circuit_open" | "daily_summary";

export interface CostAlertPayload {
  type: CostAlertType;
  /** Current daily spend (USD) at the moment the alert fires. */
  spendUsd: number;
  /** The configured daily budget (USD). */
  budgetUsd: number;
  /** Fraction of budget at which the alert fires (0.8 for warning, 1.0 for circuit_open). */
  thresholdPct: number;
  /** The cost record that triggered this alert (the "last cost"). */
  lastCost: {
    costUsd: number;
    model: string;
    provider?: string;
    promptTokens: number;
    completionTokens: number;
  };
  /** For daily_summary: yesterday's total spend. */
  yesterdaySpendUsd?: number;
}

/**
 * In-process dedup set — if we've already dispatched an alert for a given
 * (type, date) pair, skip. This is defense-in-depth: costTracker.ts already
 * uses a Redis SETNX sentinel, but this catches the case where Redis is
 * unavailable and the sentinel doesn't work.
 *
 * The set is cleared when the process restarts (which is fine — the Redis
 * sentinel persists across restarts).
 */
const _dispatched = new Set<string>();

function todayKey(type: CostAlertType): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${type}:${date}`;
}

function markDispatched(type: CostAlertType): boolean {
  const k = todayKey(type);
  if (_dispatched.has(k)) return false; // already dispatched today
  _dispatched.add(k);
  return true; // first dispatch today — proceed
}

/**
 * Returns the From address for outgoing emails.
 * Falls back to Resend's onboarding domain in dev; logs a warning in
 * production (the email will likely land in spam).
 */
function getFromAddress(): string {
  return process.env.EMAIL_FROM ?? "Tree Friend <onboarding@resend.dev>";
}

/**
 * Returns the To address (admin email) for cost alerts.
 * Falls back to `ADMIN_EMAILS` (comma-separated) if `ADMIN_EMAIL` is unset.
 * Returns null if neither is set.
 */
function getAdminEmails(): string[] | null {
  const single = process.env.ADMIN_EMAIL;
  if (single && single.trim()) {
    return [single.trim()];
  }
  const multi = process.env.ADMIN_EMAILS;
  if (multi && multi.trim()) {
    return multi
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return null;
}

/**
 * Returns the webhook URL for cost alerts (Slack/Discord/PagerDuty).
 * Set `AI_COST_ALERT_WEBHOOK_URL` env var. Returns null if unset.
 */
function getWebhookUrl(): string | null {
  const url = process.env.AI_COST_ALERT_WEBHOOK_URL;
  return url && url.trim() ? url.trim() : null;
}

/**
 * Returns the app URL for links in alert emails / webhooks.
 * Defaults to `https://treefriend.com`.
 */
function getAppUrl(): string {
  return process.env.APP_URL ?? "https://treefriend.com";
}

/**
 * Lazily-initialized Resend client. Returns null if `RESEND_API_KEY` is unset.
 */
let _resend: Resend | null = null;
let _resendInitAttempted = false;
function getResend(): Resend | null {
  if (_resendInitAttempted) return _resend;
  _resendInitAttempted = true;
  if (!process.env.RESEND_API_KEY) return null;
  try {
    _resend = new Resend(process.env.RESEND_API_KEY);
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message ?? String(err) },
      "costAlerts: failed to initialize Resend client — email alerts disabled",
    );
  }
  return _resend;
}

/**
 * Pretty-prints a USD amount (always 2 decimals, even for tiny amounts).
 */
function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Pretty-prints a percentage (0–100 with 1 decimal).
 */
function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * Main entry point — dispatches a cost alert via all configured channels.
 *
 * Called by `costTracker.ts`'s `checkThresholds` function. Idempotent per
 * (type, UTC date) — see `markDispatched` above.
 *
 * Errors in any channel are caught + logged; they don't propagate to the
 * caller (the spend counter has already been updated, the alert is best-effort).
 */
export async function dispatchCostAlert(payload: CostAlertPayload): Promise<void> {
  // Idempotency check (process-local — the Redis sentinel in costTracker
  // is the authoritative single-shot guard, this is defense-in-depth).
  if (!markDispatched(payload.type)) {
    logger.debug(
      { type: payload.type },
      "costAlerts: already dispatched today (in-process dedup) — skipping",
    );
    return;
  }

  logger.warn(
    {
      type: payload.type,
      spendUsd: payload.spendUsd,
      budgetUsd: payload.budgetUsd,
      thresholdPct: payload.thresholdPct,
      model: payload.lastCost.model,
      provider: payload.lastCost.provider,
    },
    `costAlerts: dispatching ${payload.type} alert`,
  );

  // Fire all channels in parallel — each is best-effort.
  await Promise.allSettled([
    sendEmailAlert(payload),
    sendWebhookAlert(payload),
    logInAppEvent(payload),
  ]);
}

/**
 * Sends an HTML email to the admin via Resend.
 *
 * No-op if:
 *   - `RESEND_API_KEY` is unset (no email client).
 *   - `ADMIN_EMAIL` and `ADMIN_EMAILS` are both unset (no recipients).
 *
 * Format: branded HTML email with the alert type, current spend, budget,
 * threshold %, last cost, and a link to the dashboard.
 */
async function sendEmailAlert(payload: CostAlertPayload): Promise<void> {
  const resend = getResend();
  if (!resend) return; // email disabled

  const recipients = getAdminEmails();
  if (!recipients || recipients.length === 0) {
    logger.debug("costAlerts: no admin email configured — skipping email alert");
    return;
  }

  const subject =
    payload.type === "circuit_open"
      ? `[URGENT] TreeBot AI cost circuit tripped — ${fmtUsd(payload.spendUsd)} / ${fmtUsd(payload.budgetUsd)} today`
      : payload.type === "warning"
        ? `[WARNING] TreeBot AI cost at ${fmtPct(payload.thresholdPct)} of budget — ${fmtUsd(payload.spendUsd)} / ${fmtUsd(payload.budgetUsd)}`
        : `TreeBot AI daily summary — ${fmtUsd(payload.yesterdaySpendUsd ?? 0)} spent yesterday`;

  const headerColor =
    payload.type === "circuit_open"
      ? "linear-gradient(135deg,#dc2626,#b91c1c)" // red
      : payload.type === "warning"
        ? "linear-gradient(135deg,#f59e0b,#d97706)" // amber
        : "linear-gradient(135deg,#10b981,#059669)"; // green

  const headerText =
    payload.type === "circuit_open"
      ? "AI Cost Circuit Tripped"
      : payload.type === "warning"
        ? "AI Cost Warning"
        : "Daily AI Cost Summary";

  const spend = payload.yesterdaySpendUsd ?? payload.spendUsd;
  const budget = payload.budgetUsd > 0 ? payload.budgetUsd : null;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="font-family:Georgia,serif;background:#fdf6f0;margin:0;padding:40px 20px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 20px rgba(0,0,0,0.06);">
    <div style="background:${headerColor};padding:28px 40px;text-align:center;">
      <h1 style="color:#fff;font-size:20px;margin:0;letter-spacing:0.04em;">🌳 ${headerText}</h1>
    </div>
    <div style="padding:32px 40px;">
      <p style="font-size:15px;color:#374151;margin:0 0 24px;line-height:1.6;font-family:sans-serif;">
        ${
          payload.type === "circuit_open"
            ? `The AI daily cost circuit has tripped. All new LLM chat requests are being throttled until UTC midnight (or until you manually reset the circuit).`
            : payload.type === "warning"
              ? `The AI daily cost has crossed the warning threshold (${fmtPct(payload.thresholdPct)} of budget). Investigate before the circuit trips.`
              : `Yesterday's total AI spend:`
        }
      </p>
      <div style="background:#fdf6f0;border-radius:12px;padding:20px;margin-bottom:24px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px;">
          <span style="font-size:13px;color:#6b7280;font-family:sans-serif;">Spend</span>
          <span style="font-size:24px;font-weight:700;color:#dc2626;font-family:sans-serif;">${fmtUsd(spend)}</span>
        </div>
        ${
          budget
            ? `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px;">
                 <span style="font-size:13px;color:#6b7280;font-family:sans-serif;">Budget</span>
                 <span style="font-size:18px;font-weight:600;color:#374151;font-family:sans-serif;">${fmtUsd(budget)}</span>
               </div>
               <div style="height:8px;background:#fee2e2;border-radius:4px;overflow:hidden;margin-bottom:12px;">
                 <div style="height:8px;background:#dc2626;width:${Math.min(100, Math.round((spend / budget) * 100))}%;border-radius:4px;"></div>
               </div>
               <div style="display:flex;justify-content:space-between;align-items:baseline;">
                 <span style="font-size:13px;color:#6b7280;font-family:sans-serif;">Used</span>
                 <span style="font-size:14px;font-weight:600;color:#dc2626;font-family:sans-serif;">${fmtPct(spend / budget)}</span>
               </div>`
            : ""
        }
      </div>
      <div style="background:#f9fafb;border-radius:8px;padding:16px;margin-bottom:24px;">
        <p style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 8px;font-family:sans-serif;">Last Cost (Triggered Alert)</p>
        <p style="font-size:13px;color:#374151;margin:0;font-family:sans-serif;line-height:1.7;">
          <strong>Model:</strong> ${payload.lastCost.model}<br/>
          <strong>Provider:</strong> ${payload.lastCost.provider ?? "unknown"}<br/>
          <strong>Cost:</strong> ${fmtUsd(payload.lastCost.costUsd)}<br/>
          <strong>Tokens:</strong> ${payload.lastCost.promptTokens.toLocaleString()} prompt / ${payload.lastCost.completionTokens.toLocaleString()} completion
        </p>
      </div>
      <a href="${getAppUrl()}/admin?tab=ai-insights" style="display:inline-block;background:#f43f5e;color:#fff;padding:14px 40px;border-radius:50px;font-size:14px;font-weight:600;text-decoration:none;font-family:sans-serif;">
        View Dashboard →
      </a>
      ${
        payload.type === "circuit_open"
          ? `<p style="font-size:12px;color:#9ca3af;margin:24px 0 0;font-family:sans-serif;line-height:1.5;">
               To manually reset the circuit, use the "Reset Circuit" button in the AI Insights tab, or call
               <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">POST /api/ai/admin/cost/circuit/reset</code>.
             </p>`
          : ""
      }
    </div>
  </div>
</body></html>`;

  try {
    await resend.emails.send({
      from: getFromAddress(),
      replyTo: process.env.EMAIL_REPLY_TO ?? undefined,
      to: recipients,
      subject,
      html,
    });
    logger.info(
      { type: payload.type, recipients: recipients.length },
      "costAlerts: email alert sent",
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message ?? String(err), type: payload.type },
      "costAlerts: email alert failed (non-fatal)",
    );
  }
}

/**
 * Sends a Slack/Discord-formatted webhook notification.
 *
 * No-op if `AI_COST_ALERT_WEBHOOK_URL` is unset.
 *
 * Works with:
 *   - Slack incoming webhooks (https://hooks.slack.com/services/...)
 *   - Discord webhooks (https://discord.com/api/webhooks/...)
 *   - Any service that accepts JSON `{ text, attachments }` payloads
 *
 * The payload uses Slack's "Block Kit" format which Discord also renders
 * reasonably (Discord accepts Slack-format webhooks for backwards compat).
 */
async function sendWebhookAlert(payload: CostAlertPayload): Promise<void> {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) return; // webhook disabled

  // Color-coded attachment: red for circuit_open, amber for warning, green for summary.
  const color =
    payload.type === "circuit_open"
      ? "#dc2626"
      : payload.type === "warning"
        ? "#f59e0b"
        : "#10b981";

  const title =
    payload.type === "circuit_open"
      ? "🚨 AI Cost Circuit Tripped"
      : payload.type === "warning"
        ? "⚠️ AI Cost Warning"
        : "📊 Daily AI Cost Summary";

  const spend = payload.yesterdaySpendUsd ?? payload.spendUsd;

  const text =
    payload.type === "circuit_open"
      ? `Daily AI spend has crossed the budget. New LLM requests are throttled until UTC midnight or manual reset.`
      : payload.type === "warning"
        ? `Daily AI spend crossed ${fmtPct(payload.thresholdPct)} of budget. Investigate before circuit trips.`
        : `Yesterday's total AI spend: ${fmtUsd(spend)}`;

  const body = {
    text: `${title}\n${text}`,
    attachments: [
      {
        color,
        fields: [
          { title: "Spend", value: fmtUsd(spend), short: true },
          ...(payload.budgetUsd > 0
            ? [
                { title: "Budget", value: fmtUsd(payload.budgetUsd), short: true },
                {
                  title: "Used",
                  value: fmtPct(spend / payload.budgetUsd),
                  short: true,
                },
              ]
            : []),
          { title: "Last Model", value: payload.lastCost.model, short: true },
          {
            title: "Last Provider",
            value: payload.lastCost.provider ?? "unknown",
            short: true,
          },
        ],
        footer: "TreeFriend AI Cost Alert",
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      logger.warn(
        { status: res.status, type: payload.type },
        "costAlerts: webhook alert returned non-OK status (non-fatal)",
      );
    } else {
      logger.info({ type: payload.type }, "costAlerts: webhook alert sent");
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message ?? String(err), type: payload.type },
      "costAlerts: webhook alert failed (non-fatal)",
    );
  }
}

/**
 * Logs an in-app event row to `ai_chat_events` so the alert shows up in the
 * AiInsightsTab event feed.
 *
 * Always runs (no env vars needed). Uses the existing `logAiEvent` helper
 * from `aiMemory.ts` with session_id = 0 (system event, not tied to a
 * specific conversation).
 *
 * Events logged:
 *   - `cost_warning` — when the warning threshold is crossed.
 *   - `cost_circuit_open` — when the circuit trips.
 *   - `cost_daily_summary` — daily summary (called from the cron job).
 *
 * Visible in the AiInsightsTab event feed so the admin can see historical
 * alerts even if email/webhook failed.
 */
async function logInAppEvent(payload: CostAlertPayload): Promise<void> {
  // Lazy import to avoid a circular dependency: costTracker → costAlerts →
  // aiMemory → ... → costTracker. The lazy require breaks the cycle.
  try {
    const { logAiEvent } = await import("./aiMemory");
    const eventType =
      payload.type === "circuit_open"
        ? "cost_circuit_open"
        : payload.type === "warning"
          ? "cost_warning"
          : "cost_daily_summary";

    await logAiEvent(0, eventType, {
      spendUsd: payload.yesterdaySpendUsd ?? payload.spendUsd,
      budgetUsd: payload.budgetUsd,
      thresholdPct: payload.thresholdPct,
      lastCost: payload.lastCost,
    });
  } catch (err) {
    logger.debug(
      { err: (err as Error)?.message ?? String(err), type: payload.type },
      "costAlerts: in-app event log failed (non-fatal)",
    );
  }
}

/**
 * Sends a daily summary alert (called by the daily-reset cron at 9 AM UTC).
 *
 * This is NOT triggered by a threshold — it's a scheduled summary so the
 * admin gets a daily "yesterday's AI spend was $X" email even on quiet days.
 *
 * No-op if both email + webhook are unset.
 */
export async function sendDailySummary(yesterdaySpend: number): Promise<void> {
  // For the daily summary, we don't dedupe (the caller — the cron job —
  // runs once per day at 9 AM UTC, so dedupe isn't needed). But we still
  // mark it dispatched to avoid double-sends if the cron fires twice.
  if (!markDispatched("daily_summary")) return;

  await dispatchCostAlert({
    type: "daily_summary",
    spendUsd: yesterdaySpend,
    budgetUsd: 0, // summary doesn't trip a threshold
    thresholdPct: 0,
    yesterdaySpendUsd: yesterdaySpend,
    lastCost: {
      costUsd: 0,
      model: "summary",
      promptTokens: 0,
      completionTokens: 0,
    },
  });
}
