/**
 * KB AI-assisted chunking (Phase 2).
 *
 * Splits raw text (YouTube transcripts, blog posts, manual content) into
 * topical sections suitable for embedding + semantic search. Each section
 * becomes a "chunk" with a title, content, and keywords — the admin
 * reviews these in the KbChunkReviewModal before they're saved as entries.
 *
 * ─── English only ───────────────────────────────────────────────────────────
 *
 * This function is ONLY called when `sourceLanguage === "en"`. Gemini's
 * Bengali/Banglish chunking is unreliable — it splits mid-sentence,
 * creates bad titles, and sometimes returns English chunks for Bengali
 * input. For Bengali/Banglish sources, the admin uses manual chunking
 * (the KbEntryEditorModal — one entry at a time, typed by hand).
 *
 * The route checks the language before calling this function. If the
 * admin tries to AI-chunk a Bengali source, the route returns:
 *   "AI chunking is only available for English content. Use manual chunking."
 *
 * ─── Prompt design ──────────────────────────────────────────────────────────
 *
 * The prompt asks Gemini to:
 *   1. Split the text at natural topic boundaries (200-500 words per chunk).
 *   2. Not split mid-sentence.
 *   3. Provide a short title (max 60 chars).
 *   4. Provide 3-7 lowercase keywords.
 *   5. Return a JSON array (we use `responseMimeType: "application/json"`
 *      to guarantee valid JSON).
 *   6. Return an empty array if the text isn't about plants/gardening.
 *   7. Preserve the original wording (don't paraphrase).
 *
 * Temperature is 0.3 (low) for structured output — high temperature
 * would produce inconsistent chunk boundaries across runs.
 *
 * ─── Text length handling ──────────────────────────────────────────────────
 *
 * Texts up to 30,000 chars are chunked in a single Gemini call. Longer
 * texts are split into 30K-char segments (at paragraph boundaries when
 * possible), each chunked separately, and the results merged. This
 * avoids the 8K-output-token limit (each segment produces ~7-10 chunks).
 *
 * ─── Error handling ─────────────────────────────────────────────────────────
 *
 * Returns `{ error: string }` on:
 *   - Gemini not configured (no GEMINI_API_KEY)
 *   - Rate limit (429) — the admin should wait + retry
 *   - Malformed JSON response — the admin should use manual chunking
 *   - Empty response — Gemini refused (e.g. non-plant content)
 *
 * The route translates these into HTTP 422 (Unprocessable Entity) with
 * the error message — the admin UI shows it + offers "Use Manual Chunking".
 */
import { getClient, callWithFallback, isGeminiConfigured } from "./gemini";
import { logger } from "./logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChunkSuggestion {
  title: string;
  content: string;
  keywords: string[];
}

export type ChunkResult =
  | { chunks: ChunkSuggestion[]; model: string }
  | { error: string };

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_TEXT_PER_CALL = 30_000; // chars — leaves room for the prompt + output
const MAX_OUTPUT_TOKENS = 8192; // enough for ~10 chunks per call
const CHUNKING_TEMPERATURE = 0.3; // low — structured output rewards determinism

// ─── Prompt builder ──────────────────────────────────────────────────────────

function buildChunkingPrompt(rawText: string): string {
  return `You are a content chunking assistant for a plant care knowledge base.

Split the following text into topical sections. Each section should be a
self-contained piece of knowledge (200-500 words ideal). Do NOT split
mid-sentence — find natural topic boundaries.

For each section, provide:
- title: a short descriptive title (max 60 characters)
- content: the section text (preserve the original wording as much as possible)
- keywords: an array of 3-7 relevant keywords (lowercase, single words or short phrases)

Return ONLY a JSON array, no other text. Example format:
[
  {
    "title": "Watering mango trees in summer",
    "content": "During summer months, mango trees need deep watering...",
    "keywords": ["mango", "watering", "summer", "drought"]
  }
]

Rules:
- If the text is too short to split, return a single chunk with all the text.
- If the text is not about plants, gardening, or botany, return an empty array [].
- Preserve the original language (do not translate).
- Do not add information that isn't in the source text.

Text to chunk:
---
${rawText}
---`;
}

// ─── Response parsing ────────────────────────────────────────────────────────

/**
 * Parses + validates Gemini's response into ChunkSuggestion[].
 *
 * Gemini with `responseMimeType: "application/json"` returns valid JSON,
 * but the shape isn't guaranteed — we validate each chunk defensively.
 * Malformed chunks are skipped (not fatal — we return the good ones).
 *
 * Returns null if the response is empty, not a JSON array, or all chunks
 * are malformed.
 */
function parseChunkResponse(text: string): ChunkSuggestion[] | null {
  if (!text || !text.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger.warn({ textPreview: text.slice(0, 200) }, "KB chunking: JSON.parse failed");
    return null;
  }

  if (!Array.isArray(parsed)) {
    logger.warn({ type: typeof parsed }, "KB chunking: response is not an array");
    return null;
  }

  const chunks: ChunkSuggestion[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i] as Record<string, unknown>;
    if (!item || typeof item !== "object") continue;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const content = typeof item.content === "string" ? item.content.trim() : "";
    const keywords = Array.isArray(item.keywords)
      ? item.keywords.filter((k): k is string => typeof k === "string").map((k) => k.trim()).filter(Boolean)
      : [];
    if (!title || !content) continue;
    chunks.push({ title, content, keywords });
  }

  if (chunks.length === 0 && parsed.length > 0) {
    logger.warn({ arrayLen: parsed.length }, "KB chunking: all chunks were malformed");
    return null;
  }
  return chunks;
}

