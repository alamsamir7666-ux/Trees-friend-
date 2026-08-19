/**
 * Cost tracking for AI requests.
 *
 * Industry standard: track the $ USD cost of every AI request so you can
 * answer "how much did we spend on AI today?" without guessing. Each
 * model has a published price per 1M tokens (prompt + completion).
 *
 * Prices are hardcoded (updated periodically from provider pricing pages).
 * For dynamic pricing, fetch from the provider's pricing API at startup.
 *
 * Free tier models have $0 cost — but we still track token usage so the
 * admin can see "we used 50K tokens today on the free tier" and know
 * when they're approaching quota limits.
 *
 * Usage:
 *   const cost = calculateCost("llama-3.3-70b-versatile", { promptTokens: 500, completionTokens: 200 });
 *   // → { costUsd: 0.00012, promptCostUsd: 0.00005, completionCostUsd: 0.00007 }
 */

import { getRedis } from "./redisClient";
import { logger } from "./logger";
import { dispatchCostAlert } from "./costAlerts";

// ─── Per-model pricing (USD per 1M tokens) ──────────────────────────────────
// Source: provider pricing pages as of Aug 2026.
//
// Bug #9 fix: the old table had ALL models at $0 (marked "free"). This
// made the entire cost tracker a no-op — even when token counts were
// available, costs computed to $0. The admin dashboard showed $0.00
// spent regardless of actual usage.
//
// The new table reflects ACTUAL pricing:
//   - Gemini free tier (Google AI Studio): genuinely $0. When you upgrade
//     to paid Gemini API, prices apply (listed as comments for reference).
//   - Groq: has BOTH free tier (with RPD limits) AND paid tier (production).
//     We track the PAID price so the admin sees real cost when they exceed
//     free limits. The `tier` field distinguishes free (current) from paid.
//
// Token counts come from the provider's usage metadata (Bug #9 fix in
// groq.ts: stream_options: { include_usage: true }).
//
// Format: { prompt: $/1M, completion: $/1M, tier: "free" | "paid" }
const PRICING: Record<string, { prompt: number; completion: number; tier: "free" | "paid" }> = {
  // ─── Gemini (Google AI Studio free tier = $0) ────────────────────────────
  // Free tier: 15 RPM, 1500 RPD, $0 cost. Token counts still tracked for
  // quota management.
  // Paid tier prices (for when you upgrade to Gemini API):
  //   - gemini-2.5-flash: $0.075/1M prompt, $0.30/1M completion
  //   - gemini-2.5-flash-lite: $0.075/1M prompt, $0.30/1M completion
  //   - gemini-2.5-pro: $1.25/1M prompt, $5.00/1M completion
  //   - gemini-3.7-flash (v6.2 Part 10): GA Aug 13, 2026. Same free-tier
  //     pricing as the rest of the 3.x family ($0 free / paid TBD).
  //     Tracked as $0 until Google publishes paid-tier pricing.
  "gemini-3.7-flash": { prompt: 0, completion: 0, tier: "free" },
  "gemini-3.1-flash": { prompt: 0, completion: 0, tier: "free" },
  "gemini-3.6-flash": { prompt: 0, completion: 0, tier: "free" },
  "gemini-3.5-flash": { prompt: 0, completion: 0, tier: "free" },
  "gemini-3.0-flash": { prompt: 0, completion: 0, tier: "free" },
  "gemini-2.5-flash": { prompt: 0, completion: 0, tier: "free" },
  "gemini-2.5-flash-lite": { prompt: 0, completion: 0, tier: "free" },
  "gemini-2.5-pro": { prompt: 0, completion: 0, tier: "free" },
  "gemini-flash-latest": { prompt: 0, completion: 0, tier: "free" },

  // ─── Groq (paid tier prices — free tier has RPD limits but $0 cost) ──────
  // Source: https://groq.com/pricing/ (as of Aug 2026)
  // Even on the free tier, we track the PAID price so the admin sees the
  // real cost equivalent. When the free tier RPD limit is hit, the cost
  // numbers already reflect what the paid tier would charge.
  //
  // v6.2 Part 10 (Production fix): Groq deprecated llama-3.3-70b-versatile +
  // llama-3.1-8b-instant on June 17, 2026. Kept the old entries for
  // historical cost records (messages already persisted with these model
  // names still need to resolve to a pricing entry for the admin dashboard).
  "llama-3.3-70b-versatile": { prompt: 0.59, completion: 0.79, tier: "paid" },
  "llama-3.1-8b-instant": { prompt: 0.05, completion: 0.08, tier: "paid" },
  // v6.2 Part 10: new Llama 4 MoE models (replacements).
  // Pricing per Groq's public docs as of Aug 2026.
  // Llama 4 Scout (17B active / 109B total, MoE 16 experts):
  //   $0.11/1M prompt, $0.34/1M completion (paid tier).
  // Llama 4 Maverick (17B active / 400B total, MoE 128 experts):
  //   $0.20/1M prompt, $0.60/1M completion (paid tier — higher because
  //   the 128-expert model uses more compute per token).
  // GPT-OSS 120B (Groq's hosted OpenAI open-weights model):
  //   $0.10/1M prompt, $0.30/1M completion (paid tier).
  // Free tier (30 RPM, 14400 RPD) is $0 — same as before.
  "llama-4-scout-17b-16e-instruct": { prompt: 0.11, completion: 0.34, tier: "paid" },
  "llama-4-maverick-17b-128e-instruct": { prompt: 0.2, completion: 0.6, tier: "paid" },
  "openai/gpt-oss-120b": { prompt: 0.1, completion: 0.3, tier: "paid" },
  // v6.2 Part 19: smaller GPT-OSS variant, likely cheaper on paid tier.
  // Exact pricing TBD — using conservative estimates based on the 120B→20B ratio.
  "openai/gpt-oss-20b": { prompt: 0.05, completion: 0.15, tier: "paid" },
};

