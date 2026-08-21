/**
 * geminiContextCache.ts — P1 #5: Gemini context caching for multi-round tool loops.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 *
 * The multi-round tool loop in `gemini.ts` re-sends the FULL `contents` array
 * (system prompt + history + user message + all previous model parts + all
 * function responses) on EVERY round. For a 5-round loop, the LLM sees the
 * cumulative context 5 times — each round pays for the full prefix again.
 *
 * Gemini's `cachedContent` API lets you cache a prefix (system instruction +
 * contents + tools) and reference it in subsequent requests. The cached
 * prefix is billed at a LOWER rate ($0.25/1M tokens/hour for storage vs
 * $1/1M tokens for input). For rounds 2+, you only send the NEW tokens
 * (the latest model parts + function responses).
 *
 * Industry standard:
 *   - Anthropic's prompt caching: 90% discount on cached tokens, 5-minute TTL.
 *   - OpenAI's cached prompts: 50% discount on cached tokens, automatic.
 *   - Google's Gemini context caching: explicit `cachedContent` API, configurable TTL.
 *
 * ─── Design decisions ────────────────────────────────────────────────────────
 *
 * 1. **Opt-in via env var** (`AI_GEMINI_CONTEXT_CACHING_ENABLED=false` by
 *    default). Context caching adds complexity + a small overhead per request
 *    (cache creation call ~100ms). Default OFF so existing deployments see
 *    no behavior change. Enable when you confirm 2+ round loops are frequent.
 *
 * 2. **Cache the system instruction + tools + initial contents ONLY**. The
 *    conversation history grows each round (model parts + function responses),
 *    so caching it would require creating a new cache every round (defeats
 *    the purpose). The system instruction + tools are ~2-5K tokens that are
 *    stable across rounds (unless the system prompt changes — see #3).
 *
 * 3. **System-prompt-stability-aware**. The BUG-I5 fix clears the
 *    `{{knowledge}}` block from the system prompt after the first
 *    `search_knowledge_base` call. When this happens, the cached system
 *    instruction is STALE — we must abandon the cache + fall back to
 *    non-cached for subsequent rounds. We detect this by checking whether
 *    `resolveSystemPrompt()` returns a different string than the cached one.
 *
 * 4. **Best-effort with automatic fallback**. If cache creation fails (API
 *    error, model not supported, etc.), the loop falls back to the existing
 *    non-cached behavior. No error surfaced to the user — just a debug log.
 *
 * 5. **Clean up after the request**. The cache is deleted in a `finally`
 *    block after the loop completes (success or error). This avoids orphaned
 *    caches accumulating in the user's GCP project. The TTL is set to 300s
 *    (5 minutes) as a safety net in case the delete fails (e.g., the process
 *    crashes before the `finally` runs).
 *
 * ─── Trade-offs ───────────────────────────────────────────────────────────────
 *
 * Risk: the cache could serve STALE content if the system prompt changes
 * between rounds AND we don't detect it. Mitigation: we check the prompt
 * before each round (via `resolveSystemPrompt()`) + abandon the cache if
 * it changed.
 *
 * Risk: the cache creation call (~100ms) could SLOW DOWN the first round.
 * Mitigation: we only create the cache if the env var is enabled AND the
 * model supports caching (Gemini 1.5+ / 2.0+). The first round pays the
 * creation cost; rounds 2+ save the re-send cost. Net win only for 2+ round
 * loops.
 *
 * Risk: Groq doesn't support context caching the same way. This module is
 * Gemini-only. The router falls back to non-cached when the provider is Groq.
 *
 * ─── Compatibility ───────────────────────────────────────────────────────────
 *
 * This module is purely additive — it doesn't modify the existing tool loop
 * when `AI_GEMINI_CONTEXT_CACHING_ENABLED=false` (the default). The route
 * handler doesn't need to know about caching; the gemini.ts module handles
 * it internally.
 */
import type { GoogleGenAI } from "@google/genai";
import { logger } from "./logger";

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Master switch for Gemini context caching. Default: false (opt-in).
 *
 * Set to "true" to enable context caching for multi-round tool loops.
 * When enabled, the gemini.ts module will attempt to create a cache before
 * round 1 + use it for rounds 2+. If cache creation fails, it falls back
 * to the existing non-cached behavior (no error surfaced to the user).
 *
 * Enable this when you've confirmed 2+ round loops are frequent in your
 * traffic (check `ai_chat_events` for `tool_round` events). The cache
 * creation call adds ~100ms to the first round but saves ~2-5K tokens
 * per subsequent round.
 */
export const GEMINI_CONTEXT_CACHING_ENABLED =
  (process.env.AI_GEMINI_CONTEXT_CACHING_ENABLED ?? "false").toLowerCase() === "true";

