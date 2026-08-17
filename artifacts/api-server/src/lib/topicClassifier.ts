/**
 * Topic classifier (v5.3) — LLM-based topic detection for the TreeBot assistant.
 *
 * Problem:
 *   The original hard topic gate (`hasBotanicalKeyword`) used a keyword list
 *   to decide if a message is plant-related. This is fundamentally broken:
 *     - Can't anticipate every Bengali/Banglish plant word
 *     - "কলার কোন জাত ভালো" (which banana variety is good?) was REFUSED
 *       because কলা (banana) wasn't in the keyword list
 *     - Maintaining a complete list is impossible (thousands of plant names,
 *       care terms, synonyms, dialects)
 *
 * Industry standard:
 *   Modern chatbots (ChatGPT, Claude, Gemini, Vercel AI SDK) do NOT use
 *   hard keyword gates. They rely on:
 *     1. A strong system prompt ("you are a plant-care assistant")
 *     2. The LLM's own judgment to refuse off-topic questions
 *
 * Solution (this module):
 *   A lightweight LLM-based topic classifier that runs ONLY when the keyword
 *   gate fails (to catch Bengali/paraphrased questions). Uses the existing
 *   free-tier Groq/Gemini quotas — $0 cost.
 *
 * Flow:
 *   1. hasBotanicalKeyword() — fast path, instant. Catches obvious English
 *      keywords + common Bengali words. Returns true → allow.
 *   2. If false → classifyTopicWithLLM() — LLM checks if the message is
 *      plant-related. Returns true → allow. Returns false → refuse.
 *   3. If LLM unavailable → fail-OPEN (allow). Better to answer an off-topic
 *      question than to block a legitimate plant question.
 *
 * Why fail-open (not fail-closed)?
 *   The prompt-injection check (v5.2.1) already blocks the real abuse vector
 *   (jailbreaks, secret extraction). An off-topic question that slips through
 *   is harmless — the system prompt will make the LLM refuse politely.
 *   But blocking "কলার কোন জাত ভালো" is a REAL user harm.
 *
 * Config (env vars):
 *   TOPIC_CLASSIFIER_ENABLED  — master switch (default: "true")
 *   TOPIC_CLASSIFIER_CACHE_TTL_SECONDS — cache TTL (default: 86400 = 24h)
 */
import { logger } from "./logger";
import {
  getCachedTopicClassification,
  setCachedTopicClassification,
  getInFlightTopicClassification,
  setInFlightTopicClassification,
} from "./topicClassifierCache";

// ─── Constants ───────────────────────────────────────────────────────────────

const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-4-scout-17b-16e-instruct"; // v6.2 Part 10: was llama-3.1-8b-instant (deprecated Aug 16, 2026)
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// Use the discovered working Gemini model from the chat path. The previous
// hardcoded `gemini-2.5-flash` returns 404 on new GCP projects (deprecated
// for new users). Resolved lazily so the first request triggers discovery.
const MAX_MESSAGE_CHARS = 1000;
const CLASSIFIER_TEMPERATURE = 0.1;
const CLASSIFIER_MAX_TOKENS = 50;

// Same set as structuredOutput.ts / outputSafety.ts — keep in sync.
const GROQ_MODELS_WITH_JSON_SCHEMA = new Set([
  "llama-4-scout-17b-16e-instruct",
  "llama-4-maverick-17b-128e-instruct",
  "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "llama3-70b-8192",
  "llama3-8b-8192",
]);

function supportsGroqJsonSchema(model: string): boolean {
  return GROQ_MODELS_WITH_JSON_SCHEMA.has(model.split("@")[0]);
}

const TOPIC_CLASSIFIER_ENABLED =
  (process.env.TOPIC_CLASSIFIER_ENABLED ?? "true").toLowerCase() !== "false";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TopicCheckResult {
  /** True if the message is plant/gardening-related (allow). */
  isOnTopic: boolean;
  /** Confidence (0-1). */
  confidence: number;
  /** Which provider produced this result. */
  provider: string;
  /** Latency in ms. */
  latencyMs: number;
  /** Explanation (for logging). */
  explanation?: string;
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

function buildTopicPrompt(message: string): string {
  return `You are a topic classifier for a plant-care chatbot called TreeBot (a Bangladesh plant marketplace).

Determine if the user's message is related to PLANTS, GARDENING, or AGRICULTURE.

ON-TOPIC examples (isOnTopic: true):
- "How often should I water my mango tree?"
- "কলার কোন জাত ভালো" (which banana variety is good)
- "আম গাছের পরিচর্যা" (mango tree care)
- "Best indoor plants for Bangladesh"
- "গাছ লাগানোর সঠিক সময়" (right time to plant)
- "What fertilizer for tomatoes?"
- "মাটির উর্বরতা বাড়ানোর উপায়" (how to improve soil fertility)
- "My plant leaves are turning yellow"
- "পাতায় পোকা ধরেছে" (bugs on leaves)

OFF-TOPIC examples (isOnTopic: false):
- "What is the capital of France?"
- "Tell me a joke"
- "What's the weather today?"
- "Write me a poem about love"
- "How to hack a computer?"
- "ফ্রান্সের রাজধানী কি" (capital of France)

Respond as JSON:
{"isOnTopic": boolean, "confidence": 0.0-1.0}

User message to classify:
"""
${message.slice(0, MAX_MESSAGE_CHARS)}
"""`;
}

// ─── Groq classifier ────────────────────────────────────────────────────────

// Topic classification schema (used by both json_schema and runtime validator).
const TOPIC_SCHEMA = {
  type: "object",
  properties: {
    isOnTopic: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["isOnTopic", "confidence"],
  additionalProperties: false,
};

function validateTopicResult(parsed: unknown): { isOnTopic: boolean; confidence: number } | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.isOnTopic !== "boolean") return null;
  if (typeof obj.confidence !== "number") return null;
  return { isOnTopic: obj.isOnTopic, confidence: obj.confidence };
}

