/**
 * Thin Google GenAI SDK wrapper for the TreeBot assistant.
 *
 * Why a wrapper (and not call the SDK directly from the route):
 *   - Single point of initialization (client is created once, reused
 *     across requests — `@google/genai` client construction is non-trivial
 *     and shouldn't happen per request).
 *   - Centralized error translation (SDK errors → predictable HTTP-shaped
 *     errors the route can handle).
 *   - Easier to swap models without touching route code.
 *   - Easier to mock in tests.
 *
 * Configuration:
 *   GEMINI_API_KEY   — required, get one free at https://aistudio.google.com/apikey
 *   AI_MODEL          — optional, overrides the auto-fallback chain with a
 *                       specific model name. If unset, we try models in order
 *                       (v6.2 Part 10 — see MODEL_FALLBACK_CHAIN below for
 *                       the full current list + rationale):
 *
 *                         1. gemini-3.7-flash         (GA Aug 13, 2026 — production workhorse)
 *                         2. gemini-3.1-flash         (older 3.x fallback)
 *                         3. gemini-3.0-flash         (older 3.x fallback)
 *                         4. gemini-3.5-flash         (older 3.x fallback)
 *                         5. gemini-3.6-flash         (20 RPD — last resort 3.x)
 *                         6. gemini-2.5-flash-lite    (shutting down Oct 2026)
 *                         7. gemini-2.5-flash         (shutting down Oct 2026)
 *                         8. gemini-2.5-pro          (shutting down Oct 2026)
 *                         9. gemini-flash-latest      (alias — unpredictable)
 *                        10. gemini-2.0-flash         (legacy — likely 404)
 *                        11. gemini-1.5-flash         (very old — likely 404)
 *
 *                       v3.0.1 auto-discovery (ListModels API) runs first +
 *                       replaces this chain with whatever the API key actually
 *                       has access to. The static chain is only the fallback
 *                       if discovery fails.
 *
 *   AI_TEMPERATURE     — optional, 0.0–2.0, default 0.4. Lower = more
 *                        deterministic; higher = more creative. The
 *                        TreeBot use case (factual plant care) rewards
 *                        low temperature.
 *   AI_MAX_TOKENS      — optional, default 2048 (v3.0: raised from 1024).
 *                        Plant care guides with formatting can hit 1024.
 *                        If the response is still truncated, the route
 *                        auto-continues (see autoContinueIfNeeded).
 *   AI_MAX_RETRIES     — optional, default 3. Number of times to retry
 *                        a Gemini call on transient errors (5xx, 429,
 *                        network). Exponential backoff: 500ms * 2^attempt.
 *
 * Streaming:
 *   `streamGeminiChat()` returns an async iterator of text chunks. The route
 *   re-emits these as Server-Sent Events (SSE) to the browser, which
 *   gives the user a real-time "typing" experience — important for chat UX.
 *
 * If GEMINI_API_KEY is not set, all functions throw a friendly 503-style
 * error — the route catches this and returns a clear message rather than
 * a confusing 500. This lets you deploy the code before adding the key.
 */
import { GoogleGenAI, type FunctionDeclaration } from "@google/genai";
import { logger } from "./logger";
import {
  isOnCooldown,
  setCooldown,
  clearAllCooldowns,
  getCooldownRemaining,
} from "./modelCooldown";
import {
  ToolRoundBudget,
  signatureOf,
  buildMaxRoundsErrorMessage,
  buildForceFinalPromptSuffix,
  type OnToolEvent,
  type ToolCallSignature,
} from "./aiToolLoop";
// v6.2 Part 12 (Backend Gap Fix #2): import isToolName to narrow the raw
// tool name from the LLM's functionCall response before emitting SSE
// events. The name arrives as `string` (untrusted — could be a typo or
// hallucination); isToolName narrows it to ToolName so the typed
// ToolStreamEvent union stays safe. ToolName is used in the stuck-loop
// signatureOf fallback.
import { isToolName, type ToolName } from "./aiToolSchemas";
// P1 #5 fix: Gemini context caching for multi-round tool loops. Opt-in via
// AI_GEMINI_CONTEXT_CACHING_ENABLED=true (default false). When enabled, the
// tool loop attempts to create a context cache before round 1 + uses it for
// rounds 2+. Falls back to non-cached on any failure.
import {
  maybeCreateGeminiContextCache,
  isCacheStillValid,
  type GeminiContextCache,
} from "./geminiContextCache";
// P1 #8 fix: compact older tool results between rounds. Opt-in via
// AI_TOOL_COMPACTION_ENABLED=true (default false). When enabled,
// search_catalog / search_seller_listings results from rounds 1 to N-2 are
// replaced with short summaries (keeping the most recent round intact).
// Saves ~1-3K tokens per round on 3+ round loops.
import { compactOldToolResults } from "./toolResultCompaction";

// ─── Model fallback chain ───────────────────────────────────────────────────
// Google frequently deprecates Gemini models and rotates which ones are
// available to new GCP projects. As of Aug 2026:
//
//   - gemini-1.5-flash      — DEPRECATED (404 for everyone)
//   - gemini-2.0-flash      — DEPRECATED (404 for everyone)
//   - gemini-2.5-*          — 404 for NEW GCP projects (created after ~Jun 2026),
//                              AND scheduled for full shutdown October 2026
//   - gemini-3.0-flash      — was available, moderate free tier
//   - gemini-3.5-flash      — was available, moderate free tier
//   - gemini-3.6-flash      — was available, VERY restrictive free tier (20 RPD!)
//   - gemini-3.7-flash      — GA Aug 13, 2026. New production workhorse.
//                              Best price-performance for coding + agents.
//   - gemini-3.1-flash      — older 3.x, still available as fallback
//   - gemini-flash-latest   — alias, resolves unpredictably (may 404)
//
// v3.0 incidents:
//   1. gemini-flash-latest resolved to gemini-3.6-flash (20 RPD) → 429 storm
//   2. Reordered chain to put 2.5-* first → ALL 404 (new GCP project)
//
// v6.2 Part 10 (Production fix, Aug 18 2026):
//   - Production logs showed "All configured Gemini models are unavailable"
//     on every request → AI router fell back to Groq → Groq was ALSO broken
//     (llama-3.3-70b-versatile decommissioned Aug 16, 2026) → 500 error.
//   - Root cause: the static chain had stale 3.0/3.5/3.6 names that 404
//     for many projects, AND 2.5-* names that are being shut down Oct 2026.
//   - Fix: put gemini-3.7-flash (just GA'd Aug 13) FIRST in the chain.
//     Keep the auto-discovery (v3.0.1) as the primary source of truth —
//     the static chain is only the fallback if discovery fails.
//
// v3.0.1 fix: auto-discover available models at startup via ListModels API.
// This way we never waste time trying models that will 404. We also add
// the 3.x models to the static chain as a fallback if discovery fails.
const MODEL_FALLBACK_CHAIN = [
  // v6.2 Part 10: GA Aug 13, 2026. New production workhorse — try FIRST.
  "gemini-3.7-flash",
  // Older 3.x models — still available as fallbacks.
  "gemini-3.1-flash",
  "gemini-3.0-flash",
  "gemini-3.5-flash",
  "gemini-3.6-flash", // VERY restrictive (20 RPD) but works for new projects
  // 2.x models — scheduled for FULL SHUTDOWN October 2026.
  // Kept as last-resort fallbacks for older GCP projects that still have them.
  "gemini-2.5-flash-lite", // 1500 RPD free tier — best for production (if available)
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  // Aliases — unpredictable, last resort
  "gemini-flash-latest",
  // Legacy — almost certainly 404, but try anyway
  "gemini-2.0-flash",
  "gemini-1.5-flash",
];

// ─── v3.0.1: Auto-discovered model list ──────────────────────────────────────
// On the first request, we call client.models.list() to discover which
// models are actually available for this API key. This replaces the static
// fallback chain with a dynamic one, avoiding wasted 404 round-trips.
//
// _discoveredModels is null before discovery, an array after. If discovery
// fails (network error, auth error), we fall back to MODEL_FALLBACK_CHAIN.
//
// ─── v3.9: concurrency-safe discovery ──────────────────────────────────
//
// Previously: `let _discoveryAttempted = false` + `let _discoveredModels`
// were bare module-level flags. If two requests arrived simultaneously
// on a cold start, BOTH would see `_discoveryAttempted === false`, BOTH
// would call `discoverAvailableModels()`, and whichever finished LAST
// would overwrite the other's result — a classic check-then-act race.
//
// Worse: `_discoveryAttempted = true` was set BEFORE the `await` (in the
// old `discoverAvailableModels` body), so concurrent callers saw
// `_discoveryAttempted === true` but `_discoveredModels === null` and
// skipped discovery entirely, falling back to the static chain.
//
// Fix: use in-flight promise memoization. The first caller stores its
// in-flight Promise in `_discoveryPromise`; concurrent callers await the
// SAME promise (single API call, single result). The promise is cleared
// on completion (success OR failure) so `forceRediscover()` can re-trigger.
//
// This is the standard memoization pattern for async singletons — same
// approach used by Vercel's `getModule` cache and Next.js's module
// initialization. JS event-loop single-threading guarantees the
// check-then-set on `_discoveryPromise` is atomic (no preemption between
// the `if` check and the assignment).
let _discoveredModels: string[] | null = null;
let _discoveryPromise: Promise<string[] | null> | null = null;

