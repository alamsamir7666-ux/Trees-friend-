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
// Free tier = $0. Paid tier prices are listed for when you upgrade.
//
// Format: { prompt: $/1M, completion: $/1M }
const PRICING: Record<string, { prompt: number; completion: number; tier: "free" | "paid" }> = {
  // Gemini (Google AI Studio free tier = $0)
  "gemini-3.6-flash": { prompt: 0, completion: 0, tier: "free" },
  "gemini-3.5-flash": { prompt: 0, completion: 0, tier: "free" },
  "gemini-3.0-flash": { prompt: 0, completion: 0, tier: "free" },
  "gemini-2.5-flash": { prompt: 0, completion: 0, tier: "free" },
  "gemini-2.5-flash-lite": { prompt: 0, completion: 0, tier: "free" },
  "gemini-2.5-pro": { prompt: 0, completion: 0, tier: "free" },
  "gemini-flash-latest": { prompt: 0, completion: 0, tier: "free" },

  // Groq (free tier = $0 for Llama models, with RPD limits)
  "llama-3.3-70b-versatile": { prompt: 0, completion: 0, tier: "free" },
  "llama-3.1-8b-instant": { prompt: 0, completion: 0, tier: "free" },
};

// Default pricing for unknown models (assume paid tier for safety)
const DEFAULT_PRICING = { prompt: 0.5, completion: 1.5, tier: "paid" as const };

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
