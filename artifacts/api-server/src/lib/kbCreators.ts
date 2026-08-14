/**
 * KB content creator management (Phase 2).
 *
 * Creators are the upstream authors of KB content — YouTube channels,
 * blog authors, or "Manual" for admin-typed content. Phase 1 created the
 * table + a default "Manual" seed row; Phase 2 adds the admin CRUD so
 * admins can register creators before uploading their content.
 *
 * Phase 4 will add tone-profile fields (`toneProfile`,
 * `toneMatchPercentage`) — they're in the schema + types but unused for
 * now (always NULL).
 *
 * Industry standard: simple CRUD with a denormalized `entryCount` on each
 * row so the admin list view doesn't need a JOIN. The count is maintained
 * by `incrementEntryCount` / `decrementEntryCount` — called by the
 * entry-creation / entry-deletion paths in kbEntries.ts. We deliberately
 * don't use a trigger (simpler to reason about, no hidden writes).
 *
 * Delete safeguard: cannot delete a creator that has entries (the admin
 * must move or delete the entries first). This prevents accidentally
 * orphaning entries — although the FK is ON DELETE SET NULL (entries
 * survive), losing the creator association loses provenance + future
 * tone-matching capability.
 *
 * Admin endpoints (in routes/aiAdmin.ts):
 *   GET    /api/ai/admin/kb/creators
 *   POST   /api/ai/admin/kb/creators
 *   PUT    /api/ai/admin/kb/creators/:id
 *   DELETE /api/ai/admin/kb/creators/:id
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KbCreator {
  id: number;
  name: string;
  slug: string;
  sourceType: string; // youtube | blog | facebook | manual
  profileUrl: string | null;
  entryCount: number; // denormalized count
  toneProfile: string | null; // Phase 4 — NULL for now
  toneProfileUpdatedAt: Date | null; // Phase 4
  toneMatchPercentage: number | null; // Phase 4
  isFeatured: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Validation constants ────────────────────────────────────────────────────

export const CREATOR_SLUG_REGEX = /^[a-z0-9-]+$/;
export const CREATOR_SLUG_MAX_LENGTH = 80;
export const CREATOR_NAME_MAX_LENGTH = 100;
export const CREATOR_PROFILE_URL_MAX_LENGTH = 500;
export const VALID_SOURCE_TYPES = ["youtube", "blog", "facebook", "manual"] as const;
export type SourceType = (typeof VALID_SOURCE_TYPES)[number];

// ─── Row mapping ─────────────────────────────────────────────────────────────

interface KbCreatorRow {
  id: number;
  name: string;
  slug: string;
  source_type: string;
  profile_url: string | null;
  entry_count: number;
  tone_profile: string | null;
  tone_profile_updated_at: Date | null;
  tone_match_percentage: number | null;
  is_featured: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: KbCreatorRow): KbCreator {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    sourceType: row.source_type,
    profileUrl: row.profile_url,
    entryCount: Number(row.entry_count) || 0,
    toneProfile: row.tone_profile,
    toneProfileUpdatedAt: row.tone_profile_updated_at,
    toneMatchPercentage: row.tone_match_percentage,
    isFeatured: row.is_featured,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── listKbCreators ──────────────────────────────────────────────────────────
/**
 * Returns all creators (active + inactive), ordered by entry_count DESC
 * then name ASC (so the most prolific creators appear first). Each row
 * includes the denormalized `entryCount`.
 */
export async function listKbCreators(): Promise<KbCreator[]> {
  try {
    const result = await pool.query<KbCreatorRow>(
      `SELECT id, name, slug, source_type, profile_url, entry_count,
              tone_profile, tone_profile_updated_at, tone_match_percentage,
              is_featured, is_active, created_at, updated_at
       FROM ai_kb_creators
       ORDER BY entry_count DESC, name ASC`,
    );
    return result.rows.map(mapRow);
  } catch (err) {
    logger.error({ err }, "KB creators: list failed");
    return [];
  }
}

