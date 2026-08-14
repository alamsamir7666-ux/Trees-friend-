/**
 * Creator tone profile engine (Phase 4).
 *
 * Generates, stores, and retrieves creator tone profiles. When a creator
 * has 10+ entries in the KB, the AI adopts ~60% of their tone in responses
 * that use their content — making answers feel more humanoid and realistic
 * (like the creator is answering directly).
 *
 * ─── Approach: pre-computed profiles (Approach 1) ───────────────────────────
 *
 * Phase 4 uses PRE-COMPUTED profiles (generated once via Gemini, stored on
 * the creator row, reused for every response). This is fast at response
 * time (no extra AI call), consistent (the tone doesn't vary per request),
 * and cheap (one Gemini call per creator, regenerated only when the creator
 * adds 5+ new entries).
 *
 * Alternatives considered (NOT implemented in Phase 4):
 *   - Approach 2: few-shot tone matching (inject 2-3 example entries into
 *     the prompt + let the AI infer the tone). Slower (larger prompt),
 *     less consistent, but no profile generation needed. Future enhancement.
 *   - Approach 3: real-time tone analysis (call Gemini to analyze the
 *     creator's style per request). Too slow (~2s per request), expensive.
 *
 * ─── Profile generation ─────────────────────────────────────────────────────
 *
 * `generateToneProfile(creatorId)`:
 *   1. Fetches up to 15 of the creator's active entries (enough to detect
 *      tone patterns, not too many to exceed token limits).
 *   2. If fewer than TONE_MATCH_THRESHOLD (10) → returns early (no profile).
 *   3. Calls Gemini `generateContent` (non-streaming, JSON response) with
 *      a tone-analysis prompt that asks for adjectives, sentence style,
 *      vocabulary level, greeting style, example phrases, + a summary.
 *   4. Parses the JSON response + stores it on the creator's `tone_profile`
 *      column (as a JSON string — TEXT for cross-PG compat).
 *   5. Records `tone_profile_entry_count` + `tone_profile_model` so the
 *      background job knows when to regenerate.
 *
 * ─── Background job ─────────────────────────────────────────────────────────
 *
 * `kbToneProfileJob.ts` runs every 5 minutes (on Render) or via the
 * `POST /api/cron/kb-tone-profiles` cron endpoint (on Vercel). It finds
 * creators who need new/regenerated profiles + generates up to 3 per run
 * (avoids Gemini rate limits).
 *
 * ─── Tone injection ─────────────────────────────────────────────────────────
 *
 * When the AI chat route builds the system prompt, it checks if the primary
 * KB entry's creator has a tone profile. If so, `formatToneBlockForPrompt`
 * generates a "TONE MATCHING" block injected via the `{{tone}}` placeholder
 * (after `{{catalog}}`). The AI is instructed to adopt ~60% of the creator's
 * tone (configurable per-creator via `tone_match_percentage`).
 *
 * Admin endpoints (in routes/aiAdmin.ts):
 *   GET  /ai/admin/kb/creators/:id/tone-profile
 *   POST /ai/admin/kb/creators/:id/tone-profile/generate
 *   PUT  /ai/admin/kb/creators/:id/tone-percentage
 *   GET  /ai/admin/kb/tone-profiles/status
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { getClient, callWithFallback, isGeminiConfigured, getWorkingModel } from "./gemini";

// ─── Constants (env-configurable) ────────────────────────────────────────────

/**
 * Minimum entries before tone matching activates for a creator.
 * Default 10 — enough content to detect tone patterns. Set lower (e.g. 5)
 * for testing; set higher (e.g. 20) for production quality.
 */
const TONE_MATCH_THRESHOLD = Number(process.env.AI_TONE_MATCH_THRESHOLD ?? 10);

/**
 * Default tone match percentage (0-100). How strongly the AI should adopt
 * the creator's tone. 60% = mostly the creator's style, 40% standard helpful.
 * Per-creator override via the `tone_match_percentage` column (NULL = this
 * global default).
 */
const DEFAULT_TONE_MATCH_PERCENTAGE = Number(process.env.AI_TONE_MATCH_PERCENTAGE ?? 60);

/**
 * Auto-regenerate when the creator adds this many new entries since the
 * last profile generation. Keeps the profile fresh as the creator's style
 * evolves. Default 5 — balances freshness vs Gemini API cost.
 */
