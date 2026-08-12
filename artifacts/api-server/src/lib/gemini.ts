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
import { GoogleGenAI, type FunctionDeclaration } from "@google/genai";
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
  "gemini-flash-latest", // Google's "latest" alias — usually points to the newest flash model
  "gemini-2.5-flash-lite", // often still available when 2.5-flash is deprecated for new users
  "gemini-2.5-flash",
  "gemini-2.5-pro",
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
 * Calls a Gemini SDK function with automatic model fallback.
 *
 * Tries the cached working model first. If it 404s (model deprecated
 * for this API key / project), tries the next model in the fallback
 * chain. The first model that succeeds is cached and tried first on
 * subsequent calls.
 *
 * This is the ACTUAL fallback implementation — resolveModel() above was
 * a stub that didn't actually probe whether the model works. This helper
 * wraps the real SDK call so a 404 triggers a retry with the next model.
 *
 * @param fn - A function that takes a model name and returns a Promise.
 *   Called with each model in the chain until one succeeds.
 * @returns The result of the first successful call.
 * @throws If ALL models in the chain return 404, or if a non-404 error occurs.
 */
async function callWithFallback<T>(
  fn: (modelName: string) => Promise<T>,
): Promise<T> {
  const tryModels: string[] = [];
  if (_workingModel) tryModels.push(_workingModel);
  for (const m of getModelChain()) {
    if (!tryModels.includes(m)) tryModels.push(m);
  }

  let lastErr: unknown = null;
  for (const modelName of tryModels) {
    try {
      const result = await fn(modelName);
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
      // Non-404 error (auth, rate limit, network, etc.) — don't try other
      // models, just rethrow. The route handler will surface it.
      throw err;
    }
  }

  // All models in the chain returned 404.
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
 * Streams a chat completion from Gemini. Yields incremental text chunks
 * (deltas) suitable for SSE forwarding to the browser.
 *
 * v2.5: supports function calling. If Gemini decides to call a tool
 * (e.g. search_catalog), we execute the tool and send the result back
 * to Gemini in a multi-round loop. The final text response is then
 * streamed to the client.
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
 */
export async function* streamGeminiChat(
  systemPrompt: string,
  history: Array<{ role: "user" | "model"; text: string }>,
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
  let contents: Array<Record<string, unknown>> = [
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: "user" as const, parts: [{ text: userMessage }] },
  ];

  const config: Record<string, unknown> = {
    systemInstruction: systemPrompt,
    temperature: 0.4,
    maxOutputTokens: 1024,
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