async function classifyTopicWithGroq(message: string): Promise<TopicCheckResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const startTime = Date.now();
  const prompt = buildTopicPrompt(message);

  // ─── Path 1: json_schema (only on models known to support it) ───
  // Falls through to json_object on 400 "doesn't support json_schema".
  if (supportsGroqJsonSchema(GROQ_MODEL)) {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: CLASSIFIER_TEMPERATURE,
        max_tokens: CLASSIFIER_MAX_TOKENS,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "topic_classification",
            schema: TOPIC_SCHEMA,
            strict: true,
          },
        },
      }),
      signal: AbortSignal.timeout(4000),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        choices: { message: { content: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        const validated = validateTopicResult(JSON.parse(content));
        if (validated) {
          return {
            isOnTopic: validated.isOnTopic,
            confidence: validated.confidence,
            provider: "groq",
            latencyMs: Date.now() - startTime,
            explanation: `Groq: ${validated.isOnTopic ? "on-topic" : "off-topic"} (${validated.confidence})`,
          };
        }
      }
    } else {
      const errBody = await response.text().catch(() => "");
      if (!/does not support response format/i.test(errBody)) {
        throw new Error(
          `Groq topic classifier failed: ${response.status} — ${errBody.slice(0, 200)}`,
        );
      }
      // Fall through to json_object mode.
    }
  }

  // ─── Path 2: json_object + runtime validation (universal) ───
  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: CLASSIFIER_TEMPERATURE,
      max_tokens: CLASSIFIER_MAX_TOKENS,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(4000),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`Groq topic classifier failed: ${response.status} — ${errBody.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq topic classifier: empty response");

  const validated = validateTopicResult(JSON.parse(content));
  if (!validated) throw new Error("Groq json_object topic classifier: invalid schema");

  return {
    isOnTopic: validated.isOnTopic,
    confidence: validated.confidence,
    provider: "groq",
    latencyMs: Date.now() - startTime,
    explanation: `Groq: ${validated.isOnTopic ? "on-topic" : "off-topic"} (${validated.confidence})`,
  };
}

// ─── Gemini classifier (fallback) ───────────────────────────────────────────

async function classifyTopicWithGemini(message: string): Promise<TopicCheckResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const startTime = Date.now();
  const prompt = buildTopicPrompt(message);

  // Resolve the Gemini model via the chat path's discovery chain. Avoids
  // the previous hardcoded `gemini-2.5-flash` which 404s on new GCP projects.
  const { getModelChain } = await import("./gemini");
  const chain = await getModelChain();
  const geminiModel = chain[0] ?? "gemini-flash-latest";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: CLASSIFIER_TEMPERATURE,
          maxOutputTokens: CLASSIFIER_MAX_TOKENS,
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(4000),
    },
  );

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(
      `Gemini topic classifier failed: ${response.status} — ${errBody.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as {
    candidates: { content: { parts: { text: string }[] } }[];
  };

  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error("Gemini topic classifier: empty response");

  const validated = validateTopicResult(JSON.parse(content));
  if (!validated) throw new Error("Gemini topic classifier: invalid schema");

  return {
    isOnTopic: validated.isOnTopic,
    confidence: validated.confidence,
    provider: "gemini",
    latencyMs: Date.now() - startTime,
    explanation: `Gemini: ${validated.isOnTopic ? "on-topic" : "off-topic"} (${validated.confidence})`,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Classifies whether a message is on-topic (plant/gardening-related).
 *
 * Called by routes/ai.ts when the keyword gate (`hasBotanicalKeyword`)
 * returns false — i.e. for messages that don't contain obvious English
 * keywords. This catches Bengali/Banglish/paraphrased questions that
 * the keyword list misses.
 *
 * Provider chain: Groq (fastest) → Gemini (fallback).
 * If both fail, fails-OPEN (returns isOnTopic: true) — better to answer
 * an off-topic question than to block a legitimate plant question.
 *
 * @param message - The user's message (PII-redacted)
 * @returns TopicCheckResult with isOnTopic + confidence + provider
 */
export async function classifyTopic(message: string): Promise<TopicCheckResult> {
  const startTime = Date.now();

  if (!TOPIC_CLASSIFIER_ENABLED) {
    return {
      isOnTopic: true, // fail-open when disabled
      confidence: 1,
      provider: "disabled",
      latencyMs: Date.now() - startTime,
    };
  }

  if (!message || !message.trim()) {
    return {
      isOnTopic: true, // empty message — let the LLM handle it
      confidence: 1,
      provider: "skip",
      latencyMs: Date.now() - startTime,
    };
  }

  // ─── Cache lookup (L1 LRU + L2 Redis) ──────────────────────────────────
  // Topic classification is deterministic (temperature=0.1) — same message
  // = same result. Caching means 100 identical questions cost 1 LLM call.
  const cached = await getCachedTopicClassification(message);
  if (cached) {
    logger.debug(
      { provider: cached.provider, isOnTopic: cached.isOnTopic, cacheHit: true },
      "Topic classifier: cache HIT",
    );
    return {
      ...cached,
      provider: `${cached.provider}-cached`,
      latencyMs: Date.now() - startTime,
    };
  }

  // ─── Single-flight: if the same message is already being classified,
  // await that promise instead of making a duplicate LLM call. ─────────────
  // Critical for traffic spikes — 5 concurrent identical messages = 1 LLM call.
  const inFlight = getInFlightTopicClassification(message);
  if (inFlight) {
    try {
      const result = await inFlight;
      if (result) {
        logger.debug(
          { provider: result.provider, isOnTopic: result.isOnTopic },
          "Topic classifier: single-flight coalesced",
        );
        return {
          ...result,
          provider: `${result.provider}-singleflight`,
          latencyMs: Date.now() - startTime,
        };
      }
    } catch {
      // fall through to classify ourselves
    }
  }

  // ─── Call the LLM classifier (with caching) ─────────────────────────────
  const classifyPromise = (async (): Promise<TopicCheckResult> => {
    try {
      const result = await classifyTopicWithLLM(message);
      // Cache the successful result (24h TTL).
      await setCachedTopicClassification(message, result, false);
      return result;
    } catch (err) {
      // Cache the failure (60s TTL) so we don't hammer the LLM on repeats.
      const failResult: TopicCheckResult = {
        isOnTopic: true, // fail-open on LLM error
        confidence: 0,
        provider: "fail-open",
        latencyMs: 0,
        explanation: `LLM failed: ${(err as Error).message.slice(0, 100)}`,
      };
      await setCachedTopicClassification(message, failResult, true);
      throw err;
    }
  })();

  // Register the in-flight promise so concurrent requests can await it.
  setInFlightTopicClassification(message, classifyPromise);

  try {
    const result = await classifyPromise;
    logger.info(
      {
        provider: result.provider,
        isOnTopic: result.isOnTopic,
        confidence: result.confidence,
        latencyMs: result.latencyMs,
        messagePreview: message.slice(0, 80),
      },
      result.isOnTopic
        ? "Topic classifier: ALLOWED (on-topic)"
        : "Topic classifier: REFUSED (off-topic)",
    );
    return {
      ...result,
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    // Both providers failed — fail-open (allow the message)
    logger.warn(
      { err: (err as Error).message.slice(0, 100) },
      "Topic classifier: all providers failed, failing open (allowing message)",
    );
    return {
      isOnTopic: true,
      confidence: 0,
      provider: "fail-open",
      latencyMs: Date.now() - startTime,
      explanation: "Topic classifier failed — message allowed (fail-open)",
    };
  }
}

/**
 * Internal: calls the LLM classifier (Groq first, Gemini fallback).
 * Throws if both providers fail. The caller handles caching + fail-open.
 */
async function classifyTopicWithLLM(message: string): Promise<TopicCheckResult> {
  // ─── Try Groq first (fastest, most free quota) ──────────────────────────
  if (process.env.GROQ_API_KEY) {
    try {
      const result = await classifyTopicWithGroq(message);
      logger.debug(
        {
          provider: "groq",
          isOnTopic: result.isOnTopic,
          confidence: result.confidence,
          latencyMs: result.latencyMs,
        },
        "Topic classifier: classified via Groq",
      );
      return result;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message.slice(0, 100) },
        "Topic classifier: Groq failed, trying Gemini",
      );
    }
  }

  // ─── Fall back to Gemini ────────────────────────────────────────────────
  if (process.env.GEMINI_API_KEY) {
    const result = await classifyTopicWithGemini(message);
    logger.debug(
      {
        provider: "gemini",
        isOnTopic: result.isOnTopic,
        confidence: result.confidence,
        latencyMs: result.latencyMs,
      },
      "Topic classifier: classified via Gemini",
    );
    return result;
  }

  // ─── No LLM configured ──────────────────────────────────────────────────
  throw new Error(
    "No LLM configured for topic classification (need GROQ_API_KEY or GEMINI_API_KEY)",
  );
}

/**
 * Returns true if at least one LLM provider is available for topic classification.
 */
export function isTopicClassifierConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY) || Boolean(process.env.GEMINI_API_KEY);
}
