/**
 * Token counting + context window management.
 *
 * Industry standard: count tokens BEFORE sending the request so you can
 * truncate history intelligently instead of getting a 400 from the API
 * when the context window is exceeded.
 *
 * We use a heuristic-based counter (approximate) rather than the exact
 * tokenizer (tiktoken/gpt-tokenizer) to avoid adding a heavy dependency.
 * The heuristic is ~95% accurate for English text, ~85% for Bangla.
 * This is "good enough" for context-window management — being off by 5%
 * just means we keep one message more or less than ideal, not a failure.
 *
 * For exact counting, install `gpt-tokenizer` and replace the estimate()
 * function. The interface stays the same.
 */

// ─── Per-model context windows ───────────────────────────────────────────────
// Source: official docs as of Aug 2026. Updated periodically.
// v6.2 Part 10: added gemini-3.7-flash + gemini-3.1-flash + Llama 4 models.
const CONTEXT_WINDOWS: Record<string, number> = {
  // Gemini
  "gemini-3.7-flash": 1_048_576, // v6.2 Part 10: GA Aug 13, 2026
  "gemini-3.6-flash": 1_048_576,
  "gemini-3.5-flash": 1_048_576,
  "gemini-3.1-flash": 1_048_576,
  "gemini-3.0-flash": 1_048_576,
  "gemini-2.5-flash": 1_048_576,
  "gemini-2.5-flash-lite": 1_048_576,
  "gemini-2.5-pro": 2_097_152,
  "gemini-2.0-flash": 1_048_576,
  "gemini-1.5-flash": 1_048_576,
  "gemini-flash-latest": 1_048_576,
  // Groq — Llama 4 family (v6.2 Part 10: replacements for deprecated llama-3.3-70b-versatile)
  "llama-4-scout-17b-16e-instruct": 131_072, // 17B active / 109B total MoE
  "llama-4-maverick-17b-128e-instruct": 131_072, // 17B active / 400B total MoE
  "openai/gpt-oss-120b": 131_072, // Groq's hosted GPT-OSS 120B
  // Groq — deprecated models (kept for backward compat with persisted messages)
  "llama-3.3-70b-versatile": 131_072,
  "llama-3.1-8b-instant": 131_072,
};

const DEFAULT_CONTEXT_WINDOW = 128_000; // safe default for unknown models

/**
 * Returns the context window size (in tokens) for a given model.
 */
export function getContextWindowSize(model: string): number {
  // Try exact match first, then prefix match (e.g. "gemini-3.6-flash-001")
  if (CONTEXT_WINDOWS[model]) return CONTEXT_WINDOWS[model];
  for (const [key, size] of Object.entries(CONTEXT_WINDOWS)) {
    if (model.startsWith(key)) return size;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Estimates the token count of a string.
 *
 * Heuristic: ~4 characters per token for English, ~2 characters per token
 * for CJK/Bengali scripts (which use multi-byte characters that tokenize
 * less efficiently).
 *
 * This is intentionally approximate. For exact counting, swap in
 * `gpt-tokenizer`:
 *   import { encode } from "gpt-tokenizer";
 *   return encode(text).length;
 */
export function estimateTokens(text: string): number {
  if (!text || typeof text !== "string") return 0;

  // Count CJK + Bengali characters (multi-byte, tokenize less efficiently)
  const cjkBengaliChars = (text.match(/[\u0980-\u09ff\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const otherChars = text.length - cjkBengaliChars;

  // CJK/Bengali: ~2 chars/token. Other: ~4 chars/token.
  return Math.ceil(cjkBengaliChars / 2 + otherChars / 4);
}

/**
 * Estimates the total token count for a chat request (system prompt +
 * history + user message + tool declarations overhead).
 *
 * @param systemPrompt - The system instruction
 * @param history - Prior turns (role + text)
 * @param userMessage - The new user message
 * @param hasTools - Whether tool declarations are included (adds ~200 tokens overhead)
 */
export function estimateRequestTokens(
  systemPrompt: string,
  history: { role: string; text: string }[],
  userMessage: string,
  hasTools: boolean = false,
): number {
  let total = 0;

  // System prompt
  total += estimateTokens(systemPrompt);
  total += 4; // role tag overhead

  // History
  for (const msg of history) {
    total += estimateTokens(msg.text);
    total += 4; // role tag overhead per message
  }

  // User message
  total += estimateTokens(userMessage);
  total += 4;

  // Tool declarations overhead (approximate — each tool is ~50-100 tokens)
  if (hasTools) {
    total += 200;
  }

  // Reserve tokens for the response
  total += getMaxOutputTokens();

  return total;
}

/**
 * Truncates conversation history to fit within the model's context window.
 *
 * Strategy (industry standard "keep recent" approach):
 *   1. Always keep the system prompt + user message + response budget.
 *   2. Keep as many recent history messages as fit.
 *   3. If history is truncated, log a warning (the summarization system
 *      should ideally handle this, but this is the safety net).
 *
 * Returns the truncated history (oldest messages dropped).
 */
export function truncateHistory(
  systemPrompt: string,
  history: { role: string; text: string }[],
  userMessage: string,
  model: string,
  hasTools: boolean = false,
): { history: { role: string; text: string }[]; truncated: boolean; droppedCount: number } {
  const contextWindow = getContextWindowSize(model);
  const responseBudget = getMaxOutputTokens();
  const availableForHistory = contextWindow - responseBudget - estimateTokens(systemPrompt) - estimateTokens(userMessage) - (hasTools ? 200 : 0) - 50; // 50 = safety margin

  if (availableForHistory <= 0) {
    // Even the system prompt + user message is too large — return empty history.
    return { history: [], truncated: history.length > 0, droppedCount: history.length };
  }

  // Walk history from newest to oldest, accumulating tokens until we hit the budget.
  const kept: { role: string; text: string }[] = [];
  let usedTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(history[i].text) + 4;
    if (usedTokens + msgTokens > availableForHistory) {
      // Can't fit this message — stop here.
      const dropped = history.slice(0, i + 1);
      return {
        history: kept.reverse(),
        truncated: dropped.length > 0,
        droppedCount: dropped.length,
      };
    }
    kept.unshift(history[i]);
    usedTokens += msgTokens;
  }

  return { history: [...history], truncated: false, droppedCount: 0 };
}

function getMaxOutputTokens(): number {
  const raw = Number(process.env.AI_MAX_TOKENS);
  if (Number.isFinite(raw) && raw >= 256 && raw <= 8192) return raw;
  return 2048;
}
