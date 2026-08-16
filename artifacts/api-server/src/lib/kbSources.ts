/**
 * KB source management (Phase 2).
 *
 * A "source" is one piece of raw ingested content — a YouTube transcript,
 * a blog post, or manually typed text. Sources are the input to the
 * chunking pipeline: the admin creates a source (with `rawText`), then
 * either AI-chunks it (English only) or manually creates entries from it.
 *
 * Lifecycle:
 *   pending → chunking → embedding → ready
 *                  ↓        ↓
 *               failed   failed
 *
 * The `processingStatus` field tracks where a source is in the pipeline.
 * Phase 2 updates it via `updateProcessingStatus`:
 *   - createKbSource           → 'pending'
 *   - chunking endpoint hit    → 'chunking' (then back to 'pending' if
 *                                 chunking fails, or 'embedding' if the
 *                                 admin creates entries from the chunks)
 *   - entries batch-created    → 'embedding' (entries are pending embedding)
 *   - background job finishes  → 'ready' (when all entries have embeddings)
 *   - any step fails           → 'failed' (with chunking_error set)
 *
 * Dedup: `source_url` has a partial UNIQUE index (NULLs allowed). We
 * check up-front in `createKbSource` for a better error message than
 * the raw PG unique-violation.
 *
 * Admin endpoints (in routes/aiAdmin.ts):
 *   GET    /api/ai/admin/kb/sources
 *   GET    /api/ai/admin/kb/sources/:id
 *   POST   /api/ai/admin/kb/sources
 *   PUT    /api/ai/admin/kb/sources/:id   (metadata only — NOT rawText)
 *   DELETE /api/ai/admin/kb/sources/:id   (CASCADE deletes entries)
 *   POST   /api/ai/admin/kb/sources/:id/chunk
 *   POST   /api/ai/admin/kb/sources/:id/entries/batch
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import type { KbCreator } from "./kbCreators";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KbSource {
  id: number;
  creatorId: number | null;
  sourceType: string; // youtube | blog | facebook | manual
  sourceUrl: string | null;
  sourceTitle: string;
  sourceLanguage: string; // en | bn | banglish
  sourcePublishedAt: Date | null;
  rawText: string;
  rawMetadata: string | null;
  processingStatus: string; // pending | chunking | embedding | ready | failed
  chunkingMethod: string | null; // ai | manual
  chunkingModel: string | null;
  chunkedAt: Date | null;
  chunkingError: string | null;
  entryCount: number; // denormalized
  createdAt: Date;
}

export interface KbEntry {
  id: number;
  sourceId: number;
  creatorId: number | null;
  categoryId: number | null;
  productId: number | null;
  title: string;
  content: string;
  contentSummary: string | null;
  keywords: string[];
  chunkIndex: number;
  chunkStartOffset: number | null;
  chunkEndOffset: number | null;
  priority: number;
  isActive: boolean;
  versionNumber: number;
  embeddingStatus: string; // pending | generated | failed
  embeddingError: string | null;
  embeddingGeneratedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KbSourceWithEntries extends KbSource {
  entries: KbEntry[];
  creator: KbCreator | null;
}

// ─── Validation constants ────────────────────────────────────────────────────

export const SOURCE_TITLE_MAX_LENGTH = 200;
export const SOURCE_URL_MAX_LENGTH = 500;
export const RAW_TEXT_MAX_LENGTH = 100_000; // ~100KB — handles long transcripts
export const VALID_LANGUAGES = ["en", "bn", "banglish"] as const;
export type SourceLanguage = (typeof VALID_LANGUAGES)[number];

// ─── Row mapping ─────────────────────────────────────────────────────────────

interface KbSourceRow {
  id: number;
  creator_id: number | null;
  source_type: string;
  source_url: string | null;
  source_title: string;
  source_language: string;
  source_published_at: Date | null;
  raw_text: string;
  raw_metadata: string | null;
  processing_status: string;
  chunking_method: string | null;
  chunking_model: string | null;
  chunked_at: Date | null;
  chunking_error: string | null;
  entry_count: string;
  created_at: Date;
}

function mapRow(row: KbSourceRow): KbSource {
  return {
    id: row.id,
    creatorId: row.creator_id,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    sourceLanguage: row.source_language,
    sourcePublishedAt: row.source_published_at,
    rawText: row.raw_text,
    rawMetadata: row.raw_metadata,
    processingStatus: row.processing_status,
    chunkingMethod: row.chunking_method,
    chunkingModel: row.chunking_model,
    chunkedAt: row.chunked_at,
    chunkingError: row.chunking_error,
    entryCount: Number(row.entry_count) || 0,
    createdAt: row.created_at,
  };
}

// ─── listKbSources ───────────────────────────────────────────────────────────
/**
 * Lists sources with optional filters + pagination. Returns `{ sources, total }`
 * so the admin UI can show "Showing 1-20 of 47".
 *
 * Filters:
 *   - creatorId       — only sources by this creator
 *   - language        — en | bn | banglish
 *   - processingStatus — pending | chunking | embedding | ready | failed
 *   - limit (default 20, max 100)
 *   - offset (default 0)
 */
