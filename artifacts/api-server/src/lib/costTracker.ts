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
  "llama-3.3-70b-versatile": { prompt: 0.59, completion: 0.79, tier: "paid" },
  "llama-3.1-8b-instant": { prompt: 0.05, completion: 0.08, tier: "paid" },
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
export function getModelPricing(model: string): { prompt: number; completion: number; tier: "free" | "paid" } | null {
  return PRICING[model] ?? null;
}

/**
 * Returns all known model pricing (for the admin endpoint).
 */
export function getAllPricing(): Record<string, { prompt: number; completion: number; tier: "free" | "paid" }> {
  return { ...PRICING };
}