const REGENERATION_DELTA = Number(process.env.AI_TONE_REGENERATION_DELTA ?? 5);

// Gemini config for tone analysis.
const TONE_ANALYSIS_TEMPERATURE = 0.3; // low — structured output
const TONE_ANALYSIS_MAX_TOKENS = 2048; // enough for a 6-field JSON profile
const MAX_ENTRIES_FOR_ANALYSIS = 15; // cap to avoid token limits

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToneProfile {
  adjectives: string[];
  sentenceStyle: string;
  vocabularyLevel: string;
  greetingStyle: string;
  examplePhrases: string[];
  toneSummary: string;
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

function buildTonePrompt(
  entries: Array<{ title: string; content: string }>,
): string {
  const entriesText = entries
    .map((e, i) => `Entry ${i + 1}: ${e.title}\n${e.content}`)
    .join("\n\n---\n\n");

  return `You are a tone analysis assistant. Analyze the writing style of the content
creator below, based on their knowledge base entries. Return a JSON object
describing their tone — this will be used to help an AI assistant adopt
a similar tone when answering questions using this creator's content.

Return ONLY a JSON object, no other text. Format:
{
  "adjectives": ["casual", "warm", "uses analogies"],
  "sentence_style": "short, punchy sentences",
  "vocabulary_level": "simple, avoids technical jargon",
  "greeting_style": "often starts with 'apna bhai' or 'cholun'",
  "example_phrases": ["apna bhai", "cholun shuru kori", "manten khoroch"],
  "tone_summary": "Friendly and approachable, like a knowledgeable neighbor giving advice over tea."
}

Rules:
- Be specific — don't just say "friendly". Describe HOW they're friendly.
- Include 3-5 example phrases the creator actually uses (exact quotes from the content).
- Keep the tone_summary to 1-2 sentences.
- If the content is in Bengali/Banglish, describe the tone in English (so the AI can understand it) but include the Bengali example phrases as-is.
- If the entries are too short or generic to determine a tone, return { "tone_summary": "Neutral — no distinctive tone detected." }

Creator entries:
---
${entriesText}
---`;
}

// ─── Response parsing ──────────────────────────────────────────────────────────

/**
 * Parses + validates the Gemini JSON response into a ToneProfile.
 * Returns null if the response is empty, not valid JSON, or missing required
 * fields. Malformed optional fields are defaulted (e.g. empty adjectives array).
 */
function parseToneResponse(text: string): ToneProfile | null {
  if (!text || !text.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger.warn({ textPreview: text.slice(0, 200) }, "KB tone: JSON.parse failed");
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    logger.warn("KB tone: response is not an object");
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const toneSummary = typeof obj.tone_summary === "string" ? obj.tone_summary.trim() : "";
  if (!toneSummary) {
    logger.warn("KB tone: missing tone_summary");
    return null;
  }

  return {
    adjectives: Array.isArray(obj.adjectives)
      ? obj.adjectives.filter((a): a is string => typeof a === "string").map((a) => a.trim()).filter(Boolean)
      : [],
    sentenceStyle: typeof obj.sentence_style === "string" ? obj.sentence_style.trim() : "",
    vocabularyLevel: typeof obj.vocabulary_level === "string" ? obj.vocabulary_level.trim() : "",
    greetingStyle: typeof obj.greeting_style === "string" ? obj.greeting_style.trim() : "",
    examplePhrases: Array.isArray(obj.example_phrases)
      ? obj.example_phrases.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean)
      : [],
    toneSummary,
  };
}

// ─── Function 1: generateToneProfile ─────────────────────────────────────────

/**
 * Generates a tone profile for a creator by analyzing their active KB entries
 * via Gemini. Stores the profile on the creator row.
 *
 * Requirements:
 *   - Creator must exist + be active.
 *   - Creator must have >= TONE_MATCH_THRESHOLD (10) active entries.
 *   - Gemini must be configured (GEMINI_API_KEY set).
 *
 * Returns:
 *   - { success: true } on success.
 *   - { success: false, reason } on failure (below threshold, Gemini not
 *     configured, rate limit, parse error, etc.).
 *
 * The profile is stored as a JSON string in the `tone_profile` TEXT column
 * (cross-PG compat — no jsonb dependency). `tone_profile_entry_count` records
 * how many entries the profile was based on (so the background job knows when
 * to regenerate — auto-regenerate at +5 new entries).
 */
export async function generateToneProfile(
  creatorId: number,
): Promise<{ success: boolean; reason?: string }> {
  if (!Number.isInteger(creatorId) || creatorId <= 0) {
    return { success: false, reason: "Invalid creator id." };
  }

  if (!isGeminiConfigured()) {
    return { success: false, reason: "Gemini API key not set" };
  }

  try {
    // Fetch up to 15 of the creator's active entries (most recent first).
    const entriesResult = await pool.query<{ id: number; title: string; content: string }>(
      `SELECT id, title, content
       FROM ai_kb_entries
       WHERE creator_id = $1 AND is_active = TRUE
       ORDER BY created_at DESC
       LIMIT $2`,
      [creatorId, MAX_ENTRIES_FOR_ANALYSIS],
    );

    if (entriesResult.rows.length === 0) {
      return { success: false, reason: "Creator has no active entries" };
    }

    // Check threshold (use the creator's denormalized entry_count for the
    // threshold check — it's the total, not just the 15 we fetched).
    const creatorResult = await pool.query<{ entry_count: number; is_active: boolean; name: string }>(
      "SELECT entry_count, is_active, name FROM ai_kb_creators WHERE id = $1",
      [creatorId],
    );
    if (creatorResult.rows.length === 0) {
      return { success: false, reason: "Creator not found" };
    }
    const creator = creatorResult.rows[0];
    if (!creator.is_active) {
      return { success: false, reason: "Creator is inactive" };
    }
    if (creator.entry_count < TONE_MATCH_THRESHOLD) {
      return {
        success: false,
        reason: `Creator has ${creator.entry_count} entries (threshold: ${TONE_MATCH_THRESHOLD})`,
      };
    }

    // Call Gemini to analyze the tone.
    let client;
    try {
      client = getClient();
    } catch (err) {
      return { success: false, reason: err instanceof Error ? err.message : "Gemini client unavailable" };
    }

    let response: unknown;
    try {
      response = await callWithFallback((modelName) =>
        client.models.generateContent({
          model: modelName,
          contents: [{ role: "user" as const, parts: [{ text: buildTonePrompt(entriesResult.rows) }] }],
          config: {
            responseMimeType: "application/json",
            temperature: TONE_ANALYSIS_TEMPERATURE,
            maxOutputTokens: TONE_ANALYSIS_MAX_TOKENS,
          },
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("429") || msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("rate limit")) {
        return { success: false, reason: "Gemini rate limit hit" };
      }
      logger.error({ err: msg, creatorId }, "KB tone: Gemini call failed");
      return { success: false, reason: "Gemini call failed" };
    }

    const text = (response as { text?: string })?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      return { success: false, reason: "Gemini returned empty response" };
    }

    const profile = parseToneResponse(text);
    if (!profile) {
      return { success: false, reason: "Failed to parse AI response" };
    }

    // Store the profile as a JSON string.
    const profileJson = JSON.stringify(profile);
    const usedModel = getWorkingModel() ?? "unknown";

    await pool.query(
      `UPDATE ai_kb_creators
         SET tone_profile = $1,
             tone_profile_updated_at = NOW(),
             tone_profile_entry_count = $2,
             tone_profile_model = $3,
             updated_at = NOW()
       WHERE id = $4`,
      [profileJson, entriesResult.rows.length, usedModel, creatorId],
    );

    logger.info(
      { creatorId, creatorName: creator.name, entryCount: entriesResult.rows.length, model: usedModel },
      "KB tone: profile generated",
    );
    return { success: true };
  } catch (err) {
    logger.error({ err, creatorId }, "KB tone: generateToneProfile failed");
    return { success: false, reason: "Unexpected error" };
  }
}

// ─── Function 2: getToneProfile ──────────────────────────────────────────────

/**
 * Fetches + parses a creator's tone profile. Returns null if no profile
 * exists or parsing fails.
 */
export async function getToneProfile(creatorId: number): Promise<ToneProfile | null> {
  if (!Number.isInteger(creatorId) || creatorId <= 0) return null;
  try {
    const result = await pool.query<{ tone_profile: string | null }>(
      "SELECT tone_profile FROM ai_kb_creators WHERE id = $1",
      [creatorId],
    );
    if (result.rows.length === 0 || !result.rows[0].tone_profile) return null;
    try {
      const parsed = JSON.parse(result.rows[0].tone_profile);
      // Validate the required field.
      if (!parsed || typeof parsed.tone_summary !== "string") return null;
      return parsed as ToneProfile;
    } catch {
      logger.warn({ creatorId }, "KB tone: stored profile is invalid JSON");
      return null;
    }
  } catch (err) {
    logger.error({ err, creatorId }, "KB tone: getToneProfile failed");
    return null;
  }
}

// ─── Function 3: getEffectiveToneMatchPercentage ────────────────────────────

/**
 * Returns the effective tone match percentage for a creator.
 *   - If the creator has a per-creator override (`tone_match_percentage`
 *     column is not NULL) → return that (0-100).
 *   - Otherwise → return the global default (`DEFAULT_TONE_MATCH_PERCENTAGE`).
 */
export async function getEffectiveToneMatchPercentage(creatorId: number): Promise<number> {
  if (!Number.isInteger(creatorId) || creatorId <= 0) return DEFAULT_TONE_MATCH_PERCENTAGE;
  try {
    const result = await pool.query<{ tone_match_percentage: number | null }>(
      "SELECT tone_match_percentage FROM ai_kb_creators WHERE id = $1",
      [creatorId],
    );
    if (result.rows.length === 0) return DEFAULT_TONE_MATCH_PERCENTAGE;
    const pct = result.rows[0].tone_match_percentage;
    if (pct === null || typeof pct !== "number" || pct < 0 || pct > 100) {
      return DEFAULT_TONE_MATCH_PERCENTAGE;
    }
    return pct;
  } catch (err) {
    logger.error({ err, creatorId }, "KB tone: getEffectiveToneMatchPercentage failed");
    return DEFAULT_TONE_MATCH_PERCENTAGE;
  }
}

// ─── Function 4: needsToneProfileRegeneration ────────────────────────────────

/**
 * Checks if a creator's tone profile needs regeneration:
 *   1. No profile exists AND entry_count >= threshold → needed (first generation).
 *   2. Profile exists AND (current_entry_count - tone_profile_entry_count)
 *      >= REGENERATION_DELTA (5) → needed (creator added enough new entries).
 *   3. Otherwise → not needed (profile is current).
 *
 * Returns `{ needed, reason }`.
 */
export async function needsToneProfileRegeneration(
  creatorId: number,
): Promise<{ needed: boolean; reason: string }> {
  if (!Number.isInteger(creatorId) || creatorId <= 0) {
    return { needed: false, reason: "Invalid creator id" };
  }
  try {
    const result = await pool.query<{
      entry_count: number;
      tone_profile: string | null;
      tone_profile_entry_count: number | null;
    }>(
      "SELECT entry_count, tone_profile, tone_profile_entry_count FROM ai_kb_creators WHERE id = $1",
      [creatorId],
    );
    if (result.rows.length === 0) {
      return { needed: false, reason: "Creator not found" };
    }
    const row = result.rows[0];
    const hasProfile = row.tone_profile !== null;
    const entryCount = Number(row.entry_count) || 0;

    if (entryCount < TONE_MATCH_THRESHOLD) {
      return {
        needed: false,
        reason: `Creator has ${entryCount} entries (below threshold of ${TONE_MATCH_THRESHOLD})`,
      };
    }

    if (!hasProfile) {
      return {
        needed: true,
        reason: `Profile not yet generated (creator has ${entryCount} entries)`,
      };
    }

    const profileEntryCount = Number(row.tone_profile_entry_count) || 0;
    const delta = entryCount - profileEntryCount;
    if (delta >= REGENERATION_DELTA) {
      return {
        needed: true,
        reason: `Creator added ${delta} new entries since last profile generation`,
      };
    }

    return { needed: false, reason: "Profile is current" };
  } catch (err) {
    logger.error({ err, creatorId }, "KB tone: needsRegeneration check failed");
    return { needed: false, reason: "Check failed" };
  }
}

// ─── Function 5: getCreatorsNeedingToneProfiles ──────────────────────────────

/**
 * Finds all active creators who need new/regenerated tone profiles.
 * Called by the background job.
 *
 * Optimization: single SQL query (avoids N+1 per-creator checks). The
 * WHERE clause handles both "never generated" (tone_profile IS NULL) and
 * "needs regeneration" (entry_count - tone_profile_entry_count >= delta).
 *
 * Returns creators ordered by entry_count DESC (most prolific first —
 * they benefit most from tone matching).
 */
export async function getCreatorsNeedingToneProfiles(): Promise<
  Array<{ id: number; name: string; entryCount: number; reason: string }>
> {
  try {
    const result = await pool.query<{
      id: number;
      name: string;
      entry_count: number;
      has_profile: boolean;
      tone_profile_entry_count: number | null;
    }>(
      `SELECT id, name, entry_count,
              tone_profile IS NOT NULL AS has_profile,
              tone_profile_entry_count
       FROM ai_kb_creators
       WHERE is_active = TRUE
         AND entry_count >= $1
         AND (
           tone_profile IS NULL
           OR (entry_count - COALESCE(tone_profile_entry_count, 0)) >= $2
         )
       ORDER BY entry_count DESC`,
      [TONE_MATCH_THRESHOLD, REGENERATION_DELTA],
    );

    return result.rows.map((row) => {
      const hasProfile = row.has_profile;
      const delta = Number(row.entry_count) - (Number(row.tone_profile_entry_count) || 0);
      const reason = hasProfile
        ? `Creator added ${delta} new entries since last profile generation`
        : `Profile not yet generated (creator has ${row.entry_count} entries)`;
      return {
        id: row.id,
        name: row.name,
        entryCount: Number(row.entry_count) || 0,
        reason,
      };
    });
  } catch (err) {
    logger.error({ err }, "KB tone: getCreatorsNeedingToneProfiles failed");
    return [];
  }
}

// ─── Function 6: formatToneBlockForPrompt ────────────────────────────────────

/**
 * Formats the tone instructions for the system prompt's `{{tone}}` placeholder.
 * The block tells the AI to adopt ~60% of the creator's tone (configurable
 * via `matchPercentage`), with specific guidance on style, vocabulary,
 * greetings, and example phrases.
 *
 * The "rules" section is critical — it prevents the AI from over-imitating
 * (copying phrases verbatim) or under-imitating (ignoring the tone entirely).
 * The "40% standard helpful" keeps the response useful even if the creator's
 * style is very casual.
 */
export function formatToneBlockForPrompt(
  profile: ToneProfile,
  creatorName: string,
  matchPercentage: number,
): string {
  const lines: string[] = [
    "TONE MATCHING (Phase 4):",
    `The primary knowledge source above is from "${creatorName}".`,
    `Adopt approximately ${matchPercentage}% of this creator's tone in your response:`,
  ];

  if (profile.adjectives.length > 0) {
    lines.push(`- Style: ${profile.adjectives.join(", ")}`);
  }
  if (profile.sentenceStyle) {
    lines.push(`- Sentences: ${profile.sentenceStyle}`);
  }
  if (profile.vocabularyLevel) {
    lines.push(`- Vocabulary: ${profile.vocabularyLevel}`);
  }
  if (profile.greetingStyle) {
    lines.push(`- Greetings: ${profile.greetingStyle}`);
  }
  if (profile.examplePhrases.length > 0) {
    const phrases = profile.examplePhrases.map((p) => `"${p}"`).join(", ");
    lines.push(`- Example phrases: ${phrases}`);
  }
  if (profile.toneSummary) {
    lines.push(`Summary: ${profile.toneSummary}`);
  }

  lines.push("");
  lines.push("Rules:");
  lines.push("- Capture the SPIRIT of their tone, don't copy their phrases verbatim.");
  lines.push("- Use 1-2 of their example phrases naturally if they fit (don't force it).");
  const remainingPct = 100 - matchPercentage;
  lines.push(`- Keep ${remainingPct}% of your standard helpful, clear tone — the creator's tone is an accent, not a mask.`);
  lines.push("- If the user asks a factual question, prioritize accuracy over tone.");
  lines.push("- Respond in the same language as the user's message (the creator's tone should adapt to the user's language).");

  return lines.join("\n");
}

// ─── Exported constants (for tests + admin endpoints) ─────────────────────────

export {
  TONE_MATCH_THRESHOLD,
  DEFAULT_TONE_MATCH_PERCENTAGE,
  REGENERATION_DELTA,
};
