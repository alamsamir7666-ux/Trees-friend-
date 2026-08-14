/**
 * KB entry management (Phase 2).
 *
 * Entries are the searchable chunks the AI's `search_knowledge_base` tool
 * (Phase 3) will return. Each entry belongs to exactly one source (the
 * raw text it was chunked from) + optionally a category, creator, and
 * product. Entries are the smallest unit of KB content — Phase 3 will
 * embed the user's query + find the most similar entries via pgvector.
 *
 * Lifecycle:
 *   - Created (manual or AI-chunked) with `is_active = false` for ingested
 *     content, `is_active = true` for manually-created content.
 *   - Background job generates the embedding (sets `embedding_status`).
 *   - Admin reviews + activates (`is_active = true`).
 *   - On content change: embedding is cleared (status → 'pending') so the
 *     background job regenerates it. Stale embeddings would return wrong
 *     results in semantic search.
 *
 * Content change detection (the key Phase 2 invariant):
 *   When `updateEntry` is called with a `content` field that differs from
 *   the current value, we:
 *     1. Set `embedding = NULL`
 *     2. Set `embedding_status = 'pending'`
 *     3. Set `embedding_error = NULL`
 *     4. Set `embedding_generated_at = NULL`
 *   This triggers the background job to regenerate the embedding on its
 *   next run. The admin doesn't need to manually trigger regeneration.
 *
 * Admin endpoints (in routes/aiAdmin.ts):
 *   GET    /api/ai/admin/kb/entries
 *   GET    /api/ai/admin/kb/entries/:id
 *   POST   /api/ai/admin/kb/entries                  (manual create)
 *   POST   /api/ai/admin/kb/sources/:id/entries/batch (from reviewed chunks)
 *   PUT    /api/ai/admin/kb/entries/:id
 *   POST   /api/ai/admin/kb/entries/:id/activate
 *   POST   /api/ai/admin/kb/entries/:id/deactivate
 *   DELETE /api/ai/admin/kb/entries/:id
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { incrementEntryCount, decrementEntryCount } from "./kbCreators";
import type { KbEntry as KbEntryType } from "./kbSources";

// Re-export the entry type from kbSources (it's defined there because
// KbSourceWithEntries needs it). This keeps the type in one place.
export type KbEntry = KbEntryType;

// ─── Validation constants ────────────────────────────────────────────────────

export const ENTRY_TITLE_MAX_LENGTH = 200;
export const ENTRY_CONTENT_MAX_LENGTH = 50_000;
export const ENTRY_KEYWORD_MAX_COUNT = 10;
export const ENTRY_KEYWORD_MAX_LENGTH = 50;
export const ENTRY_PRIORITY_MIN = 0;
export const ENTRY_PRIORITY_MAX = 10;

// ─── Row mapping ─────────────────────────────────────────────────────────────

interface KbEntryRow {
  id: number;
  source_id: number;
  creator_id: number | null;
  category_id: number | null;
  product_id: number | null;
  title: string;
  content: string;
  content_summary: string | null;
  keywords: string[];
  chunk_index: number;
  chunk_start_offset: number | null;
  chunk_end_offset: number | null;
  priority: number;
  is_active: boolean;
  version_number: number;
  embedding_status: string;
  embedding_error: string | null;
  embedding_generated_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: KbEntryRow): KbEntry {
  return {
    id: row.id,
    sourceId: row.source_id,
    creatorId: row.creator_id,
    categoryId: row.category_id,
    productId: row.product_id,
    title: row.title,
    content: row.content,
    contentSummary: row.content_summary,
    keywords: row.keywords ?? [],
    chunkIndex: row.chunk_index,
    chunkStartOffset: row.chunk_start_offset,
    chunkEndOffset: row.chunk_end_offset,
    priority: row.priority,
    isActive: row.is_active,
    versionNumber: row.version_number,
    embeddingStatus: row.embedding_status,
    embeddingError: row.embedding_error,
    embeddingGeneratedAt: row.embedding_generated_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── listKbEntries ───────────────────────────────────────────────────────────
/**
 * Lists entries with optional filters + pagination. Returns `{ entries, total }`.
 */
