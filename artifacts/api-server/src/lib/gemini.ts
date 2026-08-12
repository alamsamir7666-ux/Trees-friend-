/**
 * Thin Google GenAI SDK wrapper for the TreeBot assistant.
 *
 * Why a wrapper (and not call the SDK directly from the route):
 *   - Single point of initialization (client is created once, reused
 *     across requests — `@google/genai` client construction is non-trivial
 *     and shouldn't happen per request).
 *   - Centralized error translation (SDK errors → predictable HTTP-shaped
 *     errors the route can handle).
 *   - Easier to swap models (gemini-2.0-flash → gemini-2.5-flash → ...)
 *     without touching route code.
 *   - Easier to mock in tests.
 *
 * Configuration:
 *   GEMINI_API_KEY  — required, get one free at https://aistudio.google.com/apikey
 *   AI_MODEL         — optional, defaults to "gemini-2.0-flash" (free-tier)
 *
 * Streaming:
 *   `streamChat()` returns an async iterator of text chunks. The route
 *   re-emits these as Server-Sent Events (SSE) to the browser, which
 *   gives the user a real-time "typing" experience — important for chat UX.
 *
 * If GEMINI_API_KEY is not set, all functions throw a friendly 503-style
 * error — the route catches this and returns a clear message rather than
 * a confusing 500. This lets you deploy the code before adding the key.
 */
import { GoogleGenAI } from "@google/genai";
import { logger } from "./logger";

// ─── Lazy-initialized client ─────────────────────────────────────────────────
// Why lazy: in test environments and dev sandboxes without the env var set,
// we don't want to crash at module-load time. The crash should happen only
// when an actual chat request comes in without the key configured.

let _client: GoogleGenAI | null = null;
let _clientInitAttempted = false;

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
    { model: process.env.AI_MODEL ?? "gemini-2.0-flash" },
    "Google GenAI client initialized for TreeBot",
  );
  return _client;
}

// ─── Public helpers ──────────────────────────────────────────────────────────

export const GEMINI_MODEL = process.env.AI_MODEL ?? "gemini-2.0-flash";

/**
 * Streams a chat completion from Gemini. Yields incremental text chunks
 * (deltas) suitable for SSE forwarding to the browser.
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
 * @throws Error — if GEMINI_API_KEY is missing or the SDK returns an error.
 *   The caller (route) is responsible for translating these to HTTP responses.
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

  const responseStream = await client.models.generateContentStream({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: systemPrompt,
      // Low temperature = more deterministic, more factual. Plant-care
      // advice shouldn't be creative — we want consistency and accuracy.
      temperature: 0.4,
      // Hard cap on output length. Prevents runaway responses and keeps
      // token usage predictable (cost + latency).
      maxOutputTokens: 1024,
    },
  });

  for await (const chunk of responseStream) {
    // Each chunk may contain zero or more text parts. Extract only text,
    // ignore tool calls / images (we don't use them).
    const text = chunk.text;
    if (text) {
      yield text;
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