// ─── v3.0.1: Per-model cooldown for 429 quota exhaustion ────────────────────
// When a model returns 429, we add it to this map with a cooldown timestamp.
// Until the cooldown expires, we skip that model entirely (don't even try it).
// This prevents wasting the 20 RPD quota of gemini-3.6-flash on rapid retries.
//
// v3.3: Per-model cooldown is now Redis-backed (see lib/modelCooldown.ts).
// The isOnCooldown(), setCooldown(), and related functions are imported from there.
// This enables distributed coordination across server instances — when instance A
// gets a 429 from a model, instance B knows to skip it too.

// ─── v3.0 configurable generation params ────────────────────────────────────
// Read once at module load (not per-request) — these are deployment-wide
// settings, not per-message. Changing them requires a server restart.
function getTemperature(): number {
  const raw = Number(process.env.AI_TEMPERATURE);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 2) return raw;
  return 0.4; // default — factual plant care rewards low temperature
}

function getMaxOutputTokens(): number {
  const raw = Number(process.env.AI_MAX_TOKENS);
  if (Number.isFinite(raw) && raw >= 256 && raw <= 8192) return raw;
  return 2048; // v3.0: raised from 1024 — plant care guides can hit 1024 with formatting
}

function getMaxRetries(): number {
  const raw = Number(process.env.AI_MAX_RETRIES);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 10) return raw;
  return 3;
}

/**
 * v3.9: Max number of auto-continue calls when the model hits maxOutputTokens.
 *
 * When finishReason === "MAX_TOKENS" (Gemini) or "length" (Groq), the
 * response was truncated. We make up to N additional calls, appending the
 * partial text + a "continue from where you left off" instruction, until
 * the model finishes naturally (STOP) or we hit the limit.
 *
 * v6.1 Part 6 (latency optimization): default reduced from 2 to 1. Each
 * auto-continue call adds ~500ms-2s. With AI_MAX_TOKENS=2048 (the default),
 * most responses fit in a single call — the auto-continue only triggers
 * when the response is genuinely long (care guides, multi-listing
 * recommendations). 1 continuation (2 total calls × 2048 = 4096 tokens)
 * is enough for ~99% of responses.
 *
 * Set to 0 to disable auto-continue entirely (restores v3.8 behavior).
 * Set to 2+ if you regularly have responses >4096 tokens.
 */
function getMaxAutoContinues(): number {
  const raw = Number(process.env.AI_MAX_AUTO_CONTINUES);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 5) return raw;
  return 1;
}

// ─── Lazy-initialized client ─────────────────────────────────────────────────
//
// v3.9: the client itself is safe to construct concurrently (GoogleGenAI
// is just config + an HTTP fetcher — no shared mutable state inside).
// The old `_clientInitAttempted` flag was a guard against repeated
// construction, but JS event-loop single-threading already guarantees
// `_client` is assigned atomically. We keep the lazy pattern but drop
// the now-vestigial flag (it was dead code after the v3.8 cache fix).
let _client: GoogleGenAI | null = null;

// The model that's currently known to work. Set on first successful call,
// reused for all subsequent calls. Reset to null on 404 to retry the chain.
//
// v3.9: this is a CACHE, not a correctness invariant. If two concurrent
// requests race to set it (both succeed on different models — rare but
// possible during the fallback chain), the last writer wins. That's
// fine: both models work, and the next request will reuse whichever
// was last cached. No correctness issue — just a potential extra
// fallback-chain walk on the next request if the cached model 404s.
let _workingModel: string | null = null;

/**
 * Exports for Phase 2 KB chunking + embeddings.
 *
 * `getClient` is used by kbChunking.ts (for generateContent) and
 * kbEmbeddings.ts (for embedContent). `callWithFallback` wraps SDK calls
 * with the model fallback chain + retry logic — both KB modules use it
 * so they inherit the same 404/429/cooldown handling as the chat route.
 *
 * Phase 2 is the first caller outside of gemini.ts itself; we export
 * these as `@internal` API surface — they're not part of the public
 * chat-route API and may be refactored in Phase 5.
 */
export function getClient(): GoogleGenAI {
  // v3.9: simplified — drop the vestigial `_clientInitAttempted` flag.
  // JS event-loop single-threading guarantees `_client` is checked + set
  // atomically (no preemption between the `if` and the assignment), so
  // concurrent callers either both see null (rare on a warm process) or
  // both see the initialized client. Even if both see null, the worst
  // case is two `new GoogleGenAI()` constructions — cheap + idempotent.
  if (_client) return _client;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.warn(
      "GEMINI_API_KEY env var is not set — AI assistant routes will return 503. " +
        "Get a free key at https://aistudio.google.com/apikey",
    );
    throw new Error(
      "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey " +
        "and add it as the GEMINI_API_KEY env var.",
    );
  }
  _client = new GoogleGenAI({ apiKey });
  logger.info(
    {
      // Show what we'll try first.
      preferredModel: process.env.AI_MODEL ?? "(auto-fallback chain)",
      fallbackChain: MODEL_FALLBACK_CHAIN,
      temperature: getTemperature(),
      maxOutputTokens: getMaxOutputTokens(),
      maxRetries: getMaxRetries(),
    },
    "Google GenAI client initialized for TreeBot (model will be auto-selected on first request)",
  );
  return _client;
}

// ─── Public helpers ──────────────────────────────────────────────────────────

/**
 * v3.0.1: Discovers which Gemini models are available for this API key by
 * calling the ListModels API. Returns model names (without the "models/"
 * prefix) that support generateContent.
 *
 * Called once on the first chat request. The result is cached in
 * _discoveredModels so subsequent requests skip the discovery round-trip.
 *
 * If discovery fails (network, auth, etc.), returns null — the caller
 * falls back to the static MODEL_FALLBACK_CHAIN.
 *
 * v3.9: concurrency-safe via in-flight promise memoization. If two
 * requests arrive on a cold start, the first stores its Promise in
 * `_discoveryPromise`; the second awaits the SAME promise (single API
 * call). Previously, `_discoveryAttempted` was set before the await,
 * so concurrent callers saw `true` + `null` and skipped discovery.
 *
 * @internal — exported only for the /api/ai/admin/models debug endpoint.
 */