// ─── getKbCreator ────────────────────────────────────────────────────────────
export async function getKbCreator(id: number): Promise<KbCreator | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const result = await pool.query<KbCreatorRow>(
      `SELECT id, name, slug, source_type, profile_url, entry_count,
              tone_profile, tone_profile_updated_at, tone_match_percentage,
              is_featured, is_active, created_at, updated_at
       FROM ai_kb_creators
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  } catch (err) {
    logger.error({ err, id }, "KB creators: get failed");
    return null;
  }
}

// ─── getKbCreatorBySlug ──────────────────────────────────────────────────────
export async function getKbCreatorBySlug(slug: string): Promise<KbCreator | null> {
  if (!slug) return null;
  try {
    const result = await pool.query<KbCreatorRow>(
      `SELECT id, name, slug, source_type, profile_url, entry_count,
              tone_profile, tone_profile_updated_at, tone_match_percentage,
              is_featured, is_active, created_at, updated_at
       FROM ai_kb_creators
       WHERE slug = $1
       LIMIT 1`,
      [slug],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  } catch (err) {
    logger.error({ err, slug }, "KB creators: getBySlug failed");
    return null;
  }
}

// ─── createKbCreator ─────────────────────────────────────────────────────────
/**
 * Creates a new creator. The slug must be globally unique (DB enforces
 * this via the `slug` UNIQUE constraint). Returns null on validation
 * failure, slug conflict, or DB error.
 */
export async function createKbCreator(params: {
  name: string;
  slug: string;
  sourceType: string;
  profileUrl?: string | null;
}): Promise<KbCreator | null> {
  const name = params.name?.trim() ?? "";
  const slug = params.slug?.trim() ?? "";
  const sourceType = params.sourceType;
  const profileUrl = params.profileUrl?.trim() || null;

  // Validate name.
  if (!name || name.length > CREATOR_NAME_MAX_LENGTH) {
    logger.warn({ name: params.name }, "KB creators: create failed — invalid name");
    return null;
  }
  // Validate slug.
  if (!slug || !CREATOR_SLUG_REGEX.test(slug) || slug.length > CREATOR_SLUG_MAX_LENGTH) {
    logger.warn({ slug }, "KB creators: create failed — invalid slug");
    return null;
  }
  if (slug.startsWith("-") || slug.endsWith("-")) {
    logger.warn({ slug }, "KB creators: create failed — slug has leading/trailing hyphen");
    return null;
  }
  // Validate sourceType.
  if (!VALID_SOURCE_TYPES.includes(sourceType as SourceType)) {
    logger.warn({ sourceType }, "KB creators: create failed — invalid sourceType");
    return null;
  }
  // Validate profileUrl (optional — must be a URL if provided).
  if (profileUrl) {
    if (profileUrl.length > CREATOR_PROFILE_URL_MAX_LENGTH) {
      logger.warn({ urlLen: profileUrl.length }, "KB creators: create failed — profileUrl too long");
      return null;
    }
    try {
      // Use the URL constructor for validation. We accept http(s) URLs
      // + any other valid URL (some social-media profile URLs are
      // technically valid but weird — let the admin decide).
      new URL(profileUrl);
    } catch {
      logger.warn({ profileUrl }, "KB creators: create failed — invalid profileUrl");
      return null;
    }
  }

  try {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO ai_kb_creators (name, slug, source_type, profile_url)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [name, slug, sourceType, profileUrl],
    );
    return await getKbCreator(result.rows[0].id);
  } catch (err) {
    // 23505 = unique_violation (slug conflict). The route translates
    // null return → 409 with a generic message.
    logger.error({ err, name, slug, sourceType }, "KB creators: create failed");
    return null;
  }
}

// ─── updateKbCreator ─────────────────────────────────────────────────────────
/**
 * Updates a creator. Only `name`, `profileUrl`, `isActive`, and
 * `isFeatured` are updatable — `slug` and `sourceType` are immutable
 * after creation (changing them would break URLs + provenance).
 */
export async function updateKbCreator(
  id: number,
  updates: {
    name?: string;
    profileUrl?: string | null;
    isActive?: boolean;
    isFeatured?: boolean;
  },
): Promise<KbCreator | null> {
  if (!Number.isInteger(id) || id <= 0) return null;

  const name = updates.name?.trim();
  if (name !== undefined) {
    if (!name || name.length > CREATOR_NAME_MAX_LENGTH) {
      logger.warn({ id, nameLen: name?.length }, "KB creators: update failed — invalid name");
      return null;
    }
  }
  let profileUrl: string | null | undefined;
  if (updates.profileUrl !== undefined) {
    profileUrl = updates.profileUrl?.trim() || null;
    if (profileUrl) {
      if (profileUrl.length > CREATOR_PROFILE_URL_MAX_LENGTH) {
        logger.warn({ id, urlLen: profileUrl.length }, "KB creators: update failed — profileUrl too long");
        return null;
      }
      try {
        new URL(profileUrl);
      } catch {
        logger.warn({ id, profileUrl }, "KB creators: update failed — invalid profileUrl");
        return null;
      }
    }
  }

  try {
    const setClauses: string[] = ["updated_at = NOW()"];
    const values: (string | boolean | null)[] = [];
    let paramIdx = 1;
    if (name !== undefined) {
      setClauses.push(`name = $${paramIdx++}`);
      values.push(name);
    }
    if (profileUrl !== undefined) {
      setClauses.push(`profile_url = $${paramIdx++}`);
      values.push(profileUrl);
    }
    if (updates.isActive !== undefined) {
      setClauses.push(`is_active = $${paramIdx++}`);
      values.push(updates.isActive);
    }
    if (updates.isFeatured !== undefined) {
      setClauses.push(`is_featured = $${paramIdx++}`);
      values.push(updates.isFeatured);
    }
    if (setClauses.length === 1) {
      // No fields to update (only `updated_at`).
      logger.warn({ id }, "KB creators: update failed — no fields to update");
      return null;
    }
    values.push(id.toString());

    await pool.query(
      `UPDATE ai_kb_creators SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
      values,
    );
    return await getKbCreator(id);
  } catch (err) {
    logger.error({ err, id, updates }, "KB creators: update failed");
    return null;
  }
}

