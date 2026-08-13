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
 *                       specific model name. If unset, we try models in order:
 *
 *                         1. gemini-flash-latest      (Google's alias)
 *                         2. gemini-2.5-flash-lite
 *                         3. gemini-2.5-flash
 *                         4. gemini-2.5-pro
 *                         5. gemini-2.0-flash         (legacy fallback)
 *                         6. gemini-1.5-flash         (very old fallback)
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

// ─── Model fallback chain ───────────────────────────────────────────────────
// Google frequently deprecates Gemini models and rotates which ones are
// available to new GCP projects. As of Aug 2026:
//
//   - gemini-1.5-flash      — DEPRECATED (404 for everyone)
//   - gemini-2.0-flash      — DEPRECATED (404 for everyone)
//   - gemini-2.5-*          — 404 for NEW GCP projects (created after ~Jun 2026)
//   - gemini-3.0-flash      — available, moderate free tier
//   - gemini-3.5-flash      — available, moderate free tier
//   - gemini-3.6-flash      — available, VERY restrictive free tier (20 RPD!)
//   - gemini-flash-latest   — alias, resolves unpredictably (may 404)
//
// v3.0 incidents:
//   1. gemini-flash-latest resolved to gemini-3.6-flash (20 RPD) → 429 storm
//   2. Reordered chain to put 2.5-* first → ALL 404 (new GCP project)
//
// v3.0.1 fix: auto-discover available models at startup via ListModels API.
// This way we never waste time trying models that will 404. We also add
// the 3.x models to the static chain as a fallback if discovery fails.
const MODEL_FALLBACK_CHAIN = [
  // 3.x models — available to new GCP projects (post-Jun 2026)
  "gemini-3.0-flash", // moderate free tier
  "gemini-3.5-flash", // moderate free tier
  "gemini-3.6-flash", // VERY restrictive (20 RPD) but works for new projects
  // 2.x models — available to older GCP projects (pre-Jun 2026)
  "gemini-2.5-flash-lite", // 1500 RPD free tier — best for production
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
let _discoveredModels: string[] | null = null;
let _discoveryAttempted = false;

// ─── v3.0.1: Per-model cooldown for 429 quota exhaustion ────────────────────
// When a model returns 429, we add it to this map with a cooldown timestamp.
// Until the cooldown expires, we skip that model entirely (don't even try it).
// This prevents wasting the 20 RPD quota of gemini-3.6-flash on rapid retries.
//
// Default cooldown: 60 seconds. Configurable via AI_QUOTA_COOLDOWN_MS.
// Rationale: per-MINUTE quotas reset in 60s. Per-DAY quotas won't reset
// during the cooldown, but at least we don't waste requests trying.
const _modelCooldowns = new Map<string, number>(); // model -> cooldown-until-ms
const COOLDOWN_MS = Number(process.env.AI_QUOTA_COOLDOWN_MS ?? 60_000);

function isOnCooldown(modelName: string): boolean {
  const until = _modelCooldowns.get(modelName);
  if (!until) return false;
  if (Date.now() >= until) {
    _modelCooldowns.delete(modelName);
    return false;
  }
  return true;
}

function setCooldown(modelName: string): void {
  _modelCooldowns.set(modelName, Date.now() + COOLDOWN_MS);
}

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

// ─── Lazy-initialized client ─────────────────────────────────────────────────
let _client: GoogleGenAI | null = null;
let _clientInitAttempted = false;

// The model that's currently known to work. Set on first successful call,
// reused for all subsequent calls. Reset to null on 404 to retry the chain.
let _workingModel: string | null = null;

function getClient(): GoogleGenAI {
  if (_clientInitAttempted) {
    if (!_client) {
      throw new Error(
        "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey " +
          "and add it as the GEMINI_API_KEY env var.",
      );
    }
    return _client;
  }
  _clientInitAttempted = true;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.warn(
      "GEMINI_API_KEY env var is not set — AI assistant routes will return 503. " +
        "Get a free key at https://aistudio.google.com/apikey",
    );
    return _client!;
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
 * @internal — exported only for the /api/ai/admin/models debug endpoint.
 */
export async function discoverAvailableModels(): Promise<string[] | null> {
  if (_discoveryAttempted) return _discoveredModels;
  _discoveryAttempted = true;

  const client = getClient();
  if (!client) return null;

  try {
    const available: string[] = [];
    const response = await client.models.list();

    // The SDK returns an async iterable. Iterate it.
    // Each model has: { name: "models/gemini-3.6-flash", supportedGenerationMethods: ["generateContent", ...] }
    for await (const model of response as any) {
      const name: string = model.name ?? ""; // e.g. "models/gemini-3.6-flash"
      const methods: string[] = model.supportedGenerationMethods ?? [];
      // Strip the "models/" prefix to get the bare model name.
      const bareName = name.replace(/^models\//, "");
      // Only include models that support generateContent (excludes embedding
      // models, image generation models, etc.)
      if (bareName && methods.includes("generateContent")) {
        available.push(bareName);
      }
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
  }
}

/**
 * The list of models we'll try, in order. Priority:
 *   1. If AI_MODEL env var is set, use ONLY that (no fallback).
 *   2. If model discovery succeeded, use the discovered list (filtered to
 *      models we know exist for this API key — avoids 404s).
 *   3. Fall back to the static MODEL_FALLBACK_CHAIN.
 *
 * v3.0.1: also filters out models currently on cooldown (recently 429'd).
 */
function getModelChain(): string[] {
  const explicit = process.env.AI_MODEL;
  if (explicit && explicit.trim().length > 0) {
    return [explicit.trim()];
  }

  // Use discovered models if available, otherwise static chain.
  const baseChain = _discoveredModels ?? MODEL_FALLBACK_CHAIN;

  // Filter out models on cooldown (recently 429'd).
  // If ALL models are on cooldown, return the full chain anyway (better
  // to try and get a 429 than to return an empty chain and crash).
  const filtered = baseChain.filter((m) => !isOnCooldown(m));
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
  if (/quota exceeded|rate limit|too many requests|resource_exhausted/i.test(nestedMsg)) return true;

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
async function callWithFallback<T>(fn: (modelName: string) => Promise<T>): Promise<T> {
  // v3.0.1: trigger model discovery on the first call. This populates
  // _discoveredModels so getModelChain() returns only models that actually
  // exist for this API key (avoids wasting time on 404s).
  // If discovery already ran (or fails), this is a fast no-op.
  if (!_discoveryAttempted) {
    await discoverAvailableModels();
  }

  const tryModels: string[] = [];
  if (_workingModel) tryModels.push(_workingModel);
  for (const m of getModelChain()) {
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
        setCooldown(modelName);

        const wasCached = _workingModel === modelName;
        if (wasCached) {
          logger.warn(
            { model: modelName, err: describeErrorForLog(err), cooldownMs: COOLDOWN_MS },
            "TreeBot: cached model quota exhausted (429), clearing cache + on cooldown, trying next in fallback chain",
          );
          _workingModel = null;
        } else {
          logger.warn(
            { model: modelName, err: describeErrorForLog(err), cooldownMs: COOLDOWN_MS },
            "TreeBot: model quota exhausted (429), on cooldown, trying next in fallback chain",
          );
        }
        continue;
      }
      // Non-404, non-429 error (auth, non-transient after retries, etc.) —
      // don't try other models, just rethrow. The route handler will surface it.
      throw err;
    }
  }

  // All models in the chain returned 404 or 429.
  // Build a more helpful error message based on which error type dominated.
  const allQuota = isQuotaExhaustedError(lastErr);
  const errMsg = allQuota
    ? "TreeBot: ALL models in the fallback chain returned 429 quota exhausted. " +
      "Your Gemini free-tier daily quota is depleted across all models. " +
      "Action: wait for the quota to reset (usually at midnight Pacific time), " +
      "or upgrade to a paid tier at https://ai.google.dev/pricing."
    : "TreeBot: ALL models in the fallback chain returned 404. " +
      "Either the API key is invalid OR Google has deprecated every model we know. " +
      "Action: visit https://ai.google.dev/gemini-api/docs/models to find the current model name, " +
      "then set it as the AI_MODEL env var.";

  logger.error({ err: lastErr, triedModels: tryModels, allQuota }, errMsg);
  throw new Error(
    allQuota
      ? "All Gemini models are rate-limited right now. Please try again later."
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
  systemPrompt: string,
  history: { role: "user" | "model"; text: string }[],
  userMessage: string,
  tools?: {
    declarations: FunctionDeclaration[];
    execute: (
      name: string,
      args: Record<string, unknown>,
      userId: string | null,
    ) => Promise<unknown>;
  },
  userId?: string | null,
  onMetadata?: (meta: { model: string; usage?: unknown }) => void,
): AsyncGenerator<string, void, unknown> {
  const client = getClient();
  if (!client) {
    throw new Error(
      "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey " +
        "and add it as the GEMINI_API_KEY env var.",
    );
  }

  // The @google/genai SDK accepts an array of `contents` for history
  // plus the new message.
  let contents: Record<string, unknown>[] = [
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: "user" as const, parts: [{ text: userMessage }] },
  ];

  const config: Record<string, unknown> = {
    systemInstruction: systemPrompt,
    temperature: getTemperature(),
    maxOutputTokens: getMaxOutputTokens(),
  };
  if (tools && tools.declarations.length > 0) {
    config.tools = [{ functionDeclarations: tools.declarations }];
  }

  // ─── Multi-round function-calling loop ─────────────────────────────────
  // Gemini may respond with a functionCall instead of text. We execute
  // the function, append the result to contents, and call generateContent
  // again. Loop until Gemini returns text (no function calls) or we hit
  // the max rounds (prevents infinite loops if Gemini keeps calling tools).
  const MAX_TOOL_ROUNDS = 4;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Use non-streaming generateContent for function-calling rounds.
    // Why: function calls come as a single structured response, not a stream.
    // If we used generateContentStream, we'd have to buffer the whole thing
    // anyway to detect function calls. Non-streaming is simpler + correct.
    //
    // On the FINAL round (when Gemini returns text, not function calls),
    // we switch to streaming for real-time token delivery.
    //
    // callWithFallback wraps the generateContent call so that if the model
    // 404s (deprecated for this API key), it automatically retries with the
    // next model in the fallback chain. The first model that works is cached.
    const response: any = await callWithFallback((modelName) =>
      client.models.generateContent({
        model: modelName,
        contents,
        config,
      }),
    );

    // v3.0: emit metadata (model + usage) to the caller so it can persist
    // observability columns on the assistant message row.
    if (onMetadata) {
      const usedModel = _workingModel ?? "unknown";
      const usage = (response as any)?.usageMetadata ?? undefined;
      onMetadata({ model: usedModel, usage });
    }

    const functionCalls = response.functionCalls;

    if (functionCalls && functionCalls.length > 0 && tools) {
      // ─── Execute each function call ───────────────────────────────────
      logger.info(
        { round, calls: functionCalls.map((fc: any) => fc.name) },
        "TreeBot: executing function calls",
      );

      // IMPORTANT: preserve the ORIGINAL parts from the model's response
      // (not reconstructed ones). Gemini 2.5 thinking models emit a
      // `thoughtSignature` on the function-call part that MUST be echoed
      // back unchanged — otherwise the next generateContent call fails
      // with "Function call is missing a thought_signature".
      // response.candidates[0].content.parts contains the full original
      // parts (including thought signatures, thought text, etc.).
      const modelParts: any[] = response.candidates?.[0]?.content?.parts ?? [];

      const functionResponseParts = await Promise.all(
        functionCalls.map(async (fc: any) => {
          const result = await tools.execute(fc.name, fc.args ?? {}, userId ?? null);
          return {
            functionResponse: {
              name: fc.name,
              response: { result },
            },
          };
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
      // Loop continues — Gemini processes the function responses.
      continue;
    }

    // ─── No function calls — this is the final text response ────────────
    // Re-stream it for real-time delivery. We call generateContentStream
    // with the same contents (which now includes any tool results from
    // previous rounds). Gemini generates the final text answer.
    if (round === 0) {
      // No tool calls were ever needed — we can stream directly from the
      // first response we already have.
      const text = response.text;
      if (text) yield text;

      // v3.0: detect truncation. If the response hit maxOutputTokens,
      // finishReason will be "MAX_TOKENS" and we should log it (the
      // route's auto-continue logic can be added later if needed).
      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason === "MAX_TOKENS") {
        logger.warn(
          { finishReason, maxOutputTokens: getMaxOutputTokens() },
          "TreeBot: response was truncated (hit maxOutputTokens). Consider raising AI_MAX_TOKENS.",
        );
      }
      return;
    }

    // We went through tool rounds — re-stream the final answer.
    // Use callWithFallback here too so the streaming call retries on 404.
    const finalStream: any = await callWithFallback((modelName) =>
      client.models.generateContentStream({
        model: modelName,
        contents,
        config: {
          ...config,
          // Don't expose tools on the final round — we want text, not more calls.
          tools: undefined,
        },
      }),
    );

    for await (const chunk of finalStream) {
      const text = chunk.text;
      if (text) yield text;
    }
    return;
  }

  // If we hit MAX_TOOL_ROUNDS, something is wrong (Gemini keeps calling tools).
  logger.error(
    { rounds: MAX_TOOL_ROUNDS },
    "TreeBot: hit max tool rounds — Gemini kept calling functions without producing a final answer",
  );
  throw new Error("AI assistant took too many tool calls. Please try rephrasing your question.");
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
 * v3.0.1: Returns debug info about the model selection state. Used by the
 * /api/ai/admin/models endpoint so admins can see:
 *   - which models were discovered as available for their API key
 *   - which model is currently cached as "working"
 *   - which models are on cooldown (recently 429'd) and when they'll retry
 *   - the full static fallback chain
 */
export function getModelDebugInfo(): {
  workingModel: string | null;
  discoveredModels: string[] | null;
  discoveryAttempted: boolean;
  staticChain: string[];
  cooldowns: Array<{ model: string; retryInMs: number; retryAt: string }>;
  aiModelEnv: string | null;
} {
  const now = Date.now();
  const cooldowns: Array<{ model: string; retryInMs: number; retryAt: string }> = [];
  for (const [model, until] of _modelCooldowns) {
    const retryInMs = Math.max(0, until - now);
    if (retryInMs > 0) {
      cooldowns.push({
        model,
        retryInMs,
        retryAt: new Date(until).toISOString(),
      });
    }
  }
  return {
    workingModel: _workingModel,
    discoveredModels: _discoveredModels,
    discoveryAttempted: _discoveryAttempted,
    staticChain: MODEL_FALLBACK_CHAIN,
    cooldowns,
    aiModelEnv: process.env.AI_MODEL ?? null,
  };
}