export async function listKbEntries(filters?: {
  sourceId?: number;
  categoryId?: number;
  creatorId?: number;
  productId?: number;
  isActive?: boolean;
  embeddingStatus?: string;
  limit?: number;
  offset?: number;
}): Promise<{ entries: KbEntry[]; total: number }> {
  const limit = Math.min(Math.max(filters?.limit ?? 20, 1), 100);
  const offset = Math.max(filters?.offset ?? 0, 0);

  const whereClauses: string[] = [];
  const values: (string | number | boolean)[] = [];
  let paramIdx = 1;
  if (filters?.sourceId !== undefined && Number.isInteger(filters.sourceId)) {
    whereClauses.push(`source_id = $${paramIdx++}`);
    values.push(filters.sourceId);
  }
  if (filters?.categoryId !== undefined && Number.isInteger(filters.categoryId)) {
    whereClauses.push(`category_id = $${paramIdx++}`);
    values.push(filters.categoryId);
  }
  if (filters?.creatorId !== undefined && Number.isInteger(filters.creatorId)) {
    whereClauses.push(`creator_id = $${paramIdx++}`);
    values.push(filters.creatorId);
  }
  if (filters?.productId !== undefined && Number.isInteger(filters.productId)) {
    whereClauses.push(`product_id = $${paramIdx++}`);
    values.push(filters.productId);
  }
  if (filters?.isActive !== undefined) {
    whereClauses.push(`is_active = $${paramIdx++}`);
    values.push(filters.isActive);
  }
  if (filters?.embeddingStatus) {
    whereClauses.push(`embedding_status = $${paramIdx++}`);
    values.push(filters.embeddingStatus);
  }
  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  try {
    const countResult = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::bigint AS cnt FROM ai_kb_entries ${whereSql}`,
      values,
    );
    const total = Number(countResult.rows[0].cnt) || 0;

    const dataResult = await pool.query<KbEntryRow>(
      `SELECT id, source_id, creator_id, category_id, product_id, title, content,
              content_summary, keywords, chunk_index, chunk_start_offset,
              chunk_end_offset, priority, is_active, version_number,
              embedding_status, embedding_error, embedding_generated_at,
              created_by, created_at, updated_at
       FROM ai_kb_entries
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...values, limit, offset],
    );
    return { entries: dataResult.rows.map(mapRow), total };
  } catch (err) {
    logger.error({ err, filters }, "KB entries: list failed");
    return { entries: [], total: 0 };
  }
}

