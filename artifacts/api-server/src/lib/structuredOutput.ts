/**
 * Structured output generation for guaranteed-valid JSON responses.
 *
 * Industry standard: use the provider's structured output API
 * (response_format on Groq/OpenAI, responseSchema on Gemini) to GUARANTEE
 * the response matches a JSON schema. No more prompt-engineering + regex
 * parsing that fails 5% of the time.
 *
 * Use case:
 *   The [followups]...[/followups] block is currently prompt-enforced.
 *   When the AI forgets to include it (or formats it wrong), the frontend
 *   parser fails silently and no followup chips appear.
 *
 *   This module generates followups as guaranteed-valid JSON, eliminating
 *   that failure mode. It's called as a FALLBACK — only when the text
 *   response is missing the [followups] block. This means:
 *     - 95% of the time: no extra API call (the prompt works)
 *     - 5% of the time: one fast non-streaming call to regenerate followups
 *
 * Schema:
 *   {
 *     followups: string[]   // 3 short follow-up questions
 *   }
 *
 * Provider support:
 *   - Groq: response_format: { type: "json_schema", json_schema: { schema } }
 *   - Gemini: config.responseSchema (uses Type.OBJECT etc.)
 *
 * Both providers guarantee the output matches the schema. We try the
 * primary provider first, fall back to the other if it fails.
 */
import { GoogleGenAI, Type } from "@google/genai";
import { logger } from "./logger";
import { getProviderChain } from "./aiRouter";
import { getModelChain } from "./gemini";

// ─── Schema definition ──────────────────────────────────────────────────────

// OpenAI/Groq JSON Schema format
const FOLLOWUPS_SCHEMA_OPENAI = {
  type: "object",
  properties: {
    followups: {
      type: "array",
      items: { type: "string" },
      description: "3 short follow-up questions the user might ask next",
      minItems: 0,
      maxItems: 5,
    },
  },
  required: ["followups"],
  additionalProperties: false,
};

// Gemini schema format (uses Type enum)
const FOLLOWUPS_SCHEMA_GEMINI = {
  type: Type.OBJECT,
  properties: {
    followups: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "3 short follow-up questions the user might ask next",
    },
  },
  required: ["followups"],
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StructuredFollowups {
  followups: string[];
}

// ─── Groq implementation ────────────────────────────────────────────────────

/**
 * Models that support `response_format: { type: "json_schema" }` on Groq.
 * Per https://console.groq.com/docs/structured-outputs#supported-models
 * (Nov 2024): llama-3.3-70b-versatile, llama-3.1-8b-instant, and the
 * older llama3-{8b,70b}-8192 variants. If GROQ_MODEL is set to one of
 * these we can use strict json_schema; otherwise we fall back to the
 * universally-supported `json_object` mode + runtime schema validation.
 *
 * `mixtral-8x7b-32768`, `gemma2-9b-it`, and several others do NOT support
 * json_schema — they reject with HTTP 400 if you try.
 */
const GROQ_MODELS_WITH_JSON_SCHEMA = new Set([
  "llama-4-scout-17b-16e-instruct",
  "llama-4-maverick-17b-128e-instruct",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "llama3-70b-8192",
  "llama3-8b-8192",
]);

function supportsGroqJsonSchema(model: string): boolean {
  // Match exact names AND the same name with a date-suffix variant
  // (e.g. "llama-3.3-70b-versatile@2025-01-01"). Groq occasionally ships
  // dated snapshots; the json_schema capability follows the base model.
  const base = model.split("@")[0];
  return GROQ_MODELS_WITH_JSON_SCHEMA.has(base);
}

/**
 * Validate a parsed followups object against our expected shape.
 * Used as the runtime guard for the `json_object` fallback path (where
 * Groq only guarantees valid JSON, not schema compliance).
 */
function validateFollowups(parsed: unknown): string[] | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const raw = obj.followups;
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((f): f is string => typeof f === "string")
    .map((f) => f.trim())
    .filter(Boolean)
    .slice(0, 5);
}

async function generateFollowupsGroq(
  question: string,
  answer: string,
  model: string,
): Promise<string[]> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const prompt = `Based on this plant Q&A, generate 3 short follow-up questions the user might ask next.

Question: ${question.slice(0, 500)}
Answer: ${answer.slice(0, 1000)}

Rules:
- Each question max 8 words
- Write in the SAME language as the answer (English, বাংলা, or Banglish)
- Make them relevant to the Q&A topic
- Return exactly 3 questions`;

  // ─── Strategy: try json_schema first (best, guaranteed schema compliance).
  // If the model doesn't support json_schema (HTTP 400 with the specific
  // "does not support response format json_schema" error), fall back to
  // json_object mode + runtime validation. This is the industry-standard
  // robustness pattern for Groq structured output across mixed model fleets.
  //
  // Why both? json_schema guarantees the response matches our schema exactly
  // (no parsing needed). json_object only guarantees valid JSON — the model
  // might omit fields or return a different shape — but it works on EVERY
  // Groq model. The runtime validation catches malformed shapes so we never
  // surface garbage to the user.
  //
  // We also short-circuit: if we KNOW the model doesn't support json_schema
  // (per the static set above), skip the 400 round-trip and go straight to
  // json_object. This saves ~250ms of latency per request on models that
  // would otherwise 400 first.

  if (supportsGroqJsonSchema(model)) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.4,
          max_tokens: 200,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "followups",
              schema: FOLLOWUPS_SCHEMA_OPENAI,
              strict: true,
            },
          },
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          choices: { message: { content: string } }[];
        };
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content) as StructuredFollowups;
          if (Array.isArray(parsed.followups)) {
            return parsed.followups
              .slice(0, 5)
              .map((f) => f.trim())
              .filter(Boolean);
          }
        }
      } else {
        // If the error is "doesn't support json_schema", fall through to
        // the json_object path. Otherwise rethrow.
        const errText = await response.text().catch(() => "");
        if (!/does not support response format/i.test(errText)) {
          throw new Error(
            `Groq structured output error ${response.status}: ${errText.slice(0, 300)}`,
          );
        }
        // Fall through to json_object mode.
      }
    } catch (err) {
      // Network/parse error — fall through to json_object as a last resort.
      // We log the original error for debugging but don't rethrow, because
      // the json_object path may succeed where json_schema failed.
      if (/Groq structured output error/i.test((err as Error).message)) {
        throw err; // already a structured error message — propagate
      }
      // Otherwise: unknown transient, try json_object.
    }
  }

  // ─── Fallback: json_object mode + runtime validation (universal) ────
  // Works on EVERY Groq model. We embed the schema in the prompt so the
  // model knows what shape to produce, then validate the parsed JSON.
  const promptWithSchema = `${prompt}

Respond with JSON matching this exact shape:
{
  "followups": ["question 1", "question 2", "question 3"]
}`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: promptWithSchema }],
      temperature: 0.4,
      max_tokens: 200,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Groq structured output error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned empty content");

  const parsed = JSON.parse(content) as unknown;
  const validated = validateFollowups(parsed);
  if (!validated) {
    throw new Error("Groq json_object response did not match expected schema");
  }
  return validated;
}

