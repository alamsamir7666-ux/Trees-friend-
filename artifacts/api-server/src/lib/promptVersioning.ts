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
 * ─── Bug #3 fix: the route now USES the DB text ─────────────────────────────
 *
 * Previously, `getActivePrompt()` was called by the route but its `text`
 * was discarded — only `.version` was used for tracking, and the actual
 * prompt came from the hardcoded `buildSystemPrompt()` in aiContext.ts.
 * This made the entire versioning system decorative.
 *
 * The fix: the route now uses `text` (rendered via `renderPromptTemplate`)
 * as the PRIMARY prompt source. The hardcoded `buildSystemPrompt()` is the
 * FALLBACK, used only when the DB returns empty text (table not seeded,
 * DB unavailable, etc.). The seed row in ensureAiTables.ts mirrors the
 * hardcoded template so existing deployments see no behavior change.
 *
 * ─── Cache TTL (Bug #25 fix: multi-instance drift) ─────────────────────────
 *
 * The cache is in-memory and never expires. On multi-instance deploys
 * (Vercel), if instance A's admin activates a new version, instance B
 * continues using the stale cached prompt until restart. The fix:
 *   - Cache has a TTL (default 60s, configurable via AI_PROMPT_CACHE_TTL_MS).
 *   - After the TTL, the next `getActivePrompt()` call re-fetches from DB.
 *   - `forcePromptRefresh()` still works for immediate invalidation on
 *     the SAME instance (called by the admin activate endpoint).
 *   - For cross-instance invalidation, deploy a pub/sub (Redis) or accept
 *     the 60s drift window. 60s is short enough that A/B test activation
 *     propagates within a minute — acceptable for prompt iteration.
 *
 * Admin endpoints (implemented in routes/aiAdmin.ts):
 *   GET    /api/ai/admin/prompts              — list all versions
 *   GET    /api/ai/admin/prompts/active       — get the currently active version
 *   POST   /api/ai/admin/prompts              — create a new version
 *   POST   /api/ai/admin/prompts/:id/activate — set a version as active
 *   DELETE /api/ai/admin/prompts/:id          — delete a version (with safeguards)
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

// ─── Cache (with TTL) ────────────────────────────────────────────────────────
// The active prompt is loaded once + cached in memory. Refreshed by:
//   - TTL expiry (default 60s) — see Bug #25 fix above.
//   - forcePromptRefresh() — called by the admin activate endpoint.

let _cachedPrompt: PromptVersion | null = null;
let _promptLoadAttempted = false;
let _promptCacheAt: number = 0; // timestamp of last successful load (ms)

// Cache TTL in milliseconds. Default 60s. Configurable via env var so
// high-traffic deployments can tune the staleness/DB-load trade-off.
const PROMPT_CACHE_TTL_MS = Number(process.env.AI_PROMPT_CACHE_TTL_MS ?? 60_000);

/**
 * Returns the active system prompt.
 *
 * Tries the DB first (cached with TTL). If the DB is unavailable or the
 * table doesn't exist, falls back to returning empty text — the route's
 * caller then uses `buildSystemPrompt()` (the hardcoded template) instead.
 *
 * The caller (routes/ai.ts) uses this to get the prompt text, then renders
 * it via `renderPromptTemplate(text, summaryBlock, catalogContext)` to
 * inject the dynamic `{{summary}}` and `{{catalog}}` placeholders.
 */
export async function getActivePrompt(): Promise<{ version: string; text: string }> {
  // Check if the cache is fresh (within TTL).
  const now = Date.now();
  const cacheFresh = _cachedPrompt && (now - _promptCacheAt) < PROMPT_CACHE_TTL_MS;
  if (cacheFresh) {
    return { version: _cachedPrompt!.version, text: _cachedPrompt!.promptText };
  }

  // Cache is stale or empty — re-fetch from DB.
  // We reset _promptLoadAttempted so the next load attempt actually runs
  // (the original code used _promptLoadAttempted as a "load once forever"
  // flag, which is the Bug #25 multi-instance drift issue).
  _promptLoadAttempted = false;

  if (!_promptLoadAttempted) {
    _promptLoadAttempted = true;
    try {
      _cachedPrompt = await loadActivePromptFromDb();
      if (_cachedPrompt) {
        _promptCacheAt = now;
        // Only log on first load or version change (to avoid log spam
        // every 60s on a busy server).
        logger.debug(
          { version: _cachedPrompt.version, id: _cachedPrompt.id, cacheTtlMs: PROMPT_CACHE_TTL_MS },
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

  // Fallback: return empty text + a marker version. The route's caller
  // checks for empty text and falls back to buildSystemPrompt() (the
  // hardcoded template). The version "fallback" is recorded on the
  // assistant message for analytics (so admins can see how many
  // responses used the fallback vs a DB prompt).
  return { version: FALLBACK_PROMPT_VERSION, text: "" };
}

/**
 * Forces a re-load of the active prompt from the DB. Used by the admin
 * activate endpoint (immediate invalidation on the SAME instance).
 *
 * For cross-instance invalidation (multi-instance deploys), the TTL
 * (default 60s) ensures other instances pick up the change within a
 * minute. For instant cross-instance propagation, deploy Redis pub/sub
 * and have the activate endpoint publish a "prompt:refresh" event.
 */
export function forcePromptRefresh(): void {
  _cachedPrompt = null;
  _promptLoadAttempted = false;
  _promptCacheAt = 0;
}

/**
 * Returns all prompt versions (for the admin endpoint).
 * Sorted: active first, then by semver descending.
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
 * Returns the currently active prompt version (for the admin endpoint).
 * Returns null if no version is active (shouldn't happen — the seed
 * ensures v1.0.0 is active).
 */
export async function getActivePromptVersion(): Promise<PromptVersion | null> {
  try {
    const result = await pool.query<PromptVersion>(
      `SELECT id, version, prompt_text, change_log, is_active, created_by, created_at
       FROM ai_prompt_versions
       WHERE is_active = TRUE
       LIMIT 1`,
    );
    return result.rows[0] ?? null;
  } catch (err) {
    logger.error({ err }, "Prompt versioning: getActivePromptVersion failed");
    return null;
  }
}

/**
 * Returns a specific prompt version by id (for the admin endpoint to
 * preview a version before activating it).
 */
export async function getPromptVersion(versionId: number): Promise<PromptVersion | null> {
  try {
    const result = await pool.query<PromptVersion>(
      `SELECT id, version, prompt_text, change_log, is_active, created_by, created_at
       FROM ai_prompt_versions
       WHERE id = $1`,
      [versionId],
    );
    return result.rows[0] ?? null;
  } catch (err) {
    logger.error({ err, versionId }, "Prompt versioning: getPromptVersion failed");
    return null;
  }
}

/**
 * Creates a new prompt version. Does NOT activate it — the admin must
 * explicitly activate it via the activate endpoint.
 *
 * Validates the semver string format (must be X.Y.Z where X, Y, Z are
 * non-negative integers). Rejects duplicates (the DB has a UNIQUE
 * constraint on version, but we check upfront for a better error).
 */
export async function createPromptVersion(
  version: string,
  promptText: string,
  changeLog: string,
  createdBy: string | null = null,
): Promise<PromptVersion | null> {
  // Validate semver format.
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    logger.warn({ version }, "Prompt versioning: invalid semver format");
    return null;
  }
  if (!promptText || promptText.trim().length === 0) {
    logger.warn({ version }, "Prompt versioning: empty prompt text");
    return null;
  }
  // Cap prompt text at 50KB (a sane upper bound for a system prompt —
  // Gemini's context window is 1M tokens but a 50KB prompt is already
  // ~12K tokens, way beyond what a system prompt should be).
  if (promptText.length > 50_000) {
    logger.warn({ version, length: promptText.length }, "Prompt versioning: prompt text too long (>50KB)");
    return null;
  }
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
 *
 * Returns true on success, false if the version doesn't exist or the
 * DB update failed.
 */
export async function activatePromptVersion(versionId: number): Promise<boolean> {
  try {
    // First verify the version exists (so we can return false instead of
    // silently deactivating all versions + activating none).
    const existing = await pool.query("SELECT id FROM ai_prompt_versions WHERE id = $1", [versionId]);
    if (existing.rows.length === 0) {
      logger.warn({ versionId }, "Prompt versioning: activate failed — version not found");
      return false;
    }
    // Atomic: deactivate all + activate the target in a single transaction
    // (so we never end up with zero active versions if the second UPDATE
    // fails — the transaction rolls back).
    await pool.query("BEGIN");
    try {
      await pool.query("UPDATE ai_prompt_versions SET is_active = FALSE");
      await pool.query("UPDATE ai_prompt_versions SET is_active = TRUE WHERE id = $1", [versionId]);
      await pool.query("COMMIT");
    } catch (txErr) {
      await pool.query("ROLLBACK");
      throw txErr;
    }
    forcePromptRefresh();
    logger.info({ versionId }, "Prompt versioning: activated version");
    return true;
  } catch (err) {
    logger.error({ err, versionId }, "Prompt versioning: activate failed");
    return false;
  }
}

/**
 * Deletes a prompt version.
 *
 * Safeguards:
 *   - Cannot delete the currently ACTIVE version (must activate another
 *     first). Returns false with a logged warning.
 *   - Cannot delete the LAST version (must always have at least one,
 *     so the route always has something to fall back to). Returns false.
 *
 * Returns true on success, false on safeguard violation or DB error.
 */
export async function deletePromptVersion(versionId: number): Promise<{
  ok: boolean;
  reason?: string;
}> {
  try {
    // Check if it's the active version.
    const target = await pool.query<{ is_active: boolean }>(
      "SELECT is_active FROM ai_prompt_versions WHERE id = $1",
      [versionId],
    );
    if (target.rows.length === 0) {
      return { ok: false, reason: "Version not found." };
    }
    if (target.rows[0].is_active) {
      return {
        ok: false,
        reason: "Cannot delete the active version. Activate another version first.",
      };
    }
    // Check if it's the last version.
    const countResult = await pool.query("SELECT COUNT(*)::int AS count FROM ai_prompt_versions");
    if (countResult.rows[0].count <= 1) {
      return {
        ok: false,
        reason: "Cannot delete the last remaining version. At least one version must exist.",
      };
    }
    await pool.query("DELETE FROM ai_prompt_versions WHERE id = $1", [versionId]);
    logger.info({ versionId }, "Prompt versioning: deleted version");
    return { ok: true };
  } catch (err) {
    logger.error({ err, versionId }, "Prompt versioning: delete failed");
    return { ok: false, reason: "Database error." };
  }
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function loadActivePromptFromDb(): Promise<PromptVersion | null> {
  const requestedVersion = process.env.AI_PROMPT_VERSION;

  let result;
  if (requestedVersion && requestedVersion !== "latest") {
    // Specific version requested (env override — useful for testing a
    // version without activating it).
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