// ─── getKbEntry ──────────────────────────────────────────────────────────────
export async function getKbEntry(id: number): Promise<KbEntry | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const result = await pool.query<KbEntryRow>(
      `SELECT id, source_id, creator_id, category_id, product_id, title, content,
              content_summary, keywords, chunk_index, chunk_start_offset,
              chunk_end_offset, priority, is_active, version_number,
              embedding_status, embedding_error, embedding_generated_at,
              created_by, created_at, updated_at
       FROM ai_kb_entries
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  } catch (err) {
    logger.error({ err, id }, "KB entries: get failed");
    return null;
  }
}

// ─── createEntry ─────────────────────────────────────────────────────────────
/**
 * Creates a single entry. Used by the manual-create flow.
 *
 * Defaults:
 *   - `isActive` = false for ingested content (admin reviews first),
 *     true for manually-created content (the admin typed it intentionally).
 *   - `priority` = 0 (lowest — higher priority entries surface first in
 *     search results).
 *   - `versionNumber` = 1 (incremented on future content changes — not
 *     implemented in Phase 2, reserved for Phase 5 versioning).
 *   - `embeddingStatus` = 'pending' (the background job will embed it).
 *
 * Also increments the creator's denormalized `entry_count` if `creatorId`
 * is set. If `creatorId` is not set but `sourceId` is, we look up the
 * source's `creator_id` and denormalize it onto the entry (saves a JOIN
 * at search time).
 */
export async function createEntry(params: {
  sourceId: number;
  creatorId?: number | null;
  categoryId?: number | null;
  productId?: number | null;
  title: string;
  content: string;
  keywords?: string[];
  chunkIndex?: number;
  chunkStartOffset?: number | null;
  chunkEndOffset?: number | null;
  priority?: number;
  isActive?: boolean;
  createdBy?: string | null;
}): Promise<KbEntry | null> {
  // Validate sourceId.
  if (!Number.isInteger(params.sourceId) || params.sourceId <= 0) {
    logger.warn({ sourceId: params.sourceId }, "KB entries: create failed — invalid sourceId");
    return null;
  }
  const title = params.title?.trim() ?? "";
  if (!title || title.length > ENTRY_TITLE_MAX_LENGTH) {
    logger.warn({ titleLen: title.length }, "KB entries: create failed — invalid title");
    return null;
  }
  const content = params.content ?? "";
  if (!content || content.length > ENTRY_CONTENT_MAX_LENGTH) {
    logger.warn({ contentLen: content.length }, "KB entries: create failed — invalid content");
    return null;
  }
  // Validate keywords.
  const keywords = (params.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  if (keywords.length > ENTRY_KEYWORD_MAX_COUNT) {
    logger.warn({ count: keywords.length }, "KB entries: create failed — too many keywords");
    return null;
  }
  for (const k of keywords) {
    if (k.length > ENTRY_KEYWORD_MAX_LENGTH) {
      logger.warn({ keyword: k }, "KB entries: create failed — keyword too long");
      return null;
    }
  }
  // Validate priority.
  const priority = params.priority ?? 0;
  if (
    !Number.isInteger(priority) ||
    priority < ENTRY_PRIORITY_MIN ||
    priority > ENTRY_PRIORITY_MAX
  ) {
    logger.warn({ priority }, "KB entries: create failed — invalid priority");
    return null;
  }

  try {
    // Look up the source (we need its creator_id for denormalization if
    // params.creatorId isn't provided).
    const sourceResult = await pool.query<{ creator_id: number | null }>(
      "SELECT creator_id FROM ai_kb_sources WHERE id = $1",
      [params.sourceId],
    );
    if (sourceResult.rows.length === 0) {
      logger.warn({ sourceId: params.sourceId }, "KB entries: create failed — source not found");
      return null;
    }
    const creatorId = params.creatorId ?? sourceResult.rows[0].creator_id ?? null;
    const isActive = params.isActive ?? false;

    const result = await pool.query<{ id: number }>(
      `INSERT INTO ai_kb_entries
         (source_id, creator_id, category_id, product_id, title, content,
          keywords, chunk_index, chunk_start_offset, chunk_end_offset,
          priority, is_active, version_number, embedding_status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, 'pending', $13)
       RETURNING id`,
      [
        params.sourceId,
        creatorId,
        params.categoryId ?? null,
        params.productId ?? null,
        title,
        content,
        keywords,
        params.chunkIndex ?? 0,
        params.chunkStartOffset ?? null,
        params.chunkEndOffset ?? null,
        priority,
        isActive,
        params.createdBy ?? null,
      ],
    );
    const newId = result.rows[0].id;
    // Increment the creator's entry_count (best-effort).
    if (creatorId !== null) {
      await incrementEntryCount(creatorId);
    }
    return await getKbEntry(newId);
  } catch (err) {
    logger.error({ err, sourceId: params.sourceId, title }, "KB entries: create failed");
    return null;
  }
}

// ─── createEntriesBatch ──────────────────────────────────────────────────────
/**
 * Bulk-creates entries from the chunk review flow. All entries are
 * created with `is_active = false` (the admin reviews them in the
 * Entries tab before activating). Returns the created entry IDs.
 *
 * Also denormalizes `creator_id` from the source onto each entry, and
 * increments the creator's `entry_count` by the batch size in a single
 * UPDATE (faster than per-entry increments).
 *
 * After the batch is created, the source's `processing_status` is set
 * to 'embedding' (the background job will set it to 'ready' once all
 * entries have embeddings).
 */
export async function createEntriesBatch(
  sourceId: number,
  entries: {
    title: string;
    content: string;
    keywords?: string[];
    categoryId?: number | null;
    productId?: number | null;
    priority?: number;
    chunkIndex?: number;
    chunkStartOffset?: number | null;
    chunkEndOffset?: number | null;
  }[],
  createdBy: string | null = null,
): Promise<number[]> {
  if (!Number.isInteger(sourceId) || sourceId <= 0) return [];
  if (entries.length === 0) return [];

  // Validate all entries up-front so we fail fast on the first bad one.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const title = e.title?.trim() ?? "";
    if (!title || title.length > ENTRY_TITLE_MAX_LENGTH) {
      logger.warn({ i, titleLen: title.length }, "KB entries: batch create failed — invalid title");
      return [];
    }
    const content = e.content ?? "";
    if (!content || content.length > ENTRY_CONTENT_MAX_LENGTH) {
      logger.warn(
        { i, contentLen: content.length },
        "KB entries: batch create failed — invalid content",
      );
      return [];
    }
    const keywords = (e.keywords ?? []).map((k) => k.trim()).filter(Boolean);
    if (keywords.length > ENTRY_KEYWORD_MAX_COUNT) {
      logger.warn(
        { i, count: keywords.length },
        "KB entries: batch create failed — too many keywords",
      );
      return [];
    }
    for (const k of keywords) {
      if (k.length > ENTRY_KEYWORD_MAX_LENGTH) {
        logger.warn({ i, keyword: k }, "KB entries: batch create failed — keyword too long");
        return [];
      }
    }
    const priority = e.priority ?? 0;
    if (
      !Number.isInteger(priority) ||
      priority < ENTRY_PRIORITY_MIN ||
      priority > ENTRY_PRIORITY_MAX
    ) {
      logger.warn({ i, priority }, "KB entries: batch create failed — invalid priority");
      return [];
    }
  }

  try {
    // Look up the source's creator_id for denormalization.
    const sourceResult = await pool.query<{ creator_id: number | null }>(
      "SELECT creator_id FROM ai_kb_sources WHERE id = $1",
      [sourceId],
    );
    if (sourceResult.rows.length === 0) {
      logger.warn({ sourceId }, "KB entries: batch create failed — source not found");
      return [];
    }
    const creatorId = sourceResult.rows[0].creator_id;

    // ─── Transaction: entries + entry_count + source status ──────────────
    //
    // All three writes (entry INSERTs, creator entry_count increment, source
    // processing_status flip) MUST be in ONE transaction. Previously each
    // `pool.query()` call acquired a DIFFERENT connection from the pool, so
    // the `BEGIN`/`COMMIT`/`ROLLBACK` were sent on different connections —
    // the "transaction" was completely non-functional. A partial failure
    // (e.g. one INSERT failing) would leave the already-inserted rows
    // committed with no rollback, AND the source status would never flip
    // to 'embedding'.
    //
    // Fix: acquire a single connection via `pool.connect()` + use
    // `client.query()` for all transaction statements. Release in a
    // `finally` block so the connection is always returned to the pool
    // (even on error — prevents pool exhaustion under failure spikes).
    //
    // We also moved the entry_count increment + source status update INSIDE
    // the transaction. Previously they ran AFTER the (broken) transaction
    // block — if the INSERT loop committed but the status UPDATE failed,
    // the source was stuck in 'chunking' while entries existed. Now the
    // source only flips to 'embedding' if the entries + count committed.
    //
    // The entry_count increment is wrapped in a nested try/catch (non-fatal)
    // because it's a denormalized optimization — a failure shouldn't abort
    // the whole batch. The INSERTs + source status are the source of truth.
    const createdIds: number[] = [];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const keywords = (e.keywords ?? []).map((k) => k.trim()).filter(Boolean);
          const result = await client.query<{ id: number }>(
            `INSERT INTO ai_kb_entries
               (source_id, creator_id, category_id, product_id, title, content,
                keywords, chunk_index, chunk_start_offset, chunk_end_offset,
                priority, is_active, version_number, embedding_status, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, FALSE, 1, 'pending', $12)
             RETURNING id`,
            [
              sourceId,
              creatorId,
              e.categoryId ?? null,
              e.productId ?? null,
              e.title.trim(),
              e.content,
              keywords,
              e.chunkIndex ?? i,
              e.chunkStartOffset ?? null,
              e.chunkEndOffset ?? null,
              e.priority ?? 0,
              createdBy,
            ],
          );
          createdIds.push(result.rows[0].id);
        }

        // Increment the creator's entry_count by the batch size (one UPDATE).
        // Non-fatal: if this fails, the batch still committed — the count
        // is a denormalized optimization, not a correctness invariant.
        if (creatorId !== null && createdIds.length > 0) {
          try {
            await client.query(
              "UPDATE ai_kb_creators SET entry_count = entry_count + $1, updated_at = NOW() WHERE id = $2",
              [createdIds.length, creatorId],
            );
          } catch (err) {
            logger.warn(
              { err, creatorId, count: createdIds.length },
              "KB entries: batch entry_count increment failed (non-fatal, transaction continues)",
            );
          }
        }

        // Update the source's processing_status to 'embedding'.
        await client.query(
          "UPDATE ai_kb_sources SET processing_status = 'embedding' WHERE id = $1",
          [sourceId],
        );

        await client.query("COMMIT");
      } catch (txErr) {
        // Best-effort rollback — swallow rollback errors so the original
        // error isn't masked. The connection is released in `finally`
        // regardless; if the rollback failed, the connection is in an
        // aborted state and `release()` will return it to the pool broken
        // (pg.Pool handles this by closing it).
        try {
          await client.query("ROLLBACK");
        } catch (rbErr) {
          logger.warn(
            { err: (rbErr as Error)?.message },
            "KB entries: batch rollback failed (non-fatal — connection will be recycled)",
          );
        }
        throw txErr;
      }

      logger.info({ sourceId, count: createdIds.length, creatorId }, "KB entries: batch created");
      return createdIds;
    } finally {
      // ALWAYS release the connection — prevents pool exhaustion under
      // error spikes. `release()` is safe to call even if the connection
      // is in an error state (pg.Pool will close + recycle it).
      client.release();
    }
  } catch (err) {
    logger.error({ err, sourceId, count: entries.length }, "KB entries: batch create failed");
    return [];
  }
}

// ─── updateEntry ─────────────────────────────────────────────────────────────
/**
 * Updates an entry. If `content` changes, the embedding is cleared
 * (status → 'pending') so the background job regenerates it. This is
 * the key Phase 2 invariant: stale embeddings would return wrong
 * results in semantic search.
 *
 * Returns the updated entry, or null on not-found / validation failure /
 * DB error.
 */
export async function updateEntry(
  id: number,
  updates: {
    title?: string;
    content?: string;
    keywords?: string[];
    categoryId?: number | null;
    productId?: number | null;
    priority?: number;
  },
): Promise<KbEntry | null> {
  if (!Number.isInteger(id) || id <= 0) return null;

  // Validate up-front.
  const title = updates.title?.trim();
  if (title !== undefined && (!title || title.length > ENTRY_TITLE_MAX_LENGTH)) {
    logger.warn({ id, titleLen: title?.length }, "KB entries: update failed — invalid title");
    return null;
  }
  const content = updates.content;
  if (content !== undefined && (!content || content.length > ENTRY_CONTENT_MAX_LENGTH)) {
    logger.warn({ id, contentLen: content.length }, "KB entries: update failed — invalid content");
    return null;
  }
  let keywords: string[] | undefined;
  if (updates.keywords !== undefined) {
    keywords = updates.keywords.map((k) => k.trim()).filter(Boolean);
    if (keywords.length > ENTRY_KEYWORD_MAX_COUNT) {
      logger.warn({ id, count: keywords.length }, "KB entries: update failed — too many keywords");
      return null;
    }
    for (const k of keywords) {
      if (k.length > ENTRY_KEYWORD_MAX_LENGTH) {
        logger.warn({ id, keyword: k }, "KB entries: update failed — keyword too long");
        return null;
      }
    }
  }
  if (updates.priority !== undefined) {
    if (
      !Number.isInteger(updates.priority) ||
      updates.priority < ENTRY_PRIORITY_MIN ||
      updates.priority > ENTRY_PRIORITY_MAX
    ) {
      logger.warn(
        { id, priority: updates.priority },
        "KB entries: update failed — invalid priority",
      );
      return null;
    }
  }

  try {
    // Fetch the current content (we need to detect changes for embedding reset).
    const current = await pool.query<{ content: string }>(
      "SELECT content FROM ai_kb_entries WHERE id = $1",
      [id],
    );
    if (current.rows.length === 0) {
      logger.warn({ id }, "KB entries: update failed — not found");
      return null;
    }
    const contentChanged = content !== undefined && content !== current.rows[0].content;

    const setClauses: string[] = ["updated_at = NOW()"];
    const values: (string | number | null | string[])[] = [];
    let paramIdx = 1;
    if (title !== undefined) {
      setClauses.push(`title = $${paramIdx++}`);
      values.push(title);
    }
    if (content !== undefined) {
      setClauses.push(`content = $${paramIdx++}`);
      values.push(content);
    }
    if (keywords !== undefined) {
      setClauses.push(`keywords = $${paramIdx++}`);
      values.push(keywords);
    }
    if (updates.categoryId !== undefined) {
      setClauses.push(`category_id = $${paramIdx++}`);
      values.push(updates.categoryId);
    }
    if (updates.productId !== undefined) {
      setClauses.push(`product_id = $${paramIdx++}`);
      values.push(updates.productId);
    }
    if (updates.priority !== undefined) {
      setClauses.push(`priority = $${paramIdx++}`);
      values.push(updates.priority);
    }
    // If content changed, clear the embedding so the background job regenerates it.
    if (contentChanged) {
      setClauses.push("embedding = NULL");
      setClauses.push("embedding_status = 'pending'");
      setClauses.push("embedding_error = NULL");
      setClauses.push("embedding_generated_at = NULL");
    }
    values.push(id.toString());

    await pool.query(
      `UPDATE ai_kb_entries SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
      values,
    );
    return await getKbEntry(id);
  } catch (err) {
    logger.error({ err, id, updates }, "KB entries: update failed");
    return null;
  }
}