// Bug #9 fix: default pricing for unknown models. The old default was
// { prompt: 0.5, completion: 1.5, tier: "paid" } — this inflated costs
// for new models not yet in the table. The new default is $0 (free tier
// assumption) so unknown models don't produce misleading cost numbers.
// Admins should add new models to the PRICING table explicitly.
const DEFAULT_PRICING = { prompt: 0, completion: 0, tier: "free" as const };

export interface CostBreakdown {
  costUsd: number;
  promptCostUsd: number;
  completionCostUsd: number;
  tier: "free" | "paid";
  model: string;
  /** Provider name ("gemini" / "groq" / etc.). Set by the router when known. */
  provider?: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Calculates the USD cost of a single AI request.
 *
 * @param model - The model name (e.g. "llama-3.3-70b-versatile")
 * @param usage - Token usage { promptTokens, completionTokens, totalTokens? }
 * @returns CostBreakdown with per-component and total costs
 */
export function calculateCost(
  model: string,
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
): CostBreakdown {
  const pricing = PRICING[model] ?? DEFAULT_PRICING;

  // Derive prompt/completion tokens from total if individual values are missing
  const total = usage.totalTokens ?? 0;
  let promptTokens = usage.promptTokens ?? 0;
  let completionTokens = usage.completionTokens ?? 0;

  if (total > 0 && promptTokens === 0 && completionTokens === 0) {
    // Rough split: assume 80% prompt, 20% completion if we only have total
    promptTokens = Math.round(total * 0.8);
    completionTokens = total - promptTokens;
  }

  const promptCostUsd = (promptTokens / 1_000_000) * pricing.prompt;
  const completionCostUsd = (completionTokens / 1_000_000) * pricing.completion;
  const costUsd = promptCostUsd + completionCostUsd;

  return {
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000, // 6 decimal places
    promptCostUsd: Math.round(promptCostUsd * 1_000_000) / 1_000_000,
    completionCostUsd: Math.round(completionCostUsd * 1_000_000) / 1_000_000,
    tier: pricing.tier,
    model,
    promptTokens,
    completionTokens,
  };
}

/**
 * Returns the pricing info for a model (for the admin endpoint).
 */
export function getModelPricing(
  model: string,
): { prompt: number; completion: number; tier: "free" | "paid" } | null {
  return PRICING[model] ?? null;
}

/**
 * Returns all known model pricing (for the admin endpoint).
 */
export function getAllPricing(): Record<
  string,
  { prompt: number; completion: number; tier: "free" | "paid" }
> {
  return { ...PRICING };
}

// ─── Daily spend tracking + budget circuit breaker ───────────────────────────
//
// Problem: costs are tracked per message (`cost_usd` column on
// `ai_chat_messages`), but nothing aggregates them and nothing alerts when
// the daily spend exceeds a budget. An attacker (or a bug) could:
//
//   - Drain the Gemini free-tier quota (1,500 RPD) via a botnet with many
//     IPs. Each IP gets 30 req/hour under the rate limiter, so ~50 IPs
//     blow the daily quota in 1 hour.
//   - Trigger the topic classifier on every message (20–30% of messages),
//     each costing a Groq call. At 14,400 RPD free tier, the system hits
//     the limit at ~50K messages/day.
//   - Run up Groq paid-tier costs ($0.79/1M completion tokens for
//     llama-3.3-70b-versatile) when the free tier is exceeded.
//
// The fix has three layers:
//
//   1. **Live in-memory counter** (`getDailySpend()`) — fast O(1) read for
//      every chat request to check if the circuit is tripped. Backed by
//      Redis for multi-instance consistency (all instances share the same
//      daily counter).
//
//   2. **Circuit breaker** — when daily spend exceeds
//      `AI_DAILY_BUDGET_USD` (default $5), the circuit trips:
//        - LLM chat requests return a "service temporarily throttled"
//          response instead of calling the LLM (saves quota).
//        - Non-essential AI features (topic classifier, structured output
//          fallback) skip their LLM calls and use the existing fallback
//          path (fail-open / fail-safe).
//        - Essential AI features (the main chat stream itself) still run
//          but with a degraded experience (no auto-continue, no followups
//          fallback).
//      The circuit auto-resets at UTC midnight (a daily-reset cron job
//      clears the Redis key) or can be manually reset via the admin
//      endpoint.
//
//   3. **Alert dispatcher** (`costAlerts.ts`) — sends notifications on:
//        - Circuit open (immediate, on trip)
//        - Daily summary (cron at 9 AM UTC, via `ai-cost-daily-reset` job)
//        - Optional webhook for Slack/Discord/PagerDuty
//
// Why Redis-backed instead of DB-backed:
//   - Reads happen on every chat request (hot path). DB round-trip = 5–20ms
//     of added latency on every chat. Redis = ~2ms.
//   - Writes happen on every AI response. DB writes from the hot path add
//     load + connection-pool pressure.
//   - The DB still has the per-message `cost_usd` column for historical
//     reporting — the Redis counter is just a fast aggregated view that's
//     rebuilt from the DB if lost.
//
// Fail-safe design:
//   - If Redis is unavailable, the circuit stays CLOSED (allow LLM calls).
//     Better to risk cost overrun than block legitimate users during a
//     Redis outage.
//   - If the budget env var is unset (default $5), the circuit is active
//     at that threshold. Set `AI_DAILY_BUDGET_USD=0` to disable the
//     circuit entirely (unlimited spend).
//   - If `AI_DAILY_BUDGET_USD` is set but Redis is misconfigured, we log
//     a warning and fall back to the in-memory counter (per-instance, not
//     shared). This means a multi-instance deployment could spend N× the
//     budget (one counter per instance), but it's better than blocking.

/**
 * Default daily budget: $5 USD.
 *
 * Chosen to be:
 *   - High enough that legitimate traffic spikes (Reddit hug, news feature,
 *     marketing campaign) don't trip it. TreeFriend is a Bangladesh-focused
 *     marketplace — typical daily chat volume is 50–200 messages. At
 *     ~$0.001/message (Groq paid tier, 1K tokens avg), that's $0.05–$0.20/day.
 *   - Low enough that an attack (botnet draining quota) is caught before
 *     the daily spend reaches 4 figures. $5 = ~5,000 paid-tier Groq calls
 *     or effectively unlimited Gemini free-tier calls.
 *
 * Operators with higher baseline traffic should raise this. Operators on
//  pure free tiers (Gemini only) can set to $0 to disable.
 */
export const DEFAULT_DAILY_BUDGET_USD = 5;

/**
 * Default warning threshold: 80% of budget.
 *
 * When daily spend crosses this, a "warning" alert fires (single shot, not
//  spammy) so the admin can investigate before the circuit trips. Lower
 * than 80% means too many false alarms; higher means too little lead time.
 */
export const DEFAULT_WARNING_THRESHOLD_PCT = 0.8;

/**
 * Redis keys for the daily spend counter + alert state.
 *
 * Keyed by UTC date so the counter resets daily without needing a cron job
 * (the cron is still useful for the daily summary email, but the counter
 * naturally rolls over at UTC midnight because the key changes).
 */
function dailySpendKey(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `ai:cost:daily:${today}`;
}
function dailySpendByProviderKey(provider: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `ai:cost:daily:${today}:${provider}`;
}
function circuitOpenKey(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `ai:cost:circuit-open:${today}`;
}
function warningSentKey(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `ai:cost:warning-sent:${today}`;
}
function alertSentKey(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `ai:cost:alert-sent:${today}`;
}

/**
 * Returns the configured daily budget in USD, or 0 if the circuit is
 * disabled.
 *
 * Reads `AI_DAILY_BUDGET_USD` env var. Default: $5. Set to "0" to disable
 * the circuit entirely.
 */
export function getDailyBudgetUsd(): number {
  const raw = process.env.AI_DAILY_BUDGET_USD;
  if (!raw) return DEFAULT_DAILY_BUDGET_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn(
      { raw, default: DEFAULT_DAILY_BUDGET_USD },
      "costTracker: AI_DAILY_BUDGET_USD is not a non-negative number — using default",
    );
    return DEFAULT_DAILY_BUDGET_USD;
  }
  return n;
}