export async function listKbSources(filters?: {
  creatorId?: number;
  language?: string;
  processingStatus?: string;
  limit?: number;
  offset?: number;
}): Promise<{ sources: KbSource[]; total: number }> {
  const limit = Math.min(Math.max(filters?.limit ?? 20, 1), 100);
  const offset = Math.max(filters?.offset ?? 0, 0);

  const whereClauses: string[] = [];
  const values: (string | number)[] = [];
  let paramIdx = 1;
  if (filters?.creatorId !== undefined && Number.isInteger(filters.creatorId)) {
    whereClauses.push(`s.creator_id = $${paramIdx++}`);
    values.push(filters.creatorId);
  }
  if (filters?.language) {
    whereClauses.push(`s.source_language = $${paramIdx++}`);
    values.push(filters.language);
  }
  if (filters?.processingStatus) {
    whereClauses.push(`s.processing_status = $${paramIdx++}`);
    values.push(filters.processingStatus);
  }
  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  try {
    // Count query (without LIMIT/OFFSET).
    const countResult = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::bigint AS cnt FROM ai_kb_sources s ${whereSql}`,
      values,
    );
    const total = Number(countResult.rows[0].cnt) || 0;

    // Data query (with LIMIT/OFFSET). The LEFT JOIN computes the
    // denormalized entry_count per source.
    const dataResult = await pool.query<KbSourceRow>(
      `SELECT s.id, s.creator_id, s.source_type, s.source_url, s.source_title,
              s.source_language, s.source_published_at, s.raw_text, s.raw_metadata,
              s.processing_status, s.chunking_method, s.chunking_model,
              s.chunked_at, s.chunking_error, s.created_at,
              COALESCE(e.cnt, 0)::bigint AS entry_count
       FROM ai_kb_sources s
       LEFT JOIN (
         SELECT source_id, COUNT(*)::bigint AS cnt
         FROM ai_kb_entries
         GROUP BY source_id
       ) e ON e.source_id = s.id
       ${whereSql}
       ORDER BY s.created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...values, limit, offset],
    );
    return { sources: dataResult.rows.map(mapRow), total };
  } catch (err) {
    logger.error({ err, filters }, "KB sources: list failed");
    return { sources: [], total: 0 };
  }
}

// ─── getKbSource ─────────────────────────────────────────────────────────────
/**
 * Returns a single source by id, including its entries + creator info.
 * Used by the source detail view in the admin UI.
 */
export async function getKbSource(id: number): Promise<KbSourceWithEntries | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const sourceResult = await pool.query<KbSourceRow>(
      `SELECT s.id, s.creator_id, s.source_type, s.source_url, s.source_title,
              s.source_language, s.source_published_at, s.raw_text, s.raw_metadata,
              s.processing_status, s.chunking_method, s.chunking_model,
              s.chunked_at, s.chunking_error, s.created_at,
              COALESCE(e.cnt, 0)::bigint AS entry_count
       FROM ai_kb_sources s
       LEFT JOIN (
         SELECT source_id, COUNT(*)::bigint AS cnt
         FROM ai_kb_entries
         WHERE source_id = $1
         GROUP BY source_id
       ) e ON e.source_id = s.id
       WHERE s.id = $1
       LIMIT 1`,
      [id],
    );
    if (sourceResult.rows.length === 0) return null;
    const source = mapRow(sourceResult.rows[0]);

    // Fetch the entries (ordered by chunk_index for stable display).
    const entriesResult = await pool.query(
      `SELECT id, source_id, creator_id, category_id, product_id, title, content,
              content_summary, keywords, chunk_index, chunk_start_offset,
              chunk_end_offset, priority, is_active, version_number,
              embedding_status, embedding_error, embedding_generated_at,
              created_by, created_at, updated_at
       FROM ai_kb_entries
       WHERE source_id = $1
       ORDER BY chunk_index ASC, id ASC`,
      [id],
    );
    const entries = entriesResult.rows as unknown as KbEntry[];

    // Fetch the creator (if set).
    let creator: KbCreator | null = null;
    if (source.creatorId) {
      const { getKbCreator } = await import("./kbCreators");
      creator = await getKbCreator(source.creatorId);
    }

    return { ...source, entries, creator };
  } catch (err) {
    logger.error({ err, id }, "KB sources: get failed");
    return null;
  }
}