/**
 * TTL for the Gemini context cache. Default: 300 seconds (5 minutes).
 *
 * The cache is deleted in a `finally` block after the loop completes, so
 * the TTL is a SAFETY NET in case the delete fails (e.g., process crash).
 * Gemini's minimum TTL is 60 seconds; maximum is 3600 seconds (1 hour).
 *
 * The TTL should be long enough to cover the maximum expected loop duration
 * (5 rounds × ~3s each = ~15s) but short enough to avoid orphaned caches.
 */
export const GEMINI_CACHE_TTL_SECONDS = Math.min(
  Math.max(Number(process.env.AI_GEMINI_CACHE_TTL_SECONDS ?? 300), 60),
  3600,
);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GeminiContextCache {
  /** The cache name (e.g., "cachedContents/abc123"). Pass this as `cachedContent` in the config. */
  name: string;
  /** The system instruction that was cached. Used to detect staleness. */
  cachedSystemInstruction: string;
  /** The number of tokens in the cached prefix (for logging). */
  cachedTokenCount: number;
  /** Delete the cache. Call this in a `finally` block after the loop completes. */
  delete: () => Promise<void>;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Attempts to create a Gemini context cache for a multi-round tool loop.
 *
 * Returns `null` if:
 *   - Context caching is disabled (env var).
 *   - The Gemini client is not configured.
 *   - Cache creation fails (API error, model not supported, etc.).
 *
 * The caller should fall back to the existing non-cached behavior when this
 * returns null. No error is surfaced to the user — just a debug log.
 *
 * @param client       The GoogleGenAI client (from gemini.ts).
 * @param modelName    The model name (e.g., "gemini-2.0-flash").
 * @param systemPrompt The system instruction to cache.
 * @param initialContents The initial contents array (history + user message).
 * @param tools        The tool declarations to cache (optional).
 *
 * @returns The cache handle, or null if caching is disabled or failed.
 */
export async function maybeCreateGeminiContextCache(
  client: GoogleGenAI | null,
  modelName: string,
  systemPrompt: string,
  initialContents: Record<string, unknown>[],
  tools?: unknown,
): Promise<GeminiContextCache | null> {
  // Fast path: caching is disabled.
  if (!GEMINI_CONTEXT_CACHING_ENABLED) return null;

  // Fast path: no client configured.
  if (!client) return null;

  // Fast path: empty system prompt or contents — nothing worth caching.
  if (!systemPrompt || systemPrompt.trim().length === 0) return null;
  if (!initialContents || initialContents.length === 0) return null;

  try {
    const cache = await client.caches.create({
      model: modelName,
      config: {
        contents: initialContents as any,
        systemInstruction: systemPrompt,
        tools: tools ? [tools] : undefined,
        ttl: `${GEMINI_CACHE_TTL_SECONDS}s`,
        displayName: `treebot-chat-${Date.now()}`,
      },
    });

    const cacheName = cache?.name;
    if (!cacheName) {
      logger.debug(
        "Gemini context cache: created but no name returned — falling back to non-cached",
      );
      return null;
    }

    const cachedTokenCount =
      (cache as any)?.usageMetadata?.cachedTokenCount ??
      (cache as any)?.usageMetadata?.totalTokenCount ??
      0;

    logger.info(
      {
        cacheName,
        cachedTokenCount,
        ttlSeconds: GEMINI_CACHE_TTL_SECONDS,
      },
      "Gemini context cache: created successfully",
    );

    return {
      name: cacheName,
      cachedSystemInstruction: systemPrompt,
      cachedTokenCount,
      delete: async () => {
        try {
          await client.caches.delete({ name: cacheName });
          logger.debug({ cacheName }, "Gemini context cache: deleted");
        } catch (err) {
          // Non-fatal — the cache will expire via TTL.
          logger.debug(
            { err: (err as Error)?.message ?? String(err), cacheName },
            "Gemini context cache: delete failed (non-fatal — will expire via TTL)",
          );
        }
      },
    };
  } catch (err) {
    logger.debug(
      { err: (err as Error)?.message ?? String(err), modelName },
      "Gemini context cache: creation failed (falling back to non-cached — non-fatal)",
    );
    return null;
  }
}

/**
 * Checks whether the cached system instruction is still valid for the current
 * system prompt. Used to detect when the BUG-I5 fix has cleared the
 * `{{knowledge}}` block (which would invalidate the cache).
 *
 * @param cache       The cache handle (from maybeCreateGeminiContextCache).
 * @param currentPrompt The current system prompt (from resolveSystemPrompt()).
 *
 * @returns true if the cache is still valid; false if it's stale (the prompt
 *          changed — the caller should abandon the cache + fall back to non-cached).
 */
export function isCacheStillValid(
  cache: GeminiContextCache | null,
  currentPrompt: string,
): boolean {
  if (!cache) return false;
  return cache.cachedSystemInstruction === currentPrompt;
}