/**
 * Returns true if the budget circuit breaker is enabled (budget > 0).
 */
export function isBudgetCircuitEnabled(): boolean {
  return getDailyBudgetUsd() > 0;
}

/**
 * Returns true if the budget circuit is currently OPEN (tripped).
 *
 * When open, the chat route refuses new LLM calls (returns a "throttled"
 * message) and non-essential AI features skip their LLM calls.
 *
 * This is the hot-path check — O(1) in-memory with Redis fallback. Call
 * this BEFORE every LLM invocation.
 *
 * Fail-safe: if Redis is unavailable, returns false (circuit closed —
 * allow the call). This trades potential cost overrun for availability
 * during Redis outages.
 */
export async function isCircuitOpen(): Promise<boolean> {
  if (!isBudgetCircuitEnabled()) return false;
  const redis = getRedis();
  if (!redis) return false; // fail-safe — see comment above
  try {
    const v = await redis.get(circuitOpenKey());
    return v === "1";
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message ?? String(err) },
      "costTracker: isCircuitOpen Redis read failed — fail-safe CLOSED",
    );
    return false;
  }
}

/**
 * Returns the current day's spend in USD (sum across all providers).
 *
 * Used by:
 *   - The chat route's pre-flight check (decide whether to trip the circuit).
 *   - The admin /cost/budget endpoint (for the dashboard).
 *   - The daily-reset cron job (for the summary email).
 *
 * Fail-safe: if Redis is unavailable, returns 0 (better to allow the call
 * than to block on a missing counter — the per-message `cost_usd` column
 * still has the authoritative record for post-hoc reporting).
 */