// ─── createKbSource ──────────────────────────────────────────────────────────
/**
 * Creates a new source. The `rawText` is required (the content to be
 * chunked later). `sourceUrl` is optional but UNIQUE when provided —
 * we dedup by URL so the same YouTube video / blog post can't be
 * uploaded twice.
 *
 * Returns null on validation failure, URL conflict, or DB error.
 */
export async function createKbSource(params: {
  creatorId?: number | null;
  sourceType: string;
  sourceUrl?: string | null;
  sourceTitle: string;
  sourceLanguage: string;
  sourcePublishedAt?: Date | null;
  rawText: string;
  /**
   * Optional structured metadata to persist alongside the raw text.
   *
   * Stored in the `raw_metadata` column as a JSON string. The schema
   * (lib/db/src/schema/aiChat.ts → ai_kb_sources.raw_metadata) defines
   * the column as TEXT (jsonb-as-text) — we JSON.stringify here and the
   * reader (mapRow) leaves it as a string for callers to parse.
   *
   * Used by the YouTube auto-fetch flow to persist the video's thumbnail
   * URL, channel URL, duration, view count, and detected caption language
   * — so the admin UI can render the thumbnail + deep-link to the channel
   * without re-fetching from YouTube.
   *
   * For manual/blog/facebook sources, this is left undefined (the column
   * stays NULL) — those source types have no structured metadata to store.
   */
  rawMetadata?: Record<string, unknown> | null;
}): Promise<KbSource | null> {
  const sourceTitle = params.sourceTitle?.trim() ?? "";
  const sourceType = params.sourceType;
  const sourceLanguage = params.sourceLanguage;
  const sourceUrl = params.sourceUrl?.trim() || null;
  const rawText = params.rawText ?? "";
  const creatorId = params.creatorId ?? null;
  // Stringify metadata if provided. Null/undefined → NULL in DB (the
  // column is nullable). We cap the JSON length to prevent pathological
  // inputs — 16KB is more than enough for any reasonable metadata payload
  // (the YouTube metadata object is ~500 bytes).
  const rawMetadataJson =
    params.rawMetadata != null ? JSON.stringify(params.rawMetadata).slice(0, 16_384) : null;

  // Validate sourceTitle.
  if (!sourceTitle || sourceTitle.length > SOURCE_TITLE_MAX_LENGTH) {
    logger.warn({ titleLen: sourceTitle.length }, "KB sources: create failed — invalid title");
    return null;
  }
  // Validate sourceType (delegate to kbCreators' validation — same set).
  const { VALID_SOURCE_TYPES } = await import("./kbCreators");
  if (!VALID_SOURCE_TYPES.includes(sourceType as never)) {
    logger.warn({ sourceType }, "KB sources: create failed — invalid sourceType");
    return null;
  }
  // Validate sourceLanguage.
  if (!VALID_LANGUAGES.includes(sourceLanguage as SourceLanguage)) {
    logger.warn({ sourceLanguage }, "KB sources: create failed — invalid language");
    return null;
  }
  // Validate sourceUrl (optional — must be a URL if provided).
  if (sourceUrl) {
    if (sourceUrl.length > SOURCE_URL_MAX_LENGTH) {
      logger.warn({ urlLen: sourceUrl.length }, "KB sources: create failed — URL too long");
      return null;
    }
    try {
      new URL(sourceUrl);
    } catch {
      logger.warn({ sourceUrl }, "KB sources: create failed — invalid URL");
      return null;
    }
  }
  // Validate rawText.
  if (!rawText) {
    logger.warn("KB sources: create failed — empty rawText");
    return null;
  }
  if (rawText.length > RAW_TEXT_MAX_LENGTH) {
    logger.warn({ textLen: rawText.length }, "KB sources: create failed — rawText too long");
    return null;
  }
  // Validate creatorId (optional — must exist if provided).
  if (creatorId !== null) {
    if (!Number.isInteger(creatorId) || creatorId <= 0) {
      logger.warn({ creatorId }, "KB sources: create failed — invalid creatorId");
      return null;
    }
    const { getKbCreator } = await import("./kbCreators");
    const creator = await getKbCreator(creatorId);
    if (!creator) {
      logger.warn({ creatorId }, "KB sources: create failed — creator not found");
      return null;
    }
  }

  // Dedup check on sourceUrl (only if provided).
  if (sourceUrl) {
    try {
      const dup = await pool.query<{ id: number }>(
        "SELECT id FROM ai_kb_sources WHERE source_url = $1 LIMIT 1",
        [sourceUrl],
      );
      if (dup.rows.length > 0) {
        logger.warn(
          { sourceUrl, existingId: dup.rows[0].id },
          "KB sources: create failed — duplicate URL",
        );
        return null;
      }
    } catch (err) {
      logger.error({ err, sourceUrl }, "KB sources: dedup check failed");
      return null;
    }
  }

  try {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO ai_kb_sources
         (creator_id, source_type, source_url, source_title, source_language,
          source_published_at, raw_text, raw_metadata, processing_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       RETURNING id`,
      [
        creatorId,
        sourceType,
        sourceUrl,
        sourceTitle,
        sourceLanguage,
        params.sourcePublishedAt ?? null,
        rawText,
        rawMetadataJson,
      ],
    );
    const newId = result.rows[0].id;
    // Re-fetch with the denormalized entry_count (will be 0).
    const fetched = await getKbSource(newId);
    if (fetched) {
      const { entries: _entries, creator: _creator, ...sourceOnly } = fetched;
      return sourceOnly;
    }
    // Fallback: return a minimal object (shouldn't happen).
    logger.warn({ newId }, "KB sources: created but failed to re-fetch");
    return null;
  } catch (err) {
    logger.error({ err, sourceTitle, sourceType }, "KB sources: create failed");
    return null;
  }
}

// ─── updateKbSource ──────────────────────────────────────────────────────────
/**
 * Updates a source's metadata. Does NOT update `rawText` — changing the
 * raw text would invalidate all existing chunks (they were derived from
 * the old text). The admin must delete the source + re-create it to
 * change the raw text. (A future enhancement could add a "re-chunk"
 * endpoint that clears entries + re-runs chunking.)
 */
export async function updateKbSource(
  id: number,
  updates: {
    sourceTitle?: string;
    sourceUrl?: string | null;
    creatorId?: number | null;
    sourcePublishedAt?: Date | null;
  },
): Promise<KbSource | null> {
  if (!Number.isInteger(id) || id <= 0) return null;

  const sourceTitle = updates.sourceTitle?.trim();
  if (sourceTitle !== undefined && (!sourceTitle || sourceTitle.length > SOURCE_TITLE_MAX_LENGTH)) {
    logger.warn({ id, titleLen: sourceTitle?.length }, "KB sources: update failed — invalid title");
    return null;
  }
  let sourceUrl: string | null | undefined;
  if (updates.sourceUrl !== undefined) {
    sourceUrl = updates.sourceUrl?.trim() || null;
    if (sourceUrl) {
      if (sourceUrl.length > SOURCE_URL_MAX_LENGTH) {
        logger.warn({ id, urlLen: sourceUrl.length }, "KB sources: update failed — URL too long");
        return null;
      }
      try {
        new URL(sourceUrl);
      } catch {
        logger.warn({ id, sourceUrl }, "KB sources: update failed — invalid URL");
        return null;
      }
    }
  }
  if (updates.creatorId !== undefined && updates.creatorId !== null) {
    if (!Number.isInteger(updates.creatorId) || updates.creatorId <= 0) {
      logger.warn(
        { id, creatorId: updates.creatorId },
        "KB sources: update failed — invalid creatorId",
      );
      return null;
    }
  }

  try {
    const setClauses: string[] = [];
    const values: (string | number | Date | null)[] = [];
    let paramIdx = 1;
    if (sourceTitle !== undefined) {
      setClauses.push(`source_title = $${paramIdx++}`);
      values.push(sourceTitle);
    }
    if (sourceUrl !== undefined) {
      setClauses.push(`source_url = $${paramIdx++}`);
      values.push(sourceUrl);
    }
    if (updates.creatorId !== undefined) {
      setClauses.push(`creator_id = $${paramIdx++}`);
      values.push(updates.creatorId);
    }
    if (updates.sourcePublishedAt !== undefined) {
      setClauses.push(`source_published_at = $${paramIdx++}`);
      values.push(updates.sourcePublishedAt);
    }
    if (setClauses.length === 0) {
      logger.warn({ id }, "KB sources: update failed — no fields to update");
      return null;
    }
    values.push(id.toString());
    await pool.query(
      `UPDATE ai_kb_sources SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
      values,
    );
    const fetched = await getKbSource(id);
    if (fetched) {
      const { entries: _entries, creator: _creator, ...sourceOnly } = fetched;
      return sourceOnly;
    }
    return null;
  } catch (err) {
    logger.error({ err, id, updates }, "KB sources: update failed");
    return null;
  }
}

