/**
 * KB content version — a fingerprint of the currently-active KB state.
 *
 * Used by the semantic cache (BUG-3 fix) to reject stale cache rows at
 * SELECT time, eliminating the race window between event-driven
 * invalidation (BUG-1) and concurrent in-flight requests.
 *
 * ─── How it works ────────────────────────────────────────────────────────────
 *
 * The version is computed as:
 *
 *   sha1( CONCAT(id, ':', updated_at, ':', is_active) ORDER BY id ASC )
 *         truncated to 16 hex chars
 *
 * It changes whenever:
 *   - An entry's content/title/keywords change (updated_at bumps)
 *   - An entry is created (new row in the hash input)
 *   - An entry is deleted (row removed from hash input)
 *   - An entry is activated/deactivated (is_active flag flips)
 *
 * It does NOT change when:
 *   - A category is renamed (doesn't affect entry content)
 *   - A creator's tone_profile is regenerated (tone affects the system
 *     prompt but is tracked separately — see note below)
 *   - A source's metadata is updated (entries inherit at creation, not
 *     live)
 *
 * Tone profile changes are handled by the existing event-driven
 * invalidation (BUG-1). Tone is rare enough that a small race window
 * for tone is acceptable; the kb_content_version is specifically for
 * the high-frequency KB content changes.
 *
 * ─── Caching ─────────────────────────────────────────────────────────────────
 *
 * The version is cached in-process for 5 seconds to avoid re-querying
 * the DB on every chat request. The cache is cleared by
 * `clearKbContentVersionCache()` which is wired into `invalidateKbCache()`
 * (BUG-1 fix) so every KB mutation forces the next request to re-compute.
 *
 * ─── Fail-safe ───────────────────────────────────────────────────────────────
 *
 * On DB error: returns the sentinel string "unknown". The route handler
 * treats "unknown" as "bypass cache" (neither read from nor write to
 * the semantic cache). Safer to miss the cache than serve stale content
 * when we can't determine the KB version.
 *
 * ─── Performance ─────────────────────────────────────────────────────────────
 *
 * SELECT over active entries with COUNT check is ~1ms for a KB of
 * <10K entries (typical). Cached in-process for 5 seconds to avoid
 * re-querying on every chat request.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { createHash } from "crypto";

const CACHE_TTL_MS = 5000; // 5 seconds — short, just to dedupe concurrent requests

/**
 * Sentinel value returned when the KB version can't be computed (DB
 * error). Callers should treat this as "bypass cache" — neither read
 * from nor write to the semantic cache.
 */
export const KB_CONTENT_VERSION_UNKNOWN = "unknown";

let cachedVersion: { value: string; expiresAt: number } | null = null;

/**
 * Computes the current KB content version.
 *
 * Returns a 16-char hex string. Stable across calls within 5 seconds,
 * then re-queries the DB.
 *
 * On DB error: returns "unknown" (KB_CONTENT_VERSION_UNKNOWN). The
 * cache lookup will reject all rows (NULL kb_content_version != "unknown"),
 * forcing a fresh LLM call. Safer to miss the cache than serve stale
 * content.
 */
export async function getKbContentVersion(): Promise<string> {
  // L1 cache: avoid hitting the DB on every chat request.
  if (cachedVersion && cachedVersion.expiresAt > Date.now()) {
    return cachedVersion.value;
  }

  try {
    const result = await pool.query<{
      id: number;
      updated_at: Date;
      is_active: boolean;
    }>(
      `SELECT id, updated_at, is_active
       FROM ai_kb_entries
       ORDER BY id ASC`,
    );

    // Build a stable string representation: id:updated_at:is_active per
    // row, separated by newlines. updated_at is converted to ISO string
    // for stable stringification (PG timestamp -> JS Date -> ISO string
    // is deterministic).
    const input = result.rows
      .map((r) => `${r.id}:${r.updated_at.toISOString()}:${r.is_active ? 1 : 0}`)
      .join("\n");

    const version = createHash("sha1").update(input).digest("hex").slice(0, 16);

    cachedVersion = { value: version, expiresAt: Date.now() + CACHE_TTL_MS };
    return version;
  } catch (err) {
    // On DB error: log + return "unknown". The cache lookup will reject
    // all rows (NULL kb_content_version != "unknown"), forcing a fresh
    // LLM call. This is the fail-safe behavior.
    logger.debug(
      { err: (err as any)?.message ?? String(err) },
      "KB content version: computation failed, returning 'unknown' (cache will be bypassed)",
    );
    return KB_CONTENT_VERSION_UNKNOWN;
  }
}

/**
 * Clears the in-process cache of the KB content version.
 *
 * Call this after any KB mutation to force the next request to re-compute
 * the version (otherwise it would use the stale 5-second-cached value).
 *
 * Wired into `invalidateKbCache()` (BUG-1 fix) so every KB mutation
 * clears both the response cache AND the version cache.
 */
export function clearKbContentVersionCache(): void {
  cachedVersion = null;
}