export async function discoverAvailableModels(): Promise<string[] | null> {
  // v3.9: if discovery already completed, return cached result.
  if (_discoveredModels !== null) return _discoveredModels;

  // v3.9: if discovery is in-flight, await the same promise (coalesce).
  // JS event-loop single-threading guarantees this check-then-set is
  // atomic — no preemption between the `if` and the assignment.
  if (_discoveryPromise) return _discoveryPromise;

  // We're the first caller — kick off discovery + cache the promise.
  _discoveryPromise = (async () => {
    const client = getClient();

    try {
      const available: string[] = [];
      const response = await client.models.list();

      // The @google/genai SDK's models.list() can return different shapes
      // depending on the SDK version:
      //   v1.52+: an async-iterable Pager yielding model objects directly
      //   older:  an object { models: [...] } or { page: [...] }
      // We handle ALL cases so discovery works regardless of SDK version.

      const extractModel = (model: any): { name: string; methods: string[] } | null => {
        if (!model || typeof model !== "object") return null;
        const name: string = model.name ?? model.model ?? "";
        // Field name varies: supportedGenerationMethods (REST) vs supported_methods (SDK)
        const methods: string[] =
          model.supportedGenerationMethods ?? model.supported_methods ?? model.methods ?? [];
        const bareName = name.replace(/^models\//, "");
        if (!bareName) return null;
        return { name: bareName, methods };
      };

      // Case 1: response is directly async-iterable (Pager) — yields model objects
      if (response && typeof (response as any)[Symbol.asyncIterator] === "function") {
        for await (const model of response as any) {
          const extracted = extractModel(model);
          if (extracted && extracted.methods.includes("generateContent")) {
            available.push(extracted.name);
          }
        }
      }
      // Case 2: response is an object with a .models array (REST-style)
      else if (response && Array.isArray((response as any).models)) {
        for (const model of (response as any).models) {
          const extracted = extractModel(model);
          if (extracted && extracted.methods.includes("generateContent")) {
            available.push(extracted.name);
          }
        }
      }
      // Case 3: response is an object with a .page array
      else if (response && Array.isArray((response as any).page)) {
        for (const model of (response as any).page) {
          const extracted = extractModel(model);
          if (extracted && extracted.methods.includes("generateContent")) {
            available.push(extracted.name);
          }
        }
      }
      // Case 4: response is directly an array
      else if (Array.isArray(response)) {
        for (const model of response) {
          const extracted = extractModel(model);
          if (extracted && extracted.methods.includes("generateContent")) {
            available.push(extracted.name);
          }
        }
      }
      // Case 5: @google/genai ≥1.50 — the Pager shape. `client.models.list()`
      // returns a Pager object whose `.pageInternal` field is the underlying
      // array of model descriptors. The SDK intentionally does NOT expose
      // pageInternal as a public property, but @google/genai@1.52 (and
      // likely other 1.5x versions) leak it on the returned object — see
      // the responsePreview in render-log:
      //   {"pageInternal":[{"name":"models/gemini-2.5-flash-native-audio-preview-12-2025",...}]}
      // Without this case, discovery returns 0 models → static fallback
      // chain → every Gemini model 404s (new GCP projects have no
      // legacy 2.x models), and the AI assistant is completely broken.
      //
      // We also attempt the async-iterator path first (Case 1) since
      // a real Pager should be async-iterable. When the SDK version
      // ships a non-iterable object that only exposes pageInternal
      // (as observed in production logs), we fall through to here.
      else if (
        response &&
        typeof response === "object" &&
        Array.isArray((response as any).pageInternal)
      ) {
        for (const model of (response as any).pageInternal) {
          const extracted = extractModel(model);
          if (extracted && extracted.methods.includes("generateContent")) {
            available.push(extracted.name);
          }
        }
      }
      // Case 6: unexpected shape — log it so we can debug
      else {
        logger.warn(
          {
            responseType: typeof response,
            responseKeys: response && typeof response === "object" ? Object.keys(response) : null,
            responsePreview: JSON.stringify(response).slice(0, 500),
          },
          "TreeBot: ListModels returned an unexpected response shape. " +
            "Discovery will be skipped (falling back to static chain). " +
            "Please report this shape so the extraction logic can be updated.",
        );
      }

      // If we got 0 models despite a successful call, that's suspicious —
      // probably the response shape wasn't recognized. Fall back to null
      // so getModelChain() uses the static chain instead of an empty array.
      if (available.length === 0) {
        logger.warn(
          {
            responseType: typeof response,
            responsePreview: JSON.stringify(response).slice(0, 500),
          },
          "TreeBot: ListModels returned 0 models that support generateContent. " +
            "This is likely a response-shape mismatch — falling back to static chain. " +
            "The static chain will be used, but may waste time on 404s.",
        );
        _discoveredModels = null;
        return null;
      }

      // Sort: prefer "flash" models first (faster + cheaper), then "pro".
      // Within each tier, prefer newer versions (higher numbers).
      available.sort((a, b) => {
        const aFlash = a.includes("flash");
        const bFlash = b.includes("flash");
        if (aFlash && !bFlash) return -1;
        if (!aFlash && bFlash) return 1;
        return b.localeCompare(a, undefined, { numeric: true });
      });

      _discoveredModels = available;
      logger.info(
        { count: available.length, models: available },
        "TreeBot: discovered available Gemini models via ListModels API",
      );
      return available;
    } catch (err) {
      logger.warn(
        { err: (err as any)?.message ?? String(err) },
        "TreeBot: model discovery failed, falling back to static chain. " +
          "This is non-fatal — the static chain will be used, but may waste " +
          "time on 404s for models not available to your API key.",
      );
      _discoveredModels = null;
      return null;
    } finally {
      // v3.9: clear the in-flight promise so forceRediscover() can
      // re-trigger discovery. Subsequent callers will hit the cached
      // `_discoveredModels` (set above) on the fast path.
      _discoveryPromise = null;
    }
  })();

  return _discoveryPromise;
}

/**
 * The list of models we'll try, in order. Priority:
 *   1. If AI_MODEL env var is set, use ONLY that (no fallback).
 *   2. If model discovery succeeded AND found >0 models, use the discovered list.
 *   3. Fall back to the static MODEL_FALLBACK_CHAIN.
 *
 * v3.0.1: also filters out models currently on cooldown (recently 429'd).
 *
 * v3.0.2: treats empty discovered list same as null — falls back to static
 * chain. This fixes the bug where discovery "succeeded" but returned 0
 * models (due to unrecognized response shape), causing getModelChain()
 * to return [] and the for-loop to try 0 models.
 */
export async function getModelChain(): Promise<string[]> {
  const explicit = process.env.AI_MODEL;
  if (explicit && explicit.trim().length > 0) {
    return [explicit.trim()];
  }

  // Use discovered models if available AND non-empty, otherwise static chain.
  const baseChain =
    _discoveredModels && _discoveredModels.length > 0 ? _discoveredModels : MODEL_FALLBACK_CHAIN;

  // v3.3: Filter out models on cooldown (Redis-backed, async).
  // Check all models in parallel for speed.
  const cooldownChecks = await Promise.all(
    baseChain.map((m) => isOnCooldown("gemini", m).then((onCd) => ({ m, onCd }))),
  );
  const filtered = cooldownChecks.filter(({ onCd }) => !onCd).map(({ m }) => m);

  // If ALL models are on cooldown, return the full chain anyway (better
  // to try and get a 429 than to return an empty chain and crash).
  return filtered.length > 0 ? filtered : baseChain;
}

/**
 * Check if an SDK error indicates the model is unavailable (404 NOT_FOUND).
 * Used to decide whether to try the next model in the fallback chain.
 */
function isModelNotFoundError(err: unknown): boolean {
  const e = err as any;
  // Check the nested error shape used by @google/genai: { error: { code, status } }
  const status = e?.status ?? e?.error?.code ?? e?.code;
  if (status === 404 || status === "NOT_FOUND") return true;

  // Some errors come as a JSON string in `message`. Parse and inspect.
  const msg = typeof e?.message === "string" ? e.message : "";
  if (/no longer available|not found|model.*deprecated/i.test(msg)) return true;
  if (/code.*404|status.*NOT_FOUND/i.test(msg)) return true;

  return false;
}

/**
 * v3.0: Check if an error is transient (worth retrying on the SAME model).
 *
 * Retries on:
 *   - 5xx server errors (Google backend hiccup)
 *   - Network errors (ECONNRESET, ETIMEDOUT, fetch failed)
 *
 * Does NOT retry on:
 *   - 429 rate limits / quota exhaustion — handled by callWithFallback
 *     (tries the NEXT model instead of retrying the same one). This is
 *     important because:
 *       a) Per-DAY quotas (e.g. gemini-3.6-flash free tier = 20/day) won't
 *          reset in seconds, so retrying is pointless.
 *       b) Even per-MINUTE rate limits are better handled by falling back
 *          to a different model than waiting + retrying the same one.
 *   - 404 NOT_FOUND (handled by model fallback chain instead)
 *   - 400/401/403 (bad request / auth — retrying won't help)
 *   - 451 (legal block)
 */
function isTransientError(err: unknown): boolean {
  const e = err as any;
  const status = e?.status ?? e?.error?.code ?? e?.code;
  if (typeof status === "number") {
    // 429 is NOT transient here — it triggers model fallback in callWithFallback.
    if (status >= 500 && status < 600) return true;
  }
  const msg = typeof e?.message === "string" ? e.message.toLowerCase() : "";
  // Explicitly exclude 429 / quota / rate-limit from transient — those are
  // handled by isQuotaExhaustedError() + callWithFallback.
  if (/econnreset|etimedout|enotfound|fetch failed|network error/i.test(msg)) return true;
  if (/internal error|server error|service unavailable|temporarily unavailable/i.test(msg))
    return true;
  return false;
}

/**
 * v3.0: Check if an error indicates the model's quota is exhausted (429).
 *
 * This triggers model fallback in callWithFallback — we try the NEXT model
 * in the chain instead of retrying the same one. This handles:
 *
 *   - Per-DAY quota exhaustion (e.g. gemini-3.6-flash free tier = 20/day):
 *     Retrying is pointless (quota resets in ~24h), so we immediately
 *     fall back to gemini-2.5-flash-lite which has a 1500/day quota.
 *
 *   - Per-MINUTE rate limits: Still better to try the next model than
 *     wait + retry the same one (the next model likely has its own
 *     separate per-minute quota).
 *
 * Detection:
 *   - HTTP status 429
 *   - Status string "RESOURCE_EXHAUSTED"
 *   - Message contains "quota", "rate limit", "too many requests"
 *
 * Note on quotaId parsing:
 *   The error details may include a `quotaId` like
 *   "GenerateRequestsPerDayPerProjectPerModel-FreeTier" or
 *   "GenerateRequestsPerMinutePerProjectPerModel-FreeTier".
 *   We don't differentiate — both trigger model fallback. (For per-minute
 *   limits, the next model is usually available immediately. For per-day
 *   limits, the next model is the only option.)
 */
function isQuotaExhaustedError(err: unknown): boolean {
  const e = err as any;
  const status = e?.status ?? e?.error?.code ?? e?.code;
  if (status === 429 || status === "RESOURCE_EXHAUSTED") return true;

  const msg = typeof e?.message === "string" ? e.message.toLowerCase() : "";
  if (/quota exceeded|rate limit|too many requests|resource_exhausted/i.test(msg)) return true;

  // Check the nested error message (Google SDK wraps the actual error).
  const nestedMsg = typeof e?.error?.message === "string" ? e.error.message.toLowerCase() : "";
  if (/quota exceeded|rate limit|too many requests|resource_exhausted/i.test(nestedMsg))
    return true;

  return false;
}

/**
 * v3.0: Sleep helper for exponential backoff.
 * Returns after `ms` milliseconds. Uses setTimeout wrapped in a Promise
 * so it works in both Node.js and Vercel serverless environments.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * v3.0: Wraps an async function with retry-on-transient-error logic.
 *
 * - Retries up to `maxRetries` times on isTransientError.
 * - Exponential backoff: 500ms, 1000ms, 2000ms, 4000ms... (+ jitter)
 * - On a non-transient error, rethrows immediately (no retry).
 * - On 404, the caller (callWithFallback) handles model fallback.
 *
 * @param fn - The async function to retry. Receives no args.
 * @param context - Used for logging (e.g. "streamGeminiChat round 0").
 * @returns The result of the first successful call.
 */
async function withRetry<T>(fn: () => Promise<T>, context?: Record<string, unknown>): Promise<T> {
  const maxRetries = getMaxRetries();
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // 404 → don't retry here; let callWithFallback handle model switching.
      if (isModelNotFoundError(err)) throw err;

      // 429 / quota exhaustion → don't retry here; let callWithFallback
      // try the next model in the chain. Retrying the same model on a
      // per-day quota is pointless (won't reset for hours), and even
      // per-minute limits are better handled by switching models.
      if (isQuotaExhaustedError(err)) throw err;

      // Non-transient → don't retry, rethrow immediately.
      if (!isTransientError(err)) throw err;

      // Transient → retry with backoff (unless this was the last attempt).
      if (attempt === maxRetries) {
        logger.error(
          { err, attempt, maxRetries, ...context },
          "TreeBot: exhausted retries on transient error",
        );
        throw err;
      }

      const baseDelay = 500 * Math.pow(2, attempt); // 500, 1000, 2000, 4000...
      const jitter = Math.floor(Math.random() * 250); // 0–250ms
      const delay = baseDelay + jitter;
      logger.warn(
        { err, attempt, nextAttempt: attempt + 1, delayMs: delay, ...context },
        "TreeBot: transient error, retrying with backoff",
      );
      await sleep(delay);
    }
  }

  // Unreachable, but TypeScript doesn't know that.
  throw lastErr;
}

