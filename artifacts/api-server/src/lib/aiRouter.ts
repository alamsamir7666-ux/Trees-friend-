/**
 * Multi-provider AI router for the TreeBot assistant.
 *
 * Problem:
 *   Gemini has the best Bangla support but a restrictive free tier (20 RPD
 *   for gemini-3.6-flash on new GCP projects). If Gemini's quota is
 *   exhausted, the chat breaks entirely — bad UX.
 *
 * Solution:
 *   Try providers in order. If the primary provider fails with a
 *   "quota exhausted" or "all models unavailable" error, fall back to the
 *   next provider. This gives us:
 *     - Gemini's superior Bangla when available
 *     - Groq's massive 14,400 RPD free tier as automatic fallback
 *     - Zero downtime — if one provider has an outage, the other takes over
 *
 * Provider chain (configurable via AI_PROVIDERS env var):
 *   Default: "gemini,groq" — try Gemini first, fall back to Groq
 *   "groq" — use Groq only (skip Gemini entirely)
 *   "gemini" — use Gemini only (v3.0 behavior)
 *   "groq,gemini" — Groq first, Gemini fallback (if you prefer Groq's speed)
 *
 * Fallback rules:
 *   - Fall back to next provider on: "all models 404", "all models 429",
 *     "provider not configured"
 *   - DON'T fall back on: 401 auth errors (config issue), 400 bad request
 *     (prompt issue — next provider will have the same problem), or if
 *     we've already yielded text to the user (can't switch mid-stream)
 *
 * Interface:
 *   streamChat() and summarizeConversation() have the EXACT same signature
 *   as gemini.ts's streamGeminiChat() and summarizeConversation(). The
 *   route handler doesn't know or care which provider is actually used.
 */
import type { FunctionDeclaration } from "@google/genai";
import { logger } from "./logger";
import {
  streamGeminiChat,
  summarizeConversation,
  isGeminiConfigured,
  getModelDebugInfo as getGeminiDebugInfo,
  forceRediscover as forceGeminiRediscover,
} from "./gemini";
import {
  streamGroqChat,
  summarizeConversationGroq,
  isGroqConfigured,
  getGroqDebugInfo,
  forceGroqRediscover,
} from "./groq";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProviderName = "gemini" | "groq";

export interface ChatTools {
  declarations: FunctionDeclaration[];
  execute: (
    name: string,
    args: Record<string, unknown>,
    userId: string | null,
  ) => Promise<unknown>;
}

// ─── Provider chain config ──────────────────────────────────────────────────

/**
 * Returns the ordered list of providers to try. Configurable via the
 * AI_PROVIDERS env var (comma-separated). Defaults to ["gemini", "groq"].
 *
 * Only includes providers that are actually configured (have an API key
 * set). If NO providers are configured, returns [] — the caller will
 * throw a clear "no providers configured" error.
 */
export function getProviderChain(): ProviderName[] {
  const raw = process.env.AI_PROVIDERS ?? "gemini,groq";
  const requested = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0) as ProviderName[];

  // Filter to valid provider names + actually configured providers.
  const valid = requested.filter(
    (p) => p === "gemini" || p === "groq",
  );

  const configured = valid.filter((p) => {
    if (p === "gemini") return isGeminiConfigured();
    if (p === "groq") return isGroqConfigured();
    return false;
  });

  if (configured.length === 0) {
    logger.warn(
      { requested: valid, configured },
      "AI router: no providers are configured. Set GEMINI_API_KEY and/or GROQ_API_KEY.",
    );
  }

  return configured;
}

// ─── Error classification ───────────────────────────────────────────────────

/**
 * Checks if an error from a provider means we should try the NEXT provider.
 *
 * Returns true for:
 *   - "All configured Gemini models are unavailable" (all 404)
 *   - "All Gemini models are rate-limited" (all 429)
 *   - "All Groq models are rate-limited or unavailable"
 *   - "GEMINI_API_KEY is not set" / "GROQ_API_KEY is not set"
 *   - Generic 429 / quota exhausted errors
 *
 * Returns false for:
 *   - 401 auth errors (config issue — next provider won't help)
 *   - 400 bad request (prompt issue — next provider will fail the same way)
 *   - Network errors (transient — should retry same provider, not switch)
 *   - Errors that occur AFTER streaming has started (can't switch mid-stream)
 */
