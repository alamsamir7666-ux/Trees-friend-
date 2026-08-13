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

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Groq structured output error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned empty content");

  const parsed = JSON.parse(content) as StructuredFollowups;
  if (!Array.isArray(parsed.followups)) throw new Error("Invalid followups schema");

  return parsed.followups.slice(0, 5).map((f) => f.trim()).filter(Boolean);
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

  return parsed.followups.slice(0, 5).map((f) => f.trim()).filter(Boolean);
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
        const model = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
        const followups = await generateFollowupsGroq(question, answer, model);
        logger.debug(
          { provider: "groq", count: followups.length },
          "Structured output: generated followups via Groq",
        );
        return followups;
      }
      if (provider === "gemini") {
        // Use the cached working model if available, otherwise let Gemini pick
        const model = process.env.AI_MODEL ?? "gemini-2.5-flash-lite";
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