/**
 * Calls a Gemini SDK function with automatic model fallback + retry.
 *
 * Tries the cached working model first. If it 404s (model deprecated
 * for this API key / project), tries the next model in the fallback
 * chain. The first model that succeeds is cached and tried first on
 * subsequent calls. Transient errors (5xx, 429, network) trigger a
 * retry with exponential backoff (v3.0).
 *
 * @param fn - A function that takes a model name and returns a Promise.
 *   Called with each model in the chain until one succeeds.
 * @returns The result of the first successful call.
 * @throws If ALL models in the chain return 404, or if a non-404 error occurs.
 */
export async function callWithFallback<T>(fn: (modelName: string) => Promise<T>): Promise<T> {
  // v3.0.1: trigger model discovery on the first call. This populates
  // _discoveredModels so getModelChain() returns only models that actually
  // exist for this API key (avoids wasting time on 404s).
  // If discovery already ran (or fails), this is a fast no-op.
  //
  // v3.9: `discoverAvailableModels()` is now concurrency-safe via in-flight
  // promise memoization. Calling it here is always safe — it returns the
  // cached result immediately if discovery already completed, or awaits
  // the in-flight promise if another request triggered it.
  if (_discoveredModels === null) {
    await discoverAvailableModels();
  }

  const tryModels: string[] = [];
  if (_workingModel) tryModels.push(_workingModel);
  const chain = await getModelChain(); // v3.3: now async (Redis cooldown check)
  for (const m of chain) {
    if (!tryModels.includes(m)) tryModels.push(m);
  }

  let lastErr: unknown = null;
  for (const modelName of tryModels) {
    try {
      // v3.0: wrap the per-model call in withRetry so transient errors
      // (5xx, 429, network) are retried before we give up on this model
      // and try the next one in the chain.
      const result = await withRetry(() => fn(modelName), { model: modelName });
      // Success — cache this model for future calls.
      if (_workingModel !== modelName) {
        logger.info(
          { model: modelName, previousModel: _workingModel },
          "TreeBot: model selected and cached for subsequent requests",
        );
        _workingModel = modelName;
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (isModelNotFoundError(err)) {
        // This model is deprecated/unavailable — try the next one.
        if (_workingModel === modelName) {
          logger.warn(
            { model: modelName },
            "TreeBot: previously-cached model is now unavailable, retrying fallback chain",
          );
          _workingModel = null;
        } else {
          logger.warn(
            { model: modelName },
            "TreeBot: model unavailable, trying next in fallback chain",
          );
        }
        continue;
      }
      if (isQuotaExhaustedError(err)) {
        // v3.0.1: This model's quota is exhausted (429 RESOURCE_EXHAUSTED).
        // Don't retry it — try the next model in the chain. This handles
        // both per-day quotas (e.g. gemini-3.6-flash free tier = 20/day)
        // and per-minute rate limits. The next model has its own separate
        // quota, so it will likely succeed.
        //
        // v3.0.1: Set a cooldown on this model so we DON'T try it again
        // for AI_QUOTA_COOLDOWN_MS (default 60s). This prevents wasting
        // the 20 RPD quota of gemini-3.6-flash on rapid retries within
        // the same minute. After the cooldown, we'll try it again (per-minute
        // quotas may have reset; per-day quotas won't have, but the 429
        // will tell us that quickly).
        await setCooldown("gemini", modelName);

        const wasCached = _workingModel === modelName;
        if (wasCached) {
          logger.warn(
            { model: modelName, err: describeErrorForLog(err) },
            "TreeBot: cached model quota exhausted (429), clearing cache + on cooldown, trying next in fallback chain",
          );
          _workingModel = null;
        } else {
          logger.warn(
            { model: modelName, err: describeErrorForLog(err) },
            "TreeBot: model quota exhausted (429), on cooldown, trying next in fallback chain",
          );
        }
        continue;
      }
      // Fix: 5xx server errors (503 "high demand", 502, 500) after retries
      // exhausted. The `withRetry` wrapper already retried 3 times with
      // exponential backoff. If it still fails, try the NEXT model —
      // different Gemini models may be served by different backend servers,
      // so one being overloaded doesn't mean they all are.
      if (isTransientError(err)) {
        logger.warn(
          { model: modelName, err: describeErrorForLog(err) },
          "TreeBot: transient 5xx error after retries exhausted, trying next model in fallback chain",
        );
        continue; // try the next model
      }
      // Non-404, non-429, non-transient error (auth, bad request, etc.) —
      // don't try other models, just rethrow. The route handler will surface it.
      throw err;
    }
  }

  // All models in the chain returned 404, 429, or 5xx (after retries).
  // Build a more helpful error message based on which error type dominated.
  const allQuota = isQuotaExhaustedError(lastErr);
  const allTransient = !allQuota && isTransientError(lastErr);
  const errMsg = allQuota
    ? "TreeBot: ALL models in the fallback chain returned 429 quota exhausted. " +
      "Your Gemini free-tier daily quota is depleted across all models. " +
      "Action: wait for the quota to reset (usually at midnight Pacific time), " +
      "or upgrade to a paid tier at https://ai.google.dev/pricing."
    : allTransient
      ? "TreeBot: ALL models in the fallback chain returned 5xx (service unavailable). " +
        "Gemini is experiencing high demand. This is usually temporary. " +
        "The AI router should fall back to Groq."
      : "TreeBot: ALL models in the fallback chain returned 404. " +
        "Either the API key is invalid OR Google has deprecated every model we know. " +
        "Action: visit https://ai.google.dev/gemini-api/docs/models to find the current model name, " +
        "then set it as the AI_MODEL env var.";

  logger.error({ err: lastErr, triedModels: tryModels, allQuota, allTransient }, errMsg);
  throw new Error(
    allQuota
      ? "All Gemini models are rate-limited right now. Please try again later."
      : allTransient
        ? "All Gemini models are temporarily unavailable (503). " +
          "The service is experiencing high demand. Please try again later."
        : "All configured Gemini models are unavailable. " +
          "Please set the AI_MODEL env var to a currently-available model name " +
          "(see https://ai.google.dev/gemini-api/docs/models).",
  );
}

/**
 * v3.0: Extracts a short, log-safe error summary from a Gemini SDK error.
 *
 * The SDK error objects are deeply nested JSON strings, which makes logs
 * hard to read. This helper pulls out the most useful bits (status, model,
 * quota metric) for the warn-level "trying next model" log line.
 */
function describeErrorForLog(err: unknown): string {
  const e = err as any;
  const status = e?.status ?? e?.error?.code ?? e?.code ?? "?";
  // Try to extract the model name from the quota dimensions, if present.
  let model: string | undefined;
  let quotaMetric: string | undefined;
  try {
    const msgStr = typeof e?.message === "string" ? e.message : "";
    const parsed = JSON.parse(msgStr);
    const details = parsed?.error?.details ?? [];
    for (const d of details) {
      if (d?.["@type"]?.includes("QuotaFailure")) {
        for (const v of d.violations ?? []) {
          model = v?.quotaDimensions?.model ?? model;
          quotaMetric = v?.quotaMetric ?? quotaMetric;
        }
      }
    }
  } catch {
    // not JSON, ignore
  }
  const parts = [`status=${status}`];
  if (model) parts.push(`model=${model}`);
  if (quotaMetric) parts.push(`metric=${quotaMetric}`);
  return parts.join(" ");
}

/**
 * v3.0: Generate a short summary of an older conversation using a fast,
 * cheap model. Used by the route to compress long histories.
 *
 * We use the non-streaming generateContent call (no need to stream a
 * summary — it's an internal operation). Returns the summary text.
 */
export async function summarizeConversation(
  messages: { role: "user" | "assistant"; content: string }[],
): Promise<string> {
  const client = getClient();
  if (!client) {
    throw new Error("GEMINI_API_KEY is not set; cannot summarize conversation.");
  }

  // Build a compact transcript: role-labeled lines.
  const transcript = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");

  const summaryPrompt = `Summarize the following plant-assistant conversation in 3-5 sentences.
Capture:
- What plants/topics the user asked about
- Key advice or recommendations given
- Any products mentioned or recommended
- The user's garden setup (if mentioned: indoor/balcony/garden, climate, soil type)

Be concise — this summary will be injected into a future system prompt to
give the assistant long-term memory. Don't include greetings or small talk.

CONVERSATION:
${transcript}

SUMMARY:`;

  const result = await callWithFallback((modelName) =>
    client.models.generateContent({
      model: modelName,
      contents: [{ role: "user" as const, parts: [{ text: summaryPrompt }] }],
      config: {
        temperature: 0.2, // low — summaries should be factual
        maxOutputTokens: 300, // short summary
      },
    }),
  );

  const text = (result as any)?.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Gemini returned empty summary.");
  }
  return text.trim();
}