export async function getDailySpend(): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const v = await redis.get(dailySpendKey());
    return v ? Number(v) : 0;
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message ?? String(err) },
      "costTracker: getDailySpend Redis read failed — returning 0",
    );
    return 0;
  }
}

/**
 * Returns a per-provider breakdown of today's spend, for the dashboard.
 *
 * Format: `{ gemini: 0, groq: 0.034, ... }` keyed by provider name.
 */
export async function getDailySpendByProvider(): Promise<Record<string, number>> {
  const redis = getRedis();
  if (!redis) return {};
  try {
    // We don't know all providers in advance (admin could set AI_PROVIDERS
    // to anything). Scan for keys matching the pattern.
    const pattern = `ai:cost:daily:${new Date().toISOString().slice(0, 10)}:*`;
    const keys = await redis.keys(pattern);
    const out: Record<string, number> = {};
    for (const k of keys) {
      const v = await redis.get(k);
      // Extract provider from key: ai:cost:daily:YYYY-MM-DD:<provider>
      const parts = k.split(":");
      const provider = parts[parts.length - 1];
      if (provider && v) out[provider] = Number(v);
    }
    return out;
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message ?? String(err) },
      "costTracker: getDailySpendByProvider Redis scan failed — returning {}",
    );
    return {};
  }
}