// ─── Single-call chunking ────────────────────────────────────────────────────

/**
 * Chunks a single text segment (≤ 30K chars) via one Gemini call.
 * Returns `{ chunks, model }` on success, `{ error }` on failure.
 *
 * Exposed as an internal helper so the multi-segment orchestrator can
 * call it per segment.
 */
async function chunkSegment(rawText: string): Promise<ChunkResult> {
  if (!isGeminiConfigured()) {
    return { error: "Gemini API key not set. Use manual chunking." };
  }
  if (!rawText || !rawText.trim()) {
    return { error: "Empty text — nothing to chunk." };
  }

  let client;
  try {
    client = getClient();
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Gemini client unavailable." };
  }

  try {
    const response: unknown = await callWithFallback((modelName) =>
      client.models.generateContent({
        model: modelName,
        contents: [{ role: "user" as const, parts: [{ text: buildChunkingPrompt(rawText) }] }],
        config: {
          responseMimeType: "application/json",
          temperature: CHUNKING_TEMPERATURE,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      }),
    );

    const text = (response as { text?: string })?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      logger.warn("KB chunking: Gemini returned empty text");
      return { error: "AI returned empty response. Try manual chunking." };
    }

    const chunks = parseChunkResponse(text);
    if (chunks === null) {
      return { error: "AI returned malformed response. Try manual chunking." };
    }

    // Determine the model that was actually used (callWithFallback caches
    // the working model internally — we read it via getWorkingModel).
    const { getWorkingModel } = await import("./gemini");
    const model = getWorkingModel() ?? "unknown";

    logger.info({ chunkCount: chunks.length, model, textLen: rawText.length }, "KB chunking: success");
    return { chunks, model };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Detect rate limit + provide a friendlier message.
    if (msg.includes("429") || msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("rate limit")) {
      logger.warn({ err: msg }, "KB chunking: Gemini rate limit hit");
      return { error: "Gemini rate limit hit. Try again in a minute." };
    }
    logger.error({ err: msg, textLen: rawText.length }, "KB chunking: Gemini call failed");
    return { error: "AI chunking failed. Try manual chunking." };
  }
}

// ─── Multi-segment orchestrator ─────────────────────────────────────────────

/**
 * Splits a long text into ≤30K-char segments at paragraph boundaries
 * (prefers `\n\n`, falls back to `\n`, then to hard char-count cuts).
 * Returns the segments in order.
 */
function splitIntoSegments(rawText: string, maxLen = MAX_TEXT_PER_CALL): string[] {
  if (rawText.length <= maxLen) return [rawText];

  const segments: string[] = [];
  let remaining = rawText;
  while (remaining.length > maxLen) {
    // Try to find a paragraph break within the last 25% of the segment.
    const searchStart = Math.floor(maxLen * 0.75);
    const slice = remaining.slice(0, maxLen);
    let cutIdx = slice.lastIndexOf("\n\n", searchStart);
    if (cutIdx === -1 || cutIdx < searchStart * 0.5) {
      cutIdx = slice.lastIndexOf("\n", searchStart);
    }
    if (cutIdx === -1 || cutIdx < searchStart * 0.5) {
      cutIdx = maxLen; // hard cut — no good break found
    }
    segments.push(remaining.slice(0, cutIdx));
    remaining = remaining.slice(cutIdx).replace(/^\s+/, "");
  }
  if (remaining.length > 0) segments.push(remaining);
  return segments;
}

// ─── Public: chunkTextWithAI ─────────────────────────────────────────────────
/**
 * Chunks raw text using Gemini. English content only (the route checks
 * the source language before calling — see file header).
 *
 * For texts ≤ 30K chars: single Gemini call.
 * For longer texts: splits into segments, chunks each, merges results.
 *
 * Returns:
 *   - `{ chunks, model }` on success (chunks may be empty if Gemini
 *     decided the text isn't about plants — that's a valid result).
 *   - `{ error }` on failure (Gemini not configured, rate limit,
 *     malformed response, etc.).
 */
export async function chunkTextWithAI(rawText: string): Promise<ChunkResult> {
  if (!rawText || !rawText.trim()) {
    return { error: "Empty text — nothing to chunk." };
  }

  const segments = splitIntoSegments(rawText);
  if (segments.length === 1) {
    return chunkSegment(segments[0]);
  }

  // Multi-segment: chunk each + merge. If any segment fails, we still
  // return the successful chunks (the admin can review partial results).
  // We track whether at least one segment succeeded.
  logger.info({ segmentCount: segments.length, textLen: rawText.length }, "KB chunking: multi-segment chunking");
  const allChunks: ChunkSuggestion[] = [];
  let lastError = "";
  let usedModel = "";
  for (let i = 0; i < segments.length; i++) {
    const result = await chunkSegment(segments[i]);
    if ("chunks" in result) {
      allChunks.push(...result.chunks);
      if (!usedModel) usedModel = result.model;
    } else {
      lastError = result.error;
      logger.warn({ segment: i, error: lastError }, "KB chunking: segment failed (continuing)");
    }
  }

  if (allChunks.length === 0) {
    return { error: lastError || "AI chunking failed for all segments. Try manual chunking." };
  }
  return { chunks: allChunks, model: usedModel };
}
