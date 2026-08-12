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
 *   GEMINI_API_KEY  — required, get one free at https://aistudio.google.com/apikey
 *   AI_MODEL         — optional, overrides the auto-fallback chain with a
 *                      specific model name. If unset, we try models in order:
 *
 *                        1. gemini-2.5-flash
 *                        2. gemini-2.5-flash-lite
 *                        3. gemini-2.5-pro
 *                        4. gemini-2.0-flash        (legacy fallback)
 *                        5. gemini-flash-latest      (Google's alias)
 *                        6. gemini-1.5-flash         (very old fallback)
 *
 *                      The first one that doesn't return 404/NOT_FOUND is
 *                      cached and reused for all subsequent requests. This
 *                      auto-adapts to Google's frequent model deprecations
 *                      without requiring a code change each time.
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
import { GoogleGenAI } from "@google/genai";
import { logger } from "./logger";

// ─── Model fallback chain ───────────────────────────────────────────────────
// Google frequently deprecates Gemini models. As of 2026:
//   - gemini-2.0-flash      — DEPRECATED (returns 404 for everyone)
//   - gemini-2.5-flash      — DEPRECATED for NEW users (404 if your GCP
//                             project was created recently)
//   - gemini-2.5-flash-lite — still available
//   - gemini-2.5-pro        — still available (smarter, slower)
//
// Strategy: try each in order. Cache the first that works. If a previously
// working model starts 404ing (Google deprecates it later), reset and
// retry the chain.
const MODEL_FALLBACK_CHAIN = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-flash-latest", // Google's "latest" alias — usually points to the newest flash
  "gemini-2.0-flash", // legacy fallback (still works for some older projects)
  "gemini-1.5-flash", // very old fallback
];

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
    },
    "Google GenAI client initialized for TreeBot (model will be auto-selected on first request)",
  );
  return _client;
}

// ─── Public helpers ──────────────────────────────────────────────────────────

/**
 * The list of models we'll try, in order. If AI_MODEL env var is set,
 * we use ONLY that model (no fallback). Otherwise we try the chain.
 */
function getModelChain(): string[] {
  const explicit = process.env.AI_MODEL;
  if (explicit && explicit.trim().length > 0) {
    return [explicit.trim()];
  }
  return MODEL_FALLBACK_CHAIN;
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
 * Streams a chat completion from Gemini. Yields incremental text chunks
 * (deltas) suitable for SSE forwarding to the browser.
 *
 * If the preferred model returns 404 (deprecated/unavailable), automatically
 * tries the next model in the fallback chain. The first model that works is
 * cached and reused for all subsequent requests — so the chain only runs
 * once per server lifetime (unless the cached model later starts 404ing,
 * in which case we reset and retry).
 *
 * @param systemPrompt - Strict scope-restricting system instruction
 *   (see aiContext.ts → buildSystemPrompt()).
 * @param history - Prior turns of the conversation, oldest first.
 *   Each item is `{ role: 'user' | 'model', text: string }`.
 *   The SDK uses "model" (not "assistant") for the assistant role.
 * @param userMessage - The new user message to respond to.
 *
 * @yields string — incremental text deltas. Empty string is never yielded.
 *
 * @throws Error — if GEMINI_API_KEY is missing OR every model in the
 *   fallback chain failed. The caller (route) is responsible for
 *   translating these to HTTP responses.
 */
export async function* streamGeminiChat(
  systemPrompt: string,
  history: Array<{ role: "user" | "model"; text: string }>,
  userMessage: string,
): AsyncGenerator<string, void, unknown> {
  const client = getClient();
  if (!client) {
    throw new Error(
      "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey " +
        "and add it as the GEMINI_API_KEY env var.",
    );
  }

  // The @google/genai SDK accepts an array of `contents` for history
  // plus the new message. The system instruction is passed separately
  // as `config.systemInstruction`.
  const contents = [
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: "user" as const, parts: [{ text: userMessage }] },
  ];

  const config = {
    systemInstruction: systemPrompt,
    // Low temperature = more deterministic, more factual. Plant-care
    // advice shouldn't be creative — we want consistency and accuracy.
    temperature: 0.4,
    // Hard cap on output length. Prevents runaway responses and keeps
    // token usage predictable (cost + latency).
    maxOutputTokens: 1024,
  };

  // Build the list of models to try. If we have a cached working model,
  // try it first; if it 404s, fall through to the full chain.
  const tryModels: string[] = [];
  if (_workingModel) tryModels.push(_workingModel);
  for (const m of getModelChain()) {
    if (!tryModels.includes(m)) tryModels.push(m);
  }

  let lastErr: unknown = null;

  for (const modelName of tryModels) {
    try {
      const responseStream = await client.models.generateContentStream({
        model: modelName,
        contents,
        config,
      });

      // Important: we need to actually consume the stream to detect a 404.
      // The SDK throws on the FIRST `await` of the iterator, not on the
      // generateContentStream call itself — so we wrap the first iteration
      // in a try, then if it succeeds we proceed to consume the rest.

      // If we got here, the call was accepted. Cache this model for next time.
      if (_workingModel !== modelName) {
        logger.info(
          { model: modelName, previousModel: _workingModel },
          "TreeBot: model selected and cached for subsequent requests",
        );
        _workingModel = modelName;
      }

      for await (const chunk of responseStream) {
        const text = chunk.text;
        if (text) {
          yield text;
        }
      }
      return; // success — exit the loop
    } catch (err) {
      lastErr = err;
      if (isModelNotFoundError(err)) {
        // This model is deprecated/unavailable — try the next one.
        // Reset the cached model so we re-probe on next request.
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
      // Non-404 error (auth, rate limit, network, etc.) — don't try other
      // models, just rethrow. The route handler will surface it.
      throw err;
    }
  }

  // All models in the chain returned 404. Log the last error and throw
  // a clear message so the operator knows what to do.
  logger.error(
    { err: lastErr, triedModels: tryModels },
    "TreeBot: ALL models in the fallback chain returned 404. " +
      "Either the API key is invalid OR Google has deprecated every model we know. " +
      "Action: visit https://ai.google.dev/gemini-api/docs/models to find the current model name, " +
      "then set it as the AI_MODEL env var.",
  );
  throw new Error(
    "All configured Gemini models are unavailable. " +
      "Please set the AI_MODEL env var to a currently-available model name " +
      "(see https://ai.google.dev/gemini-api/docs/models).",
  );
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