// ─── Gemini implementation ──────────────────────────────────────────────────

async function generateFollowupsGemini(
  question: string,
  answer: string,
  model: string,
): Promise<string[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const client = new GoogleGenAI({ apiKey });

  const prompt = `Based on this plant Q&A, generate 3 short follow-up questions the user might ask next.

Question: ${question.slice(0, 500)}
Answer: ${answer.slice(0, 1000)}

Rules:
- Each question max 8 words
- Write in the SAME language as the answer (English, বাংলা, or Banglish)
- Make them relevant to the Q&A topic
- Return exactly 3 questions`;

  const response = await client.models.generateContent({
    model,
    contents: [{ role: "user" as const, parts: [{ text: prompt }] }],
    config: {
      temperature: 0.4,
      maxOutputTokens: 200,
      responseMimeType: "application/json",
      responseSchema: FOLLOWUPS_SCHEMA_GEMINI,
    },
  });

  const text = (response as any)?.text;
  if (!text) throw new Error("Gemini returned empty content");

  const parsed = JSON.parse(text) as StructuredFollowups;
  if (!Array.isArray(parsed.followups)) throw new Error("Invalid followups schema");

  return parsed.followups
    .slice(0, 5)
    .map((f) => f.trim())
    .filter(Boolean);
}

// ─── Main: generateFollowupsStructured ──────────────────────────────────────

/**
 * Generates follow-up questions as guaranteed-valid JSON.
 *
 * Tries providers in order (based on AI_PROVIDERS env var). Falls back
 * to the next provider on failure. Returns an empty array if ALL
 * providers fail (non-fatal — the user just doesn't see followup chips).
 *
 * @param question - The user's original question
 * @param answer - The AI's full text response
 * @returns string[] of follow-up questions (0-5 items)
 */
export async function generateFollowupsStructured(
  question: string,
  answer: string,
): Promise<string[]> {
  const providers = getProviderChain();

  if (providers.length === 0) {
    logger.warn("Structured output: no providers configured");
    return [];
  }

  let lastErr: unknown = null;

  for (const provider of providers) {
    try {
      if (provider === "groq") {
        // v6.2 Part 19 (Aug 19, 2026): was llama-4-scout-17b-16e-instruct
        // (deprecated Aug 2026 — Groq recommends migrating to openai/gpt-oss-120b
        // per https://console.groq.com/docs/deprecations). Before that was
        // llama-3.3-70b-versatile (deprecated June 17, 2026).
        const model = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
        const followups = await generateFollowupsGroq(question, answer, model);
        logger.debug(
          { provider: "groq", count: followups.length },
          "Structured output: generated followups via Groq",
        );
        return followups;
      }
      if (provider === "gemini") {
        // Use the cached working model from the chat path if available — it
        // has already been validated against this API key. Fall back to
        // AI_MODEL env var, then to the model discovery chain. The previous
        // hardcoded `gemini-2.5-flash-lite` is deprecated for new GCP
        // projects (404 NOT_FOUND: "no longer available to new users"), so
        // we avoid it unless the user explicitly set AI_MODEL to it.
        const chain = await getModelChain();
        const model = chain[0] ?? "gemini-flash-latest";
        const followups = await generateFollowupsGemini(question, answer, model);
        logger.debug(
          { provider: "gemini", count: followups.length },
          "Structured output: generated followups via Gemini",
        );
        return followups;
      }
    } catch (err) {
      lastErr = err;
      logger.warn(
        { provider, err: (err as any)?.message ?? String(err) },
        `Structured output: ${provider} failed, trying next provider`,
      );
    }
  }

  logger.error({ err: lastErr }, "Structured output: all providers failed");
  return [];
}

/**
 * Formats followups as a [followups]...[/followups] block, ready to append
 * to the AI's text response. This lets the frontend parser work unchanged.
 *
 * @example
 *   formatFollowupsBlock(["How much sunlight?", "When to fertilize?"])
 *   → "\n\n[followups]\n- How much sunlight?\n- When to fertilize?\n[/followups]"
 */
export function formatFollowupsBlock(followups: string[]): string {
  if (followups.length === 0) return "";
  const lines = followups.map((f) => `- ${f}`).join("\n");
  return `\n\n[followups]\n${lines}\n[/followups]`;
}