// ─── activateEntry / deactivateEntry ────────────────────────────────────────
/**
 * Toggles an entry's `is_active` flag. Only active entries are returned
 * by the Phase 3 search tool. Inactive entries are still stored (the
 * admin can re-activate them later).
 *
 * Returns true on success, false on not-found or DB error.
 */
export async function activateEntry(id: number): Promise<boolean> {
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    const result = await pool.query(
      "UPDATE ai_kb_entries SET is_active = TRUE, updated_at = NOW() WHERE id = $1",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    logger.error({ err, id }, "KB entries: activate failed");
    return false;
  }
}

export async function deactivateEntry(id: number): Promise<boolean> {
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    const result = await pool.query(
      "UPDATE ai_kb_entries SET is_active = FALSE, updated_at = NOW() WHERE id = $1",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    logger.error({ err, id }, "KB entries: deactivate failed");
    return false;
  }
}

// ─── deleteEntry ─────────────────────────────────────────────────────────────
/**
 * Deletes an entry. Also decrements the creator's `entry_count`
 * (best-effort). Returns true on success, false on not-found or DB error.
 */
export async function deleteEntry(id: number): Promise<boolean> {
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    // Fetch the creator_id before deleting (so we can decrement).
    const existing = await pool.query<{ creator_id: number | null }>(
      "SELECT creator_id FROM ai_kb_entries WHERE id = $1",
      [id],
    );
    if (existing.rows.length === 0) return false;
    const creatorId = existing.rows[0].creator_id;

    await pool.query("DELETE FROM ai_kb_entries WHERE id = $1", [id]);

    if (creatorId !== null) {
      await decrementEntryCount(creatorId);
    }
    return true;
  } catch (err) {
    logger.error({ err, id }, "KB entries: delete failed");
    return false;
  }
}