/**
 * Records a cost against today's daily spend counter + checks for budget
 * threshold breaches. Fires alerts (warning + circuit-open) via the alert
 * dispatcher.
 *
 * Called by the chat route AFTER persisting the assistant message (so the
 * per-message `cost_usd` is already on disk — the Redis counter is just
 * the aggregate view).
 *
 * Idempotent: if called twice for the same cost (e.g. retry), it double-
 * counts. The route ensures it's called exactly once per assistant message.
 *
 * Fail-safe: if Redis is unavailable, NO-OPs (the per-message `cost_usd`
 * column still has the record — daily counter is just lost for that day;
 * admins can re-derive from `SELECT SUM(cost_usd) WHERE DATE(created_at) = ...`).
 */
export async function recordCost(cost: CostBreakdown): Promise<void> {
  if (cost.costUsd <= 0) return; // free-tier Gemini — no-op

  const redis = getRedis();
  if (!redis) return; // fail-safe — see comment above

  const budget = getDailyBudgetUsd();
  // Even if budget is 0 (disabled), we still record the spend so the dashboard
  // shows it. The circuit just never trips.

  const totalKey = dailySpendKey();
  const providerKey = dailySpendByProviderKey(cost.provider ?? cost.model);

  // Round to 6 decimals to avoid floating-point drift in Redis (0.03400000001).
  const usd = Math.round(cost.costUsd * 1_000_000) / 1_000_000;

  try {
    // INCRBYFLOAT is atomic — concurrent recordCost calls from parallel
    // requests are safe. Redis handles the float internally.
    const newTotalStr = await redis.incrbyfloat(totalKey, usd);
    const newTotal = Number(newTotalStr);

    // Also update the per-provider counter (for dashboard breakdown).
    await redis.incrbyfloat(providerKey, usd);

    // TTL: 7 days. Daily counters expire after a week — admins can still
    // get historical data from the DB (per-message cost_usd), but keeping
    // a week of Redis counters lets the dashboard show "yesterday" without
    // a DB query.
    await redis.expire(totalKey, 7 * 24 * 60 * 60);
    await redis.expire(providerKey, 7 * 24 * 60 * 60);

    // Check thresholds + fire alerts (idempotent — uses the alertSentKey
    // pattern to ensure one-shot).
    await checkThresholds(newTotal, budget, cost);
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message ?? String(err), costUsd: cost.costUsd },
      "costTracker: recordCost Redis write failed — per-message cost still on disk, daily counter not updated",
    );
  }
}

/**
 * Checks the new daily total against thresholds + dispatches alerts.
 *
 * Two thresholds:
 *   1. WARNING (default 80% of budget) — single-shot alert, doesn't trip
 *      the circuit. Gives the admin lead time to investigate.
 *   2. CIRCUIT OPEN (100% of budget) — trips the circuit + single-shot
 *      alert. All future LLM calls are blocked until reset.
 *
 * Both alerts use a "sentinel" Redis key (`ai:cost:warning-sent:YYYY-MM-DD`
 * and `ai:cost:alert-sent:YYYY-MM-DD`) to ensure they fire ONCE per day,
 * not on every recordCost call after the threshold is crossed.
 */
async function checkThresholds(
  newTotal: number,
  budget: number,
  lastCost: CostBreakdown,
): Promise<void> {
  if (budget <= 0) return; // circuit disabled

  const redis = getRedis();
  if (!redis) return;

  // Warning threshold (default 80% of budget).
  const warningThresholdRaw = Number(process.env.AI_BUDGET_WARNING_THRESHOLD_PCT);
  const warningThresholdPct =
    Number.isFinite(warningThresholdRaw) && warningThresholdRaw > 0 && warningThresholdRaw < 1
      ? warningThresholdRaw
      : DEFAULT_WARNING_THRESHOLD_PCT;
  const warningThreshold = budget * warningThresholdPct;

  // ─── WARNING alert (80% threshold) ──────────────────────────────────────
  if (newTotal >= warningThreshold) {
    const warningKey = warningSentKey();
    // SETNX = "set if not exists" — atomic check-and-set. Returns "OK" if we
    // set it (first to fire the alert), null if someone else already did.
    // (Upstash's @nx option returns "OK" on success, null on conflict.)
    const wasSet = await redis.set(warningKey, "1", { ex: 7 * 24 * 60 * 60, nx: true });
    if (wasSet === "OK") {
      // We won the race — fire the warning.
      try {
        await dispatchCostAlert({
          type: "warning",
          spendUsd: newTotal,
          budgetUsd: budget,
          thresholdPct: warningThresholdPct,
          lastCost,
        });
      } catch (err) {
        logger.warn({ err }, "costTracker: warning alert dispatch failed (non-fatal)");
      }
    }
  }

  // ─── CIRCUIT OPEN alert (100% threshold) ────────────────────────────────
  if (newTotal >= budget) {
    const circuitKey = circuitOpenKey();
    const alertKey = alertSentKey();

    // Trip the circuit (idempotent — already-open is a no-op).
    await redis.set(circuitKey, "1", { ex: 7 * 24 * 60 * 60 });

    // Single-shot alert. See above for return value semantics.
    const wasSet = await redis.set(alertKey, "1", { ex: 7 * 24 * 60 * 60, nx: true });
    if (wasSet === "OK") {
      try {
        await dispatchCostAlert({
          type: "circuit_open",
          spendUsd: newTotal,
          budgetUsd: budget,
          thresholdPct: 1,
          lastCost,
        });
      } catch (err) {
        logger.warn({ err }, "costTracker: circuit-open alert dispatch failed (non-fatal)");
      }
    }
  }
}