function shouldFallBackToNextProvider(err: unknown): boolean {
  const msg = typeof (err as any)?.message === "string" ? (err as any).message : "";

  // Provider-level exhaustion errors → fall back
  if (/all configured gemini models are unavailable/i.test(msg)) return true;
  if (/all gemini models are rate-limited/i.test(msg)) return true;
  if (/all groq models are rate-limited/i.test(msg)) return true;
  if (/groq models are rate-limited or unavailable/i.test(msg)) return true;

  // "Not configured" errors → fall back (try the other provider)
  if (/GEMINI_API_KEY is not set/i.test(msg)) return true;
  if (/GROQ_API_KEY is not set/i.test(msg)) return true;

  // Generic quota/rate-limit → fall back
  if (/quota exceeded|rate limit|too many requests/i.test(msg)) return true;

  // 401/403 auth errors → DON'T fall back (config issue, next provider
  // would need its own correct API key — but if it's configured, we'd
  // try it anyway via the chain; if it's not, we'd just get a different
  // "not configured" error).
  // We specifically check for "api key" + "permission" patterns to NOT fall back.
  if (/api key|permission|unauthorized|forbidden/i.test(msg)) return false;

  // 400 bad request → DON'T fall back (prompt issue)
  if (/bad request|invalid request/i.test(msg)) return false;

  // Network errors → DON'T fall back (transient, should retry same provider)
  if (/econnreset|etimedout|enotfound|fetch failed|network error/i.test(msg)) return false;

  // Default: don't fall back on unknown errors (safer to surface the error
  // than to silently try another provider and mask the real issue).
  return false;
}

// ─── Main: streamChat (same signature as streamGeminiChat) ──────────────────

/**
 * Streams a chat completion, trying providers in order.
 *
 * Same signature as streamGeminiChat() / streamGroqChat() — the route
 * handler doesn't know which provider is actually used.
 *
 * Fallback behavior:
 *   - If the primary provider fails BEFORE yielding any text (e.g. all
 *     models 404 or 429), the router tries the next provider.
 *   - If a provider fails AFTER yielding text (mid-stream error), the
 *     router rethrows — we can't switch providers mid-stream because the
 *     user has already received partial output.
 *
 * ─── Bug #4 fix: toolCalls in metadata ───────────────────────────────────────
 *
 * The `onMetadata` callback now receives an optional `toolCalls` field —
 * the names of tools that were called during this request. The route
 * handler uses this to:
 *   - Skip caching entirely if any user-scoped tool was called (orders).
 *   - Use a short-TTL cache if any catalog tool was called (search).
 *   - Use the normal long-TTL cache if no tools were called.
 *
 * @yields string — incremental text deltas
 */
export async function* streamChat(
  systemPrompt: string,
  history: { role: "user" | "model"; text: string }[],
  userMessage: string,
  tools?: ChatTools,
  userId?: string | null,
  onMetadata?: (meta: {
    model: string;
    usage?: unknown;
    provider?: ProviderName;
    /** Bug #4 fix: names of tools called during this request. */
    toolCalls?: string[];
  }) => void,
): AsyncGenerator<string, void, unknown> {
  const providers = getProviderChain();

  if (providers.length === 0) {
    throw new Error(
      "No AI providers are configured. Set GEMINI_API_KEY and/or GROQ_API_KEY " +
        "env vars. Get free keys at https://aistudio.google.com/apikey " +
        "(Gemini) or https://console.groq.com (Groq).",
    );
  }

  let lastErr: unknown = null;

  for (const provider of providers) {
    let yieldedAny = false;
    try {
      const gen =
        provider === "gemini"
          ? streamGeminiChat(
              systemPrompt,
              history,
              userMessage,
              tools,
              userId,
              onMetadata
                ? (meta) => onMetadata({ ...meta, provider: "gemini" })
                : undefined,
            )
          : streamGroqChat(
              systemPrompt,
              history,
              userMessage,
              tools,
              userId,
              onMetadata
                ? (meta) => onMetadata({ ...meta, provider: "groq" })
                : undefined,
            );

      for await (const chunk of gen) {
        yieldedAny = true;
        yield chunk;
      }

      // Success — return (don't try next provider)
      logger.debug(
        { provider, hadFallback: providers.indexOf(provider) > 0 },
        "AI router: provider succeeded",
      );
      return;
    } catch (err) {
      lastErr = err;

      // If we already yielded text, we CAN'T fall back — the user has
      // partial output. Rethrow so the route handler can persist the
      // partial response + show an error.
      if (yieldedAny) {
        logger.warn(
          { provider, err: (err as any)?.message ?? String(err) },
          `AI router: ${provider} failed mid-stream (can't fall back — partial output already sent)`,
        );
        throw err;
      }

      // Check if this error is fallback-eligible.
      if (!shouldFallBackToNextProvider(err)) {
        logger.warn(
          { provider, err: (err as any)?.message ?? String(err) },
          `AI router: ${provider} failed with non-fallback-eligible error, rethrowing`,
        );
        throw err;
      }

      // Fallback-eligible — try the next provider.
      const nextProvider = providers[providers.indexOf(provider) + 1];
      logger.warn(
        {
          failedProvider: provider,
          nextProvider: nextProvider ?? "(none)",
          err: (err as any)?.message ?? String(err),
        },
        `AI router: ${provider} failed, falling back to ${nextProvider ?? "nowhere"}`,
      );

      if (!nextProvider) {
        // This was the last provider — rethrow.
        throw err;
      }
      // Continue to next iteration → try nextProvider
    }
  }

  // All providers exhausted
  throw lastErr ?? new Error("All AI providers failed.");
}