// ─── deleteKbCreator ─────────────────────────────────────────────────────────
/**
 * Deletes a creator. Rejects if the creator has entries (the admin must
 * move or delete the entries first). The "Manual" creator (slug='manual')
 * is also protected — it's the default fallback for admin-typed content
 * and should never be deleted.
 *
 * Returns:
 *   { ok: true }                              — deleted
 *   { ok: false, reason: "not found" }        — id doesn't exist
 *   { ok: false, reason: "protected" }        — tried to delete "Manual"
 *   { ok: false, reason: "has entries" }      — entries block the delete
 *   { ok: false, reason: "db error" }         — unexpected DB error
 */
export async function deleteKbCreator(
  id: number,
): Promise<{ ok: boolean; reason?: string }> {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: "Invalid id." };
  try {
    const existing = await pool.query<{ slug: string }>(
      "SELECT slug FROM ai_kb_creators WHERE id = $1",
      [id],
    );
    if (existing.rows.length === 0) {
      return { ok: false, reason: "not found" };
    }
    if (existing.rows[0].slug === "manual") {
      return { ok: false, reason: "protected" };
    }
    const entryCountResult = await pool.query<{ cnt: string }>(
      "SELECT COUNT(*)::bigint AS cnt FROM ai_kb_entries WHERE creator_id = $1",
      [id],
    );
    const entryCount = Number(entryCountResult.rows[0].cnt) || 0;
    if (entryCount > 0) {
      return { ok: false, reason: "has entries" };
    }
    await pool.query("DELETE FROM ai_kb_creators WHERE id = $1", [id]);
    logger.info({ id }, "KB creators: deleted creator");
    return { ok: true };
  } catch (err) {
    logger.error({ err, id }, "KB creators: delete failed");
    return { ok: false, reason: "db error" };
  }
}

// ─── incrementEntryCount / decrementEntryCount ──────────────────────────────
/**
 * Maintains the denormalized `entry_count` on ai_kb_creators. Called by
 * kbEntries.ts when entries are created / deleted. We use a +1 / -1
 * UPDATE (not a full recompute) for O(1) cost. The count is allowed to
 * go negative if the data is inconsistent (a deleted entry that wasn't
 * counted when created) — the admin list view shows the raw number, and
 // a recompute endpoint can fix it later if needed.
 *
 * These are best-effort: a failure to update the count does NOT fail
 * the entry creation/deletion (the entry itself is the source of truth;
 // the count is a denormalized cache for fast listing).
 */
export async function incrementEntryCount(creatorId: number): Promise<void> {
  if (!Number.isInteger(creatorId) || creatorId <= 0) return;
  try {
    await pool.query(
      "UPDATE ai_kb_creators SET entry_count = entry_count + 1, updated_at = NOW() WHERE id = $1",
      [creatorId],
    );
  } catch (err) {
    logger.warn({ err, creatorId }, "KB creators: incrementEntryCount failed (non-fatal)");
  }
}

export async function decrementEntryCount(creatorId: number): Promise<void> {
  if (!Number.isInteger(creatorId) || creatorId <= 0) return;
  try {
    await pool.query(
      "UPDATE ai_kb_creators SET entry_count = GREATEST(entry_count - 1, 0), updated_at = NOW() WHERE id = $1",
      [creatorId],
    );
  } catch (err) {
    logger.warn({ err, creatorId }, "KB creators: decrementEntryCount failed (non-fatal)");
  }
}