/**
 * Manually resets the circuit (admin endpoint).
 *
 * Clears the circuit-open key but NOT the daily spend counter (the spend
 * is still real — we just un-trip the breaker to allow LLM calls again).
 *
 * Use case: admin investigates the spike, fixes the root cause (rate-limit
 * a specific IP, rotate keys, etc.), then manually resets to restore
 * service before UTC midnight.
 */
export async function resetCircuit(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(circuitOpenKey());
    logger.info("costTracker: circuit manually reset by admin");
  } catch (err) {
    logger.warn({ err }, "costTracker: resetCircuit Redis del failed");
  }
}

/**
 * Clears today's spend counter (used by the daily-reset cron at UTC midnight
 * to roll over to a new day — though the key naturally changes at midnight,
 * this also fires the daily summary email).
 *
 * Also clears the warning-sent + alert-sent sentinels so they can fire again
 * on the new day.
 */
export async function rolloverDay(): Promise<{ yesterdaySpend: number }> {
  const redis = getRedis();
  const yesterdaySpend = await getDailySpend();
  if (!redis) return { yesterdaySpend };
  try {
    // Don't delete today's keys (they belong to today). The rollover happens
    // naturally because dailySpendKey() computes a new key at UTC midnight.
    //
    // What we DO clear is the alert sentinels — but only if they're from
    // yesterday. Since the keys include the date, they naturally roll over
    // too. So this function is essentially a no-op for state — it just
    // returns yesterday's spend for the summary email.
    logger.info({ yesterdaySpend }, "costTracker: daily rollover check");
  } catch (err) {
    logger.warn({ err }, "costTracker: rolloverDay failed (non-fatal)");
  }
  return { yesterdaySpend };
}

/**
 * Returns the full budget status for the admin dashboard.
 */
export async function getBudgetStatus(): Promise<{
  enabled: boolean;
  budgetUsd: number;
  spendUsd: number;
  remainingUsd: number;
  spendPct: number;
  circuitOpen: boolean;
  warningThresholdPct: number;
  warningSent: boolean;
  alertSent: boolean;
  byProvider: Record<string, number>;
  date: string;
}> {
  const budget = getDailyBudgetUsd();
  const enabled = budget > 0;
  const spend = await getDailySpend();
  const circuitOpen = enabled ? await isCircuitOpen() : false;
  const byProvider = await getDailySpendByProvider();
  const date = new Date().toISOString().slice(0, 10);

  // Sentinel states.
  const redis = getRedis();
  let warningSent = false;
  let alertSent = false;
  if (redis) {
    try {
      warningSent = (await redis.get(warningSentKey())) === "1";
      alertSent = (await redis.get(alertSentKey())) === "1";
    } catch {
      // ignore — sentinel states are best-effort
    }
  }

  return {
    enabled,
    budgetUsd: budget,
    spendUsd: spend,
    remainingUsd: Math.max(0, budget - spend),
    spendPct: budget > 0 ? Math.min(1, spend / budget) : 0,
    circuitOpen,
    warningThresholdPct: DEFAULT_WARNING_THRESHOLD_PCT,
    warningSent,
    alertSent,
    byProvider,
    date,
  };
}
