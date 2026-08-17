/**
 * LLM-as-judge evaluation for the TreeBot assistant.
 *
 * Industry standard: instead of keyword matching (which can't tell if a
 * response is actually GOOD), use a strong LLM to rate response quality
 * on a 1-5 scale. This is how OpenAI, Anthropic, and LangSmith evaluate
 * their models — it's the gold standard for AI quality assessment.
 *
 * How it works:
 *   1. Send the (question, response) pair to a judge model
 *   2. The judge rates the response on 5 criteria:
 *      - Accuracy (is the plant care advice correct?)
 *      - Completeness (does it answer the full question?)
 *      - Clarity (is it easy to understand?)
 *      - Safety (does it avoid harmful advice?)
 *      - Tone (is it helpful and not condescending?)
 *   3. Each criterion gets a 1-5 score
 *   4. Overall score = average of the 5 criteria
 *   5. The judge also provides a brief explanation of the score
 *
 * Judge model selection:
 *   - Groq llama-3.3-70b-versatile is the best free option (strong reasoning)
 *   - Gemini 2.5-pro would be ideal but may 404 on new GCP projects
 *   - We try providers in order and fall back to keyword matching if all fail
 *
 * Why this is better than keyword matching:
 *   - Catches subtle quality issues (wrong but plausible-sounding advice)
 *   - Handles paraphrasing (response doesn't need exact keywords to score well)
 *   - Provides actionable feedback (the explanation tells you what's wrong)
 *   - Industry standard — comparable to LangSmith / Helicone / Promptfoo evals
 */

import { logger } from "./logger";
import { getProviderChain } from "./aiRouter";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface JudgeScore {
  accuracy: number; // 1-5
  completeness: number; // 1-5
  clarity: number; // 1-5
  safety: number; // 1-5
  tone: number; // 1-5
  overall: number; // average of the above
  explanation: string; // brief feedback from the judge
  judgeModel: string;
  judgeProvider: string;
}

// ─── Judge prompt ────────────────────────────────────────────────────────────

function buildJudgePrompt(question: string, response: string): string {
  return `You are an expert evaluator for a plant-care AI assistant called TreeBot.
Rate the following AI response on 5 criteria, each on a scale of 1-5 (5 = excellent, 1 = terrible).

QUESTION:
${question.slice(0, 1000)}

AI RESPONSE:
${response.slice(0, 2000)}

Rate each criterion:
1. accuracy (1-5): Is the plant care advice factually correct? Are watering/sunlight/soil recommendations appropriate?
2. completeness (1-5): Does it fully answer the question? Are important details missing?
3. clarity (1-5): Is the response easy to understand? Is it well-organized?
4. safety (1-5): Does it avoid harmful or dangerous advice? (e.g., recommending toxic plants for indoor use)
5. tone (1-5): Is it helpful, friendly, and not condescending?

Respond as JSON with this exact schema:
{
  "accuracy": <1-5>,
  "completeness": <1-5>,
  "clarity": <1-5>,
  "safety": <1-5>,
  "tone": <1-5>,
  "explanation": "<2-3 sentence summary of the response quality>"
}`;
}

// ─── Groq judge implementation ───────────────────────────────────────────────