// ─── deleteKbSource ──────────────────────────────────────────────────────────
/**
 * Deletes a source. CASCADE removes all its entries (the FK is ON DELETE
 * CASCADE). Also decrements the creator's entry_count for each entry
 * being deleted (best-effort — if the count drifts, a recompute endpoint
 * can fix it later).
 *
 * Returns true on success, false on not-found or DB error.
 */
export async function deleteKbSource(id: number): Promise<boolean> {
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    // First, decrement the creator's entry_count for each entry being
    // deleted. We do this BEFORE the CASCADE delete so we can still see
    // the entries' creator_id values.
    const entries = await pool.query<{ creator_id: number | null }>(
      "SELECT creator_id FROM ai_kb_entries WHERE source_id = $1 AND creator_id IS NOT NULL",
      [id],
    );
    // Group by creator_id + decrement in one UPDATE per creator.
    const creatorCounts = new Map<number, number>();
    for (const row of entries.rows) {
      if (row.creator_id !== null) {
        creatorCounts.set(row.creator_id, (creatorCounts.get(row.creator_id) ?? 0) + 1);
      }
    }
    const { decrementEntryCount } = await import("./kbCreators");
    for (const [creatorId, count] of creatorCounts) {
      for (let i = 0; i < count; i++) {
        await decrementEntryCount(creatorId);
      }
    }

    const result = await pool.query("DELETE FROM ai_kb_sources WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    logger.error({ err, id }, "KB sources: delete failed");
    return false;
  }
}