// ─── Summarization (same signature as gemini.ts) ────────────────────────────

/**
 * Generates a conversation summary, trying providers in order.
 * Used by aiMemory.ts for long-term conversation memory.
 *
 * Same signature as gemini.ts's summarizeConversation() so the memory
 * module doesn't need to know which provider is used.
 */
export async function summarizeConversationRouted(
  messages: { role: "user" | "assistant"; content: string }[],
): Promise<string> {
  const providers = getProviderChain();

  if (providers.length === 0) {
    throw new Error("No AI providers configured for summarization.");
  }

  let lastErr: unknown = null;
  for (const provider of providers) {
    try {
      if (provider === "gemini") {
        return await summarizeConversation(messages);
      }
      if (provider === "groq") {
        return await summarizeConversationGroq(messages);
      }
    } catch (err) {
      lastErr = err;
      if (!shouldFallBackToNextProvider(err)) throw err;
      logger.warn(
        { provider, err: (err as any)?.message ?? String(err) },
        `AI router: ${provider} summarization failed, trying next provider`,
      );
    }
  }

  throw lastErr ?? new Error("All AI providers failed for summarization.");
}

// ─── Public helpers ──────────────────────────────────────────────────────────

/**
 * Returns true if at least one AI provider is configured (has an API key).
 * Used by the route handler for the service-availability check.
 */
export function isAnyProviderConfigured(): boolean {
  return getProviderChain().length > 0;
}

/**
 * Returns debug info for all providers. Used by the
 * /api/ai/admin/providers endpoint.
 *
 * v3.3: now async because cooldown checks are Redis-backed.
 */
export async function getProvidersDebugInfo(): Promise<{
  providerChain: ProviderName[];
  configuredProviders: ProviderName[];
  gemini: Awaited<ReturnType<typeof getGeminiDebugInfo>> & { configured: boolean };
  groq: Awaited<ReturnType<typeof getGroqDebugInfo>>;
  aiProvidersEnv: string | null;
}> {
  const configured = getProviderChain();
  const [geminiInfo, groqInfo] = await Promise.all([
    getGeminiDebugInfo(),
    getGroqDebugInfo(),
  ]);
  return {
    providerChain: configured,
    configuredProviders: configured,
    gemini: {
      configured: isGeminiConfigured(),
      ...geminiInfo,
    },
    groq: groqInfo,
    aiProvidersEnv: process.env.AI_PROVIDERS ?? null,
  };
}

/**
 * Clears all provider caches + cooldowns. Used by the admin
 * /api/ai/admin/providers?refresh=1 endpoint after swapping API keys.
 *
 * v3.3: now async because cooldown clearing is Redis-backed.
 */
export async function forceAllProvidersRediscover(): Promise<void> {
  await Promise.all([forceGeminiRediscover(), forceGroqRediscover()]);
  logger.info("AI router: cleared all provider caches (Gemini + Groq)");
}