/**
 * Streams a chat completion from Gemini. Yields incremental text chunks
 * (deltas) suitable for SSE forwarding to the browser.
 *
 * v2.5: supports function calling. If Gemini decides to call a tool
 * (e.g. search_catalog), we execute the tool and send the result back
 * to Gemini in a multi-round loop. The final text response is then
 * streamed to the client.
 *
 * v3.0: adds retry-on-transient-error (via withRetry inside callWithFallback),
 * env-configurable temperature/maxOutputTokens, and truncation detection.
 *
 * v3.6 (industry-standard streaming fix):
 *   - Uses `generateContentStream` for EVERY round, including tool rounds.
 *     Text deltas are now streamed live even while the model is also
 *     emitting function-call parts. Previously, only the final text round
 *     streamed — multi-tool queries felt frozen until tools completed.
 *   - Removed the redundant "re-call with streaming" API call that the
 *     old code made on rounds > 0. The streaming already happened in the
 *     same call that detected the (lack of) function calls.
 *   - MAX_TOOL_ROUNDS is now configurable via AI_MAX_TOOL_ROUNDS (default
 *     10, was 4), with stuck-detection (same tool + same args in two
 *     consecutive rounds → abort) and graceful degradation (force-final
 *     call with tools disabled when the budget is exhausted). See
 *     lib/aiToolLoop.ts for the shared loop-control logic.
 *
 * @param systemPrompt - Strict scope-restricting system instruction
 * @param history - Prior turns of the conversation, oldest first
 * @param userMessage - The new user message to respond to
 * @param tools - Optional: { declarations, execute } for function calling.
 *   If provided, Gemini can call tools during the conversation.
 *   If null/undefined, no tools are exposed (v1 behavior).
 * @param userId - The signed-in user's Clerk ID (passed to tool executor
 *   for privacy-sensitive tools like get_user_orders).
 *
 * @yields string — incremental text deltas. Empty string is never yielded.
 *   v3.0: also yields a special `{ type: "metadata", model, usage }` payload
 *   via the onMetadata callback (if provided) so the route can persist
 *   the model name + token count on the assistant message row.
 */