// ─── updateProcessingStatus ─────────────────────────────────────────────────
/**
 * Updates a source's `processing_status` (and optionally `chunking_error`).
 * Called by the chunking endpoint + the entry-batch-create endpoint + the
 * background embedding job.
 */
export async function updateProcessingStatus(
  id: number,
  status: string,
  error?: string | null,
): Promise<void> {
  if (!Number.isInteger(id) || id <= 0) return;
  try {
    if (error !== undefined) {
      await pool.query(
        "UPDATE ai_kb_sources SET processing_status = $1, chunking_error = $2 WHERE id = $3",
        [status, error, id],
      );
    } else {
      await pool.query("UPDATE ai_kb_sources SET processing_status = $1 WHERE id = $2", [
        status,
        id,
      ]);
    }
  } catch (err) {
    logger.error({ err, id, status }, "KB sources: updateProcessingStatus failed");
  }
}

// ─── updateChunkingMetadata ─────────────────────────────────────────────────
/**
 * Records how a source was chunked (AI vs manual, which model, when).
 * Called by the chunking endpoint after a successful AI chunk, or by
 * the entry-batch-create endpoint for manual chunking.
 */
export async function updateChunkingMetadata(
  id: number,
  method: string,
  model: string | null,
): Promise<void> {
  if (!Number.isInteger(id) || id <= 0) return;
  try {
    await pool.query(
      `UPDATE ai_kb_sources
         SET chunking_method = $1, chunking_model = $2, chunked_at = NOW(),
             chunking_error = NULL
       WHERE id = $3`,
      [method, model, id],
    );
  } catch (err) {
    logger.error({ err, id, method, model }, "KB sources: updateChunkingMetadata failed");
  }
}

// ─── markSourceReadyIfAllEntriesEmbedded ────────────────────────────────────
/**
 * Checks if all entries for a source have embeddings (generated or failed).
 * If so, marks the source's `processing_status` as 'ready'. Called by
 * the background embedding job after each batch.
 *
 * We consider 'failed' entries as "done" for source-status purposes —
 * the source is 'ready' (the admin can review failed entries + retry
 * individually). A source with zero entries is also 'ready' (nothing
 * to embed).
 */
export async function markSourceReadyIfAllEntriesEmbedded(sourceId: number): Promise<void> {
  if (!Number.isInteger(sourceId) || sourceId <= 0) return;
  try {
    const result = await pool.query<{ pending: string }>(
      `SELECT COUNT(*)::bigint AS pending
       FROM ai_kb_entries
       WHERE source_id = $1 AND embedding_status = 'pending'`,
      [sourceId],
    );
    const pending = Number(result.rows[0].pending) || 0;
    if (pending === 0) {
      await pool.query(
        "UPDATE ai_kb_sources SET processing_status = 'ready' WHERE id = $1 AND processing_status != 'ready'",
        [sourceId],
      );
    }
  } catch (err) {
    logger.error({ err, sourceId }, "KB sources: markReadyIfAllEmbedded failed");
  }
}