async function judgeWithGroq(
  question: string,
  response: string,
  model: string,
): Promise<JudgeScore> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const prompt = buildJudgePrompt(question, response);

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1, // low — we want consistent ratings
      max_tokens: 300,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "judge_score",
          schema: {
            type: "object",
            properties: {
              accuracy: { type: "integer", minimum: 1, maximum: 5 },
              completeness: { type: "integer", minimum: 1, maximum: 5 },
              clarity: { type: "integer", minimum: 1, maximum: 5 },
              safety: { type: "integer", minimum: 1, maximum: 5 },
              tone: { type: "integer", minimum: 1, maximum: 5 },
              explanation: { type: "string" },
            },
            required: ["accuracy", "completeness", "clarity", "safety", "tone", "explanation"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Groq judge error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq judge returned empty content");

  const parsed = JSON.parse(content) as Omit<
    JudgeScore,
    "overall" | "judgeModel" | "judgeProvider"
  >;
  const overall =
    Math.round(
      ((parsed.accuracy + parsed.completeness + parsed.clarity + parsed.safety + parsed.tone) / 5) *
        10,
    ) / 10;

  return {
    ...parsed,
    overall,
    judgeModel: model,
    judgeProvider: "groq",
  };
}

// ─── Gemini judge implementation ─────────────────────────────────────────────

async function judgeWithGemini(
  question: string,
  response: string,
  model: string,
): Promise<JudgeScore> {
  const { GoogleGenAI, Type } = await import("@google/genai");
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const client = new GoogleGenAI({ apiKey });
  const prompt = buildJudgePrompt(question, response);

  const res = await client.models.generateContent({
    model,
    contents: [{ role: "user" as const, parts: [{ text: prompt }] }],
    config: {
      temperature: 0.1,
      maxOutputTokens: 300,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          accuracy: { type: Type.INTEGER },
          completeness: { type: Type.INTEGER },
          clarity: { type: Type.INTEGER },
          safety: { type: Type.INTEGER },
          tone: { type: Type.INTEGER },
          explanation: { type: Type.STRING },
        },
        required: ["accuracy", "completeness", "clarity", "safety", "tone", "explanation"],
      },
    },
  });

  const text = (res as any)?.text;
  if (!text) throw new Error("Gemini judge returned empty content");

  const parsed = JSON.parse(text) as Omit<JudgeScore, "overall" | "judgeModel" | "judgeProvider">;

  // Clamp scores to 1-5 (Gemini sometimes returns 0 or out-of-range)
  const clamp = (n: number) => Math.max(1, Math.min(5, Math.round(n)));
  const clamped = {
    accuracy: clamp(parsed.accuracy),
    completeness: clamp(parsed.completeness),
    clarity: clamp(parsed.clarity),
    safety: clamp(parsed.safety),
    tone: clamp(parsed.tone),
    explanation: parsed.explanation,
  };
  const overall =
    Math.round(
      ((clamped.accuracy + clamped.completeness + clamped.clarity + clamped.safety + clamped.tone) /
        5) *
        10,
    ) / 10;

  return {
    ...clamped,
    overall,
    judgeModel: model,
    judgeProvider: "gemini",
  };
}

// ─── Main: judgeResponse ────────────────────────────────────────────────────

/**
 * Rates an AI response using LLM-as-judge.
 *
 * Tries providers in order (based on AI_PROVIDERS env var). Falls back
 * to the next provider on failure. If ALL providers fail, returns null
 * — the caller should fall back to keyword matching.
 *
 * @param question - The user's original question
 * @param response - The AI's full text response
 * @returns JudgeScore with 1-5 ratings + explanation, or null on failure
 */
export async function judgeResponse(
  question: string,
  response: string,
): Promise<JudgeScore | null> {
  const providers = getProviderChain();

  if (providers.length === 0) {
    logger.warn("LLM-as-judge: no providers configured");
    return null;
  }

  let lastErr: unknown = null;

  for (const provider of providers) {
    try {
      if (provider === "groq") {
        const model = process.env.GROQ_MODEL ?? "llama-4-scout-17b-16e-instruct"; // v6.2 Part 10: was llama-3.3-70b-versatile (deprecated Aug 16, 2026)
        const score = await judgeWithGroq(question, response, model);
        logger.debug(
          { provider: "groq", model, overall: score.overall },
          "LLM-as-judge: scored via Groq",
        );
        return score;
      }
      if (provider === "gemini") {
        // Use AI_JUDGE_MODEL env var if set, otherwise resolve via the
        // chat path's model discovery chain. The hardcoded
        // `gemini-2.5-flash` returned 404 on new GCP projects (deprecated
        // for new users), breaking LLM-as-judge evaluations entirely.
        let model: string;
        if (process.env.AI_JUDGE_MODEL) {
          model = process.env.AI_JUDGE_MODEL;
        } else {
          const { getModelChain } = await import("./gemini");
          const chain = await getModelChain();
          model = chain[0] ?? "gemini-flash-latest";
        }
        const score = await judgeWithGemini(question, response, model);
        logger.debug(
          { provider: "gemini", model, overall: score.overall },
          "LLM-as-judge: scored via Gemini",
        );
        return score;
      }
    } catch (err) {
      lastErr = err;
      logger.warn(
        { provider, err: (err as any)?.message ?? String(err) },
        `LLM-as-judge: ${provider} failed, trying next provider`,
      );
    }
  }

  logger.error({ err: lastErr }, "LLM-as-judge: all providers failed");
  return null;
}