export async function* streamGeminiChat(
  // BUG-I5 fix: accept either a string (original behavior) or a getter
  // function `() => string` (so the prompt can change between tool rounds).
  // The getter is called before each round to get the current prompt.
  systemPrompt: string | (() => string),
  history: { role: "user" | "model"; text: string }[],
  userMessage: string,
  tools?: {
    declarations: FunctionDeclaration[];
    execute: (
      name: string,
      args: Record<string, unknown>,
      userId: string | null,
      // v6.2 Part 9 (Gap 17 fix — Phase B): optional context + onProgress.
      // The context is forwarded from the chat route (carries tone-locked
      // creator info). The onProgress callback lets long-running tools
      // emit live progress updates to the SSE pipe.
      //
      // We use a single options object as the 4th param so we can add
      // more fields later without breaking the signature again. Tools
      // that don't need progress just ignore it.
      options?: {
        context?: unknown;
        onProgress?: (progress: string) => void;
      },
    ) => Promise<unknown>;
  },
  userId?: string | null,
  onMetadata?: (meta: { model: string; usage?: unknown; toolCalls?: string[] }) => void,
  /**
   * v3.7: Fired when a tool is about to be executed (`tool_call`) and when
   * it finishes (`tool_result`). The route handler writes these as SSE
   * events so the frontend can show "Looking up your order..." chips
   * during multi-tool rounds. See lib/aiToolLoop.ts → ToolStreamEvent.
   */
  onToolEvent?: OnToolEvent,
  /**
   * BUG-I5 fix: callback invoked after each tool round. If it returns a
   * string, that string replaces the system prompt for subsequent rounds.
   * Forwarded from `streamChat` in aiRouter.ts.
   */
  onToolRoundComplete?: (round: number, toolCalls: ToolCallSignature[]) => string | void,
): AsyncGenerator<string, void, unknown> {
  const client = getClient();
  if (!client) {
    throw new Error(
      "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey " +
        "and add it as the GEMINI_API_KEY env var.",
    );
  }

  // BUG-I5 fix: resolve the system prompt source to a string for the
  // current round. Called before each `generateContentStream` call.
  // The getter pattern means the route's `onToolRoundComplete` callback
  // can mutate `currentSystemPrompt` in the route's closure, and the
  // getter will return the updated value on the next call.
  const resolveSystemPrompt = (): string =>
    typeof systemPrompt === "function" ? systemPrompt() : systemPrompt;

  // The @google/genai SDK accepts an array of `contents` for history
  // plus the new message.
  const initialContents: Record<string, unknown>[] = [
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: "user" as const, parts: [{ text: userMessage }] },
  ];

  const config: Record<string, unknown> = {
    // BUG-I5 fix: use the resolved system prompt (calls the getter if
    // a getter was passed). Updated before each round below.
    systemInstruction: resolveSystemPrompt(),
    temperature: getTemperature(),
    maxOutputTokens: getMaxOutputTokens(),
  };
  if (tools && tools.declarations.length > 0) {
    config.tools = [{ functionDeclarations: tools.declarations }];
  }

  // ─── P1 #5 fix: Gemini context caching for multi-round tool loops ──────────
  //
  // Attempt to create a context cache with the system prompt + initial
  // contents + tools. If successful, we reference the cache in `config.cachedContent`
  // for ALL rounds + only send the NEW contents (model parts + function responses
  // from previous rounds). The cached prefix is billed at a lower rate.
  //
  // If cache creation fails (or is disabled via env var), we fall back to the
  // existing non-cached behavior — no error surfaced to the user.
  //
  // The cache is deleted in a `finally` block after the loop completes (below).
  // The TTL is a safety net in case the delete fails.
  //
  // System-prompt-stability-aware: if the system prompt changes between rounds
  // (e.g., the BUG-I5 fix clears the {{knowledge}} block after the first
  // search_knowledge_base call), we abandon the cache + fall back to non-cached.
  // This is checked via `isCacheStillValid()` before each round.
  let contextCache: GeminiContextCache | null = null;
  try {
    if (tools && tools.declarations.length > 0) {
      contextCache = await maybeCreateGeminiContextCache(
        getClient(),
        _workingModel ?? "gemini-flash-latest",
        resolveSystemPrompt(),
        initialContents,
        { functionDeclarations: tools.declarations },
      );
    }
  } catch (err) {
    // Non-fatal — fall back to non-cached.
    logger.debug(
      { err: (err as Error)?.message ?? String(err) },
      "Gemini context cache: setup failed (falling back to non-cached — non-fatal)",
    );
    contextCache = null;
  }

  // P1 #5: when the cache is active, `contents` starts EMPTY (the initial
  // contents are in the cache — Gemini prepends them automatically). When
  // the cache is NOT active (disabled, creation failed, or abandoned mid-loop),
  // `contents` starts with the full initial contents (history + user message).
  //
  // As the loop progresses, model parts + function responses are appended to
  // `contents`. When the cache is active, these are the ONLY contents sent
  // (the cached prefix is prepended by Gemini). When the cache is NOT active,
  // these are appended to the initial contents (existing behavior).
  let contents: Record<string, unknown>[] = contextCache ? [] : [...initialContents];
  if (contextCache) {
    // Reference the cache in the config. The system instruction + tools
    // are in the cache, so we remove them from the config to avoid
    // duplication (the SDK would error if both were set).
    config.cachedContent = contextCache.name;
    delete config.systemInstruction;
    delete config.tools;
  }

  // ─── Multi-round function-calling loop (v3.6 streaming fix) ────────────
  //
  // Why we now stream EVERY round (not just the final text round):
  //
  //   The Gemini SDK's `generateContentStream` emits BOTH `text` parts
  //   AND `functionCall` parts as stream chunks. So a single streaming
  //   call can simultaneously:
  //     - stream the model's "Let me look that up..." preamble text
  //     - deliver the functionCall(s) once the model decides to call a tool
  //
  //   Previously we used non-streaming `generateContent` for tool rounds,
  //   which meant:
  //     1. The user saw NOTHING while the model was generating text + a
  //        tool call (could be 2-5 seconds of perceived silence).
  //     2. On the final text round (after tools completed), we made a
  //        REDUNDANT extra API call to stream what we'd already fetched
  //        non-streaming. That extra call added ~500ms latency and burned
  //        an extra request against the quota.
  //
  //   The new flow:
  //     - For each round, open a stream and iterate chunks.
  //     - Yield text deltas as they arrive (the user sees them immediately).
  //     - Accumulate functionCall parts in an array.
  //     - When the stream ends, IF there are accumulated function calls,
  //       execute them, append results to `contents`, and loop. The text
  //       we already streamed was the model's "thinking aloud" — the
  //       NEXT round will produce the actual answer.
  //     - IF there are NO function calls, the streamed text IS the final
  //       answer. Return. No redundant re-call.
  //
  // Loop control (max rounds, stuck detection, graceful degradation) is
  // shared with groq.ts via the ToolRoundBudget helper in lib/aiToolLoop.ts.
  //
  // P1 #5 fix: the entire loop is wrapped in a try/finally to ensure the
  // Gemini context cache (if created) is deleted after the loop completes
  // (success, error, or early termination via consumer break). The `finally`
  // block runs when the async generator is closed — this is the standard
  // pattern for resource cleanup in async generators.
  try {
    const budget = new ToolRoundBudget();

    // Bug #4 fix: track all tool calls across all rounds so we can emit them
    // in the final metadata callback. The route uses this to decide cache
    // policy (skip cache for user-scoped tools, short-TTL for catalog tools).
    const toolCallsCalled: string[] = [];
    let lastUsage: unknown = undefined;
    let lastModel: string = _workingModel ?? "unknown";

    // v3.6: helper that performs ONE streaming round against Gemini.
    // Returns the accumulated function calls (empty array if none) so the
    // caller can decide whether to loop or terminate.
    //
    // The `forceNoTools` param is used by the graceful-degradation path:
    // when we've hit the max-rounds budget, we call this with forceNoTools=true
    // so Gemini is forced to produce a text answer instead of more tool calls.
    const runOneStreamingRound = async function* (
      roundContents: Record<string, unknown>[],
      roundConfig: Record<string, unknown>,
      forceNoTools: boolean,
    ): AsyncGenerator<
      string,
      {
        functionCalls: any[];
        modelParts: any[];
        finishReason: string | null;
      },
      unknown
    > {
      const effectiveConfig: Record<string, unknown> = { ...roundConfig };
      if (forceNoTools) {
        // Industry-standard "force final" pattern: remove tools from the
        // config entirely + append a system instruction that tells the
        // model to stop calling tools and produce a final answer.
        delete effectiveConfig.tools;
        // P1 #5 fix: when the context cache is active, the system instruction
        // is in the cache (not in the config). We need to read the cached
        // instruction + append the suffix. Abandon the cache first so the
        // modified instruction is sent directly.
        if (contextCache) {
          const baseInstruction = contextCache.cachedSystemInstruction ?? "";
          effectiveConfig.systemInstruction = baseInstruction + buildForceFinalPromptSuffix();
          // Abandon the cache (will be cleaned up in the finally block).
          // We DON'T restore initialContents here because this is the FINAL
          // round (forceNoTools=true) — the model just needs to produce a
          // text answer from whatever context it already has. The contents
          // array already has the full conversation (model parts + function
          // responses from previous rounds).
          //
          // Wait — when the cache is active, `contents` only has the NEW tokens
          // (not the initial history + user message). If we abandon the cache
          // here, we need to restore the initial contents so the model sees
          // the full conversation.
          contents = [...initialContents, ...contents];
          delete effectiveConfig.cachedContent;
          // Restore tools to the config (will be deleted by forceNoTools above,
          // but we need them present so the cache abandonment is consistent).
          if (tools && tools.declarations.length > 0) {
            effectiveConfig.tools = [{ functionDeclarations: tools.declarations }];
            delete effectiveConfig.tools; // forceNoTools removes them again
          }
          // Mark the cache as abandoned (so the finally block doesn't try to delete it twice).
          const cacheToDelete = contextCache;
          contextCache = null;
          cacheToDelete.delete().catch((err) => {
            logger.debug(
              { err: (err as Error)?.message ?? String(err) },
              "Gemini context cache: delete on forceNoTools failed (non-fatal — will expire via TTL)",
            );
          });
        } else {
          const baseInstruction =
            typeof effectiveConfig.systemInstruction === "string"
              ? effectiveConfig.systemInstruction
              : "";
          effectiveConfig.systemInstruction = baseInstruction + buildForceFinalPromptSuffix();
        }
      }

      // callWithFallback wraps the SDK call so a 404 (model deprecated for
      // this API key) or 429 (quota exhausted) automatically retries with
      // the next model in the fallback chain.
      const stream: any = await callWithFallback((modelName) =>
        client.models.generateContentStream({
          model: modelName,
          contents: roundContents,
          config: effectiveConfig,
        }),
      );

      const functionCalls: any[] = [];
      let modelParts: any[] = [];
      let finishReason: string | null = null;

      for await (const chunk of stream) {
        // Yield text deltas as they arrive (real streaming).
        // chunk.text is a convenience accessor that concatenates all text
        // parts in this chunk. May be empty for chunks that only contain
        // functionCall parts.
        const text: string | undefined = chunk.text;
        if (typeof text === "string" && text.length > 0) {
          yield text;
        }

        // Accumulate function calls + preserve original parts.
        // Gemini 2.5 thinking models emit a `thoughtSignature` on the
        // function-call part that MUST be echoed back unchanged — otherwise
        // the next generateContent call fails with
        // "Function call is missing a thought_signature". So we collect
        // the FULL parts array from the candidate, not just the functionCall
        // objects.
        const candidates: any[] = chunk.candidates ?? [];
        for (const cand of candidates) {
          const parts: any[] = cand?.content?.parts ?? [];
          if (parts.length > 0) {
            modelParts = modelParts.concat(parts);
          }
          if (typeof cand?.finishReason === "string" && cand.finishReason.length > 0) {
            finishReason = cand.finishReason;
          }
          for (const part of parts) {
            if (part?.functionCall && typeof part.functionCall.name === "string") {
              functionCalls.push(part.functionCall);
            }
          }
        }

        // Track usage metadata (sent in the final chunk).
        if (chunk?.usageMetadata) {
          lastUsage = chunk.usageMetadata;
        }
      }

      return { functionCalls, modelParts, finishReason };
    };

    // ─── Main loop ─────────────────────────────────────────────────────────
    // Loop until either:
    //   - The model returns no function calls (final text answer streamed).
    //   - We exhaust the round budget (graceful degradation kicks in).
    //   - Stuck detection fires (same tool + same args twice in a row).
    while (budget.hasBudget) {
      const round = budget.currentRound;

      // BUG-I5 fix: refresh the system prompt before each round. If the
      // route passed a getter (`() => currentSystemPrompt`), this calls
      // the getter — which may have been updated by `onToolRoundComplete`
      // in a previous round (e.g. to clear the {{knowledge}} block after
      // the first search_knowledge_base call).
      const currentPrompt = resolveSystemPrompt();
      config.systemInstruction = currentPrompt;

      // P1 #5 fix: check if the context cache is still valid for the current
      // system prompt. If the prompt changed (e.g., BUG-I5 fix cleared the
      // {{knowledge}} block after the first search_knowledge_base call), the
      // cached system instruction is STALE — we must abandon the cache +
      // restore the system instruction + tools to the config (fall back to
      // non-cached for subsequent rounds).
      if (contextCache && !isCacheStillValid(contextCache, currentPrompt)) {
        logger.info(
          { round, cacheName: contextCache.name },
          "Gemini context cache: abandoning (system prompt changed — BUG-I5 fix cleared the {{knowledge}} block)",
        );
        // Restore the system instruction + tools to the config.
        config.systemInstruction = currentPrompt;
        if (tools && tools.declarations.length > 0) {
          config.tools = [{ functionDeclarations: tools.declarations }];
        }
        // Remove the cachedContent reference.
        delete config.cachedContent;
        // P1 #5: when abandoning the cache, we must RESTORE the initial contents
        // to `contents` (so subsequent rounds send the full context, not just
        // the new model parts + function responses). We prepend the initial
        // contents to the current `contents` (which has the model parts +
        // function responses from previous rounds).
        //
        // This is safe because the cache is being abandoned AFTER round 1 —
        // `contents` at this point has [modelParts1, functionResponses1, ...]
        // (the new tokens from previous rounds). Prepending `initialContents`
        // gives the full context: [history, userMessage, modelParts1, ...].
        contents = [...initialContents, ...contents];
        // Delete the cache (best-effort — non-fatal if it fails).
        contextCache.delete().catch((err) => {
          logger.debug(
            { err: (err as Error)?.message ?? String(err) },
            "Gemini context cache: delete on abandon failed (non-fatal — will expire via TTL)",
          );
        });
        contextCache = null;
      }

      if (budget.shouldWarnAboutHighRounds) {
        // Soft warning — operators should investigate. The loop continues
        // (this is not necessarily a bug; some legitimate queries take 6+
        // rounds when the model is paginating or refining searches).
        logger.warn(
          { round, maxRounds: budget.maxRoundsValue },
          "TreeBot: tool loop exceeded soft warning threshold — investigate if this happens often",
        );
        budget.markWarned();
      }

      // P1 #8 fix: compact older tool results before this round. Starting at
      // round TOOL_COMPACTION_MIN_ROUND (default 3), search_catalog /
      // search_seller_listings results from rounds 1 to N-2 are replaced with
      // short summaries. The most recent round's results are kept intact.
      // No-op when AI_TOOL_COMPACTION_ENABLED=false (the default) or when the
      // round is too early.
      compactOldToolResults(contents, round + 1);

      // Run one streaming round. Text deltas are yielded to the SSE
      // response as they arrive (the generator below forwards them).
      // The returned value gives us the accumulated function calls + parts.
      const gen = runOneStreamingRound(contents, config, false);
      let result: { functionCalls: any[]; modelParts: any[]; finishReason: string | null };
      while (true) {
        const { done, value } = await gen.next();
        if (done) {
          result = value as {
            functionCalls: any[];
            modelParts: any[];
            finishReason: string | null;
          };
          break;
        }
        if (typeof value === "string") {
          yield value;
        }
      }

      lastModel = _workingModel ?? "unknown";

      // v3.0: detect truncation. If the response hit maxOutputTokens,
      // finishReason will be "MAX_TOKENS".
      //
      // v3.9: auto-continue. When the model hits MAX_TOKENS with NO function
      // calls (pure text response), we make up to AI_MAX_AUTO_CONTINUES
      // additional calls, appending the partial text + a "continue" prompt,
      // until the model finishes naturally (STOP) or we hit the limit.
      //
      // This fixes the v3.8 bug where long plant-care guides (with markdown
      // formatting) got truncated at 2048 tokens, often cutting off the
      // [followups] block — which then triggered the structuredOutput
      // fallback LLM call (double cost). Now the response continues + the
      // [followups] block lands in the natural stop.
      //
      // We do NOT auto-continue when there are function calls — those loop
      // normally (the model will produce text in the next round after
      // seeing the tool results).
      const functionCalls = result.functionCalls;

      if (functionCalls.length === 0 || !tools) {
        // ─── No function calls — this was the final text response ────────
        // v3.9: auto-continue if truncated.
        if (result.finishReason === "MAX_TOKENS") {
          let continueCount = 0;
          const maxAutoContinues = getMaxAutoContinues();

          while (
            result.finishReason === "MAX_TOKENS" &&
            continueCount < maxAutoContinues &&
            !budget.hadStuckLoop
          ) {
            continueCount++;
            logger.info(
              { continueCount, maxAutoContinues, maxOutputTokens: getMaxOutputTokens() },
              "TreeBot: auto-continuing truncated response (MAX_TOKENS)",
            );

            // Append the partial model text + a "continue" user prompt.
            // The model sees its own partial output + knows to pick up
            // mid-sentence. This is the standard "continue generation"
            // pattern used by OpenAI, Anthropic, and LangChain.
            //
            // We use `result.modelParts` (the FULL parts array from the
            // stream, including thought signatures for Gemini 2.5 thinking
            // models) rather than reconstructing text — the SDK requires
            // the original parts to be echoed back unchanged.
            contents = [
              ...contents,
              {
                role: "model" as const,
                parts: result.modelParts,
              },
              {
                role: "user" as const,
                parts: [
                  {
                    text: "Continue your previous response exactly from where it was cut off. Do not repeat what you already said — just complete the remaining content.",
                  },
                ],
              },
            ];

            // Run one more streaming round (no tools — we're continuing
            // a text response, not calling more tools). The text deltas
            // are yielded to the SSE stream as they arrive.
            const continueGen = runOneStreamingRound(contents, config, true);
            let continueResult: {
              functionCalls: any[];
              modelParts: any[];
              finishReason: string | null;
            };
            while (true) {
              const { done, value } = await continueGen.next();
              if (done) {
                continueResult = value as {
                  functionCalls: any[];
                  modelParts: any[];
                  finishReason: string | null;
                };
                break;
              }
              if (typeof value === "string") {
                yield value;
              }
            }

            // If the continue call finished naturally (not MAX_TOKENS),
            // stop the loop. Otherwise, update result + loop again.
            if (continueResult.finishReason !== "MAX_TOKENS") {
              break;
            }
            result = continueResult;
          }

          if (result.finishReason === "MAX_TOKENS") {
            logger.warn(
              {
                finishReason: result.finishReason,
                maxOutputTokens: getMaxOutputTokens(),
                continueCount,
              },
              "TreeBot: response still truncated after auto-continue limit. Consider raising AI_MAX_TOKENS or AI_MAX_AUTO_CONTINUES.",
            );
          }
        }

        // The text was already streamed above. Emit metadata + return.
        if (onMetadata) {
          onMetadata({
            model: lastModel,
            usage: lastUsage,
            toolCalls: toolCallsCalled,
          });
        }
        return;
      }

      // ─── Function calls present — execute them and loop ─────────────────
      // Bug #4 fix: record the tool names so we can emit them in the final
      // metadata callback (used by the route for cache policy decisions).
      for (const fc of functionCalls) {
        if (typeof fc?.name === "string") {
          toolCallsCalled.push(fc.name);
        }
      }
      logger.info(
        { round, calls: functionCalls.map((fc: any) => fc.name) },
        "TreeBot: executing function calls",
      );

      // v3.6: Stuck detection — if this round's tool calls are identical
      // (same name + same args) to the PREVIOUS round's, the model is
      // stuck in a loop (the tool will return the same result, so the
      // model has no new information). Abort with a friendly message.
      //
      // v6.2 Part 12: signatureOf now requires a typed ToolName. If the LLM
      // hallucinated an unknown name, fall back to a placeholder signature
      // (rare — executeTool returns before any work happens for unknown names).
      const currentSignatures = functionCalls.map((fc: any) => {
        const sigName = (isToolName(fc.name) ? fc.name : "search_catalog") as ToolName;
        return signatureOf(sigName, fc.args ?? {});
      });
      const stuckTool = budget.detectStuck(currentSignatures);
      if (stuckTool) {
        logger.error(
          { round, stuckTool, maxRounds: budget.maxRoundsValue },
          "TreeBot: stuck loop detected — model called the same tool with the same args in consecutive rounds",
        );
        // v3.7 fix: mark stuck BEFORE break so shouldForceFinal returns true
        // and the graceful-degradation path runs (was: falling through to
        // the safety-net throw, giving users a hard error).
        budget.markStuck();
        // Don't throw — instead, fall through to the force-final path so
        // the user gets SOMETHING. The stuck tool's results are already
        // in `contents`, so the model can synthesize a best-effort answer.
        break;
      }
      budget.recordRound(currentSignatures);

      // BUG-I5 fix: notify the route handler that a tool round completed.
      // If the callback returns a string, the route has updated
      // `currentSystemPrompt` in its closure — the getter will return the
      // new value on the next iteration (we re-read config.systemInstruction
      // at the top of the loop). Used to clear the {{knowledge}} block after
      // the first search_knowledge_base call so the LLM doesn't see stale
      // auto-inject context mixed with fresh tool results.
      if (onToolRoundComplete) {
        // round is 0-indexed here (budget.currentRound starts at 0); pass
        // 1-indexed to the callback for human-readability.
        onToolRoundComplete(round + 1, currentSignatures);
      }

      // IMPORTANT: preserve the ORIGINAL parts from the model's response
      // (not reconstructed ones). Gemini 2.5 thinking models emit a
      // `thoughtSignature` on the function-call part that MUST be echoed
      // back unchanged — otherwise the next generateContent call fails
      // with "Function call is missing a thought_signature".
      // result.modelParts contains the full original parts (including
      // thought signatures, thought text, etc.) accumulated from the stream.
      const modelParts: any[] = result.modelParts;

      // v3.7: Execute tools one-by-one, firing onToolEvent before+after each.
      // We fire `tool_call` BEFORE execute() so the UI can show "Looking up..."
      // immediately, and `tool_result` AFTER (with durationMs) so the UI can
      // clear the chip. If execute() throws, we fire a `tool_result` with
      // ok=false + the error message (the route still surfaces this to the
      // client, but the model gets a structured error in the functionResponse).
      const functionResponseParts = await Promise.all(
        functionCalls.map(async (fc: any) => {
          const rawName: string = fc.name;
          const toolArgs = fc.args ?? {};

          // v6.2 Part 12 (Backend Gap Fix #2): narrow the raw tool name from
          // the LLM (untrusted) via isToolName. If the model hallucinates an
          // unknown name, we skip the SSE events (tool_call / tool_progress /
          // tool_result) — executeTool handles unknown names internally and
          // returns a friendly error to the LLM. The SSE pipe only carries
          // events for KNOWN tools, so the frontend's typed `ActiveToolCall.name`
          // field stays safe.
          const knownName = isToolName(rawName) ? rawName : null;

          if (onToolEvent && knownName) {
            onToolEvent({ type: "tool_call", name: knownName, args: toolArgs });
          }
          const t0 = Date.now();
          try {
            // v6.2 Part 9 (Gap 17 fix — Phase B): pass an onProgress callback
            // to tools.execute so long-running tools can emit live progress.
            // The callback fires a `tool_progress` SSE event via onToolEvent.
            // Existing SQL-based tools ignore the callback (they don't call
            // it) — no behavior change for them.
            const result = await tools.execute(rawName, toolArgs, userId ?? null, {
              onProgress:
                onToolEvent && knownName
                  ? (progress: string) => {
                      onToolEvent({ type: "tool_progress", name: knownName, progress });
                    }
                  : undefined,
            });
            if (onToolEvent && knownName) {
              onToolEvent({
                type: "tool_result",
                name: knownName,
                ok: true,
                durationMs: Date.now() - t0,
                result,
              });
            }
            return {
              functionResponse: {
                name: rawName,
                response: { result },
              },
            };
          } catch (err) {
            // String(err) always returns a string, so `?? "tool execution failed"`
            // would be dead code. Use a fallback only for empty strings.
            const rawMsg = (err as any)?.message ?? String(err);
            const errMsg = rawMsg || "tool execution failed";
            if (onToolEvent && knownName) {
              onToolEvent({
                type: "tool_result",
                name: knownName,
                ok: false,
                error: errMsg,
                durationMs: Date.now() - t0,
              });
            }
            // Return the error as the function response so the model can
            // react to it (e.g., tell the user the lookup failed).
            return {
              functionResponse: {
                name: rawName,
                response: { error: errMsg },
              },
            };
          }
        }),
      );

      // Append the model's ORIGINAL parts (with thought signatures) + our
      // function responses to the conversation.
      contents = [
        ...contents,
        {
          role: "model" as const,
          parts: modelParts,
        },
        {
          role: "user" as const,
          parts: functionResponseParts,
        },
      ];

      budget.advance();
    }

    // ─── Graceful degradation: budget exhausted (or stuck loop) ───────────
    //
    // Instead of throwing an error (the old behavior), make ONE more call
    // with tools DISABLED. This forces Gemini to produce a best-effort
    // text answer using whatever information it already gathered from the
    // tool calls. The user gets SOMETHING useful instead of a hard error.
    //
    // Industry references:
    //   - Vercel AI SDK: emits a `tool-call-error` then continues the stream
    //   - OpenAI Assistants: stops the run with `expired` status but keeps
    //     partial output
    //   - Anthropic: stops with `max_tokens` stop reason, keeps partial output
    //
    // We use the same streaming-round helper with forceNoTools=true so the
    // behavior is identical to a normal final round (text deltas stream
    // live, no extra API round-trip).
    if (budget.shouldForceFinal) {
      budget.markForceFinalEmitted();
      logger.warn(
        { rounds: budget.maxRoundsValue, hadStuckLoop: budget.hadStuckLoop },
        "TreeBot: tool budget exhausted — making one force-final call with tools disabled (graceful degradation)",
      );

      const forceGen = runOneStreamingRound(contents, config, true);
      while (true) {
        const { done, value } = await forceGen.next();
        if (done) break;
        if (typeof value === "string") {
          yield value;
        }
      }
      lastModel = _workingModel ?? "unknown";

      if (onMetadata) {
        onMetadata({
          model: lastModel,
          usage: lastUsage,
          toolCalls: toolCallsCalled,
        });
      }
      return;
    }

    // This branch is reached only if the force-final call already happened
    // (shouldForceFinal was false) — meaning we already streamed a final
    // answer above. Emit metadata as a safety net (it should have been
    // emitted inside the force-final block).
    if (onMetadata) {
      onMetadata({
        model: lastModel,
        usage: lastUsage,
        toolCalls: toolCallsCalled,
      });
    }

    // If we somehow get here without having streamed anything, surface a
    // clear error. The route will show the user a friendly fallback.
    logger.error(
      { rounds: budget.maxRoundsValue },
      "TreeBot: tool loop ended without producing a final answer (this should not happen — force-final should have run)",
    );
    throw new Error(buildMaxRoundsErrorMessage(budget.maxRoundsValue));
  } finally {
    // P1 #5 fix: delete the Gemini context cache if one was created + not
    // already abandoned mid-loop. This runs on every exit path: normal
    // completion (return), error (throw), + early termination (consumer
    // broke out of the `for await` loop, which calls `gen.return()`).
    // The cache's `delete()` method is best-effort (catches its own errors)
    // + is a no-op if the cache was already abandoned.
    if (contextCache) {
      await contextCache.delete().catch((err) => {
        logger.debug(
          { err: (err as Error)?.message ?? String(err) },
          "Gemini context cache: delete in finally failed (non-fatal — will expire via TTL)",
        );
      });
    }
  }
}

