/**
 * Prompt versioning system for the TreeBot assistant.
 *
 * Industry standard: version prompts in a database so you can:
 *   - A/B test prompt versions (see which gets better feedback)
 *   - Roll back bad prompts without a code deploy
 *   - Track which prompt version generated each response
 *   - Iterate on prompts without touching code
 *
 * How it works:
 *   1. The system prompt is stored in the `ai_prompt_versions` table.
 *   2. Each version has a semver string (e.g. "1.0.0") + the prompt text.
 *   3. The "active" version is controlled by the AI_PROMPT_VERSION env var
 *      (default: "latest", which uses the highest semver).
 *   4. When building the system prompt, we look up the active version.
 *      If the DB is unavailable, we fall back to the hardcoded prompt
 *      in aiContext.ts (so the system never breaks due to a DB issue).
 *   5. The prompt version used is recorded on each assistant message
 *      (new `prompt_version` column) so we can correlate feedback with
 *      prompt versions.
 *
 * The DB table is created by ensureAiTables.ts (idempotent CREATE TABLE
 * IF NOT EXISTS). Prompts are seeded on first run if the table is empty.
 *
 * Admin endpoints:
 *   GET  /api/ai/admin/prompts          — list all versions
 *   POST /api/ai/admin/prompts          — create a new version
 *   GET  /api/ai/admin/prompts/active   — get the currently active version
 *   POST /api/ai/admin/prompts/:id/activate — set a version as active
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PromptVersion {
  id: number;
  version: string; // semver: "1.0.0"
  promptText: string;
  changeLog: string; // what changed in this version
  isActive: boolean;
  createdBy: string | null;
  createdAt: Date;
}

// ─── Fallback prompt (used when DB is unavailable) ──────────────────────────
// This mirrors the prompt from aiContext.ts. If the DB has a newer version,
// the DB version wins. This is just the safety net.

const FALLBACK_PROMPT_VERSION = "1.0.0";

// ─── Cache ───────────────────────────────────────────────────────────────────
// The active prompt is loaded once + cached in memory. Refreshed by
// forcePromptRefresh() (called by the admin activate endpoint).

let _cachedPrompt: PromptVersion | null = null;
let _promptLoadAttempted = false;

/**
 * Returns the active system prompt.
 *
 * Tries the DB first. If the DB is unavailable or the table doesn't exist,
 * falls back to the hardcoded prompt from aiContext.ts.
 *
 * The caller (aiContext.ts buildSystemPrompt) uses this to get the base
 * prompt text, then appends the dynamic catalog context + summary block.
 */
export async function getActivePrompt(): Promise<{ version: string; text: string }> {
  if (_cachedPrompt) {
    return { version: _cachedPrompt.version, text: _cachedPrompt.promptText };
  }

  if (!_promptLoadAttempted) {
    _promptLoadAttempted = true;
    try {
      _cachedPrompt = await loadActivePromptFromDb();
      if (_cachedPrompt) {
        logger.info(
          { version: _cachedPrompt.version, id: _cachedPrompt.id },
          "Prompt versioning: loaded active prompt from DB",
        );
      }
    } catch (err) {
      logger.warn({ err }, "Prompt versioning: failed to load from DB, using fallback");
    }
  }

  if (_cachedPrompt) {
    return { version: _cachedPrompt.version, text: _cachedPrompt.promptText };
  }

  // Fallback: return a minimal marker. The real prompt is built by
  // aiContext.ts buildSystemPrompt() which has the hardcoded text.
  return { version: FALLBACK_PROMPT_VERSION, text: "" };
}

/**
 * Forces a re-load of the active prompt from the DB. Used by the admin
 * activate endpoint.
 */
export function forcePromptRefresh(): void {
  _cachedPrompt = null;
  _promptLoadAttempted = false;
}

/**
 * Returns all prompt versions (for the admin endpoint).
 */
export async function listPromptVersions(): Promise<PromptVersion[]> {
  try {
    const result = await pool.query(
      `SELECT id, version, prompt_text, change_log, is_active, created_by, created_at
       FROM ai_prompt_versions
       ORDER BY
         is_active DESC,
         string_to_array(version, '.')::int[] DESC`,
    );
    return result.rows as PromptVersion[];
  } catch (err) {
    logger.error({ err }, "Prompt versioning: list failed");
    return [];
  }
}

/**
 * Creates a new prompt version. Does NOT activate it — the admin must
 * explicitly activate it via the activate endpoint.
 */
export async function createPromptVersion(
  version: string,
  promptText: string,
  changeLog: string,
  createdBy: string | null = null,
): Promise<PromptVersion | null> {
  try {
    const result = await pool.query<PromptVersion>(
      `INSERT INTO ai_prompt_versions (version, prompt_text, change_log, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, version, prompt_text, change_log, is_active, created_by, created_at`,
      [version, promptText, changeLog, createdBy],
    );
    return result.rows[0] ?? null;
  } catch (err) {
    logger.error({ err, version }, "Prompt versioning: create failed");
    return null;
  }
}

/**
 * Activates a specific prompt version (deactivates all others).
 * Clears the in-memory cache so the next request uses the new version.
 */
export async function activatePromptVersion(versionId: number): Promise<boolean> {
  try {
    await pool.query("UPDATE ai_prompt_versions SET is_active = FALSE");
    await pool.query("UPDATE ai_prompt_versions SET is_active = TRUE WHERE id = $1", [versionId]);
    forcePromptRefresh();
    logger.info({ versionId }, "Prompt versioning: activated version");
    return true;
  } catch (err) {
    logger.error({ err, versionId }, "Prompt versioning: activate failed");
    return false;
  }
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function loadActivePromptFromDb(): Promise<PromptVersion | null> {
  const requestedVersion = process.env.AI_PROMPT_VERSION;

  let result;
  if (requestedVersion && requestedVersion !== "latest") {
    // Specific version requested
    result = await pool.query<PromptVersion>(
      `SELECT id, version, prompt_text, change_log, is_active, created_by, created_at
       FROM ai_prompt_versions
       WHERE version = $1`,
      [requestedVersion],
    );
  } else {
    // Use the active version (is_active = TRUE)
    result = await pool.query<PromptVersion>(
      `SELECT id, version, prompt_text, change_log, is_active, created_by, created_at
       FROM ai_prompt_versions
       WHERE is_active = TRUE
       LIMIT 1`,
    );
  }

  return result.rows[0] ?? null;
}