/**
 * Check at boot whether the key is configured. Used by app.ts to log a
 * one-time startup warning so missing keys don't surprise you on first
 * request.
 */
export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * Returns the model name that's currently working, or null if we haven't
 * tried yet. Useful for health checks / debug logging.
 */
export function getWorkingModel(): string | null {
  return _workingModel;
}

/**
 * v3.0.2: Force a re-discovery of available models. Clears the cache
 * so the next discoverAvailableModels() call actually hits the
 * ListModels API again.
 *
 * Used by the /api/ai/admin/models?refresh=1 endpoint so admins can
 * re-check availability after swapping API keys (without restarting
 * the server).
 *
 * v3.9: if discovery is currently in-flight, we await it first so we
 * don't race with a concurrent cold-start discovery (the in-flight
 * promise would overwrite our cleared cache).
 */
export async function forceRediscover(): Promise<void> {
  // v3.9: if discovery is in-flight, wait for it to finish before clearing.
  // Otherwise our clear would be overwritten when the in-flight promise
  // resolves + sets `_discoveredModels`.
  if (_discoveryPromise) {
    try {
      await _discoveryPromise;
    } catch {
      // ignore — we're about to clear anyway
    }
  }
  _discoveredModels = null;
  _discoveryPromise = null;
  // Also clear the working model cache — if the API key changed, the
  // previously-cached model may no longer be available.
  _workingModel = null;
  // v3.3: Clear cooldowns via Redis-backed function (distributed clear).
  await clearAllCooldowns();
}

/**
 * v3.0.1: Returns debug info about the model selection state. Used by the
 * /api/ai/admin/models endpoint so admins can see:
 *   - which models were discovered as available for their API key
 *   - which model is currently cached as "working"
 *   - which models are on cooldown (recently 429'd) and when they'll retry
 *   - the full static fallback chain
 *
 * v3.3: now async because cooldowns are Redis-backed.
 *
 * v3.9: `discoveryAttempted` is now derived from the actual state —
 * true if discovery completed (`_discoveredModels !== null`) OR is
 * in-flight (`_discoveryPromise !== null`). Previously this was a
 * separate flag that could drift from the actual cache state.
 */
export async function getModelDebugInfo(): Promise<{
  workingModel: string | null;
  discoveredModels: string[] | null;
  discoveryAttempted: boolean;
  discoveryInFlight: boolean;
  staticChain: string[];
  cooldowns: { model: string; retryInMs: number; retryAt: string }[];
  aiModelEnv: string | null;
}> {
  const cooldowns: { model: string; retryInMs: number; retryAt: string }[] = [];
  // v3.3: check Redis for each model's cooldown status
  const modelsToCheck = _discoveredModels ?? MODEL_FALLBACK_CHAIN;
  for (const model of modelsToCheck) {
    const remaining = await getCooldownRemaining("gemini", model);
    if (remaining > 0) {
      cooldowns.push({
        model,
        retryInMs: remaining,
        retryAt: new Date(Date.now() + remaining).toISOString(),
      });
    }
  }
  return {
    workingModel: _workingModel,
    discoveredModels: _discoveredModels,
    // v3.9: derived from actual state, not a separate flag.
    discoveryAttempted: _discoveredModels !== null || _discoveryPromise !== null,
    discoveryInFlight: _discoveryPromise !== null,
    staticChain: MODEL_FALLBACK_CHAIN,
    cooldowns,
    aiModelEnv: process.env.AI_MODEL ?? null,
  };
}
