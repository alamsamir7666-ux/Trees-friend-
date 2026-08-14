/**
 * Knowledge Base category management (Phase 1).
 *
 * Industry standard: an N-level category tree backed by an adjacency list
 * (`parent_id`) + a materialized path (`path = '/1/3/7/'`). The adjacency
 * list makes insert/move cheap; the materialized path makes "fetch this
 * subtree" cheap (a single `WHERE path LIKE '/1/3/%'` query, no recursive
 * CTE). We rebuild the path on insert + move so it always reflects the
 * current tree shape.
 *
 * Why not a recursive CTE?
 *   - Postgres recursive CTEs are slow on large trees + require a full
 *     scan per level. The materialized path is a single index range.
 *   - The category tree is small (~200 nodes max for a plant-care KB),
 *     so the path-update cost on move is negligible (a single UPDATE
 *     touching descendants).
 *
 * Path format: `'/<root_id>/.../<self_id>/'`
 *   - Root:    `'/1/'`               (depth 0)
 *   - Child:   `'/1/3/'`             (depth 1)
 *   - Grandchild: `'/1/3/7/'`        (depth 2)
 *
 * The path INCLUDES the row's own id as the last segment. This means
 * changing the slug does NOT require a path update (slug isn't in the
 * path) — only insert + move touch the path.
 *
 * Operations:
 *   - listKbCategories()     flat list, with denormalized entry_count
 *   - getKbCategory(id)      single category
 *   - getKbCategoryTree()    nested tree (for the admin UI)
 *   - createKbCategory()     INSERT + path backfill in a transaction
 *   - updateKbCategory()     UPDATE name/slug/description/isActive
 *                             (cascade-deactivate descendants if isActive→false)
 *   - moveKbCategory()       move to a new parent (rebuilds path for self + descendants)
 *   - deleteKbCategory()     DELETE (rejects if any descendant has entries)
 *
 * Admin endpoints (in routes/aiAdmin.ts):
 *   GET    /api/ai/admin/kb/categories
 *   GET    /api/ai/admin/kb/categories/tree
 *   GET    /api/ai/admin/kb/categories/:id
 *   POST   /api/ai/admin/kb/categories
 *   PUT    /api/ai/admin/kb/categories/:id
 *   POST   /api/ai/admin/kb/categories/:id/move
 *   DELETE /api/ai/admin/kb/categories/:id
 *
 * All functions catch + log their own errors and return `null` / `false`
 * / empty arrays on failure — same pattern as promptVersioning.ts. The
 * route layer maps those return values to HTTP status codes.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KbCategory {
  id: number;
  parentId: number | null;
  name: string;
  slug: string;
  description: string | null;
  path: string;
  depth: number;
  isActive: boolean;
  entryCount: number; // denormalized — count of ai_kb_entries in this category
  createdAt: Date;
  updatedAt: Date;
}

export interface KbCategoryNode extends KbCategory {
  children: KbCategoryNode[];
}

// ─── Validation constants ────────────────────────────────────────────────────

// Slug: lowercase, digits, hyphens only. No leading/trailing hyphens
// (the regex below rejects those). Max 80 chars (matches the DB column
// intent — we don't have a hard DB constraint, but the route validates).
export const SLUG_REGEX = /^[a-z0-9-]+$/;
export const SLUG_MAX_LENGTH = 80;
export const NAME_MAX_LENGTH = 100;
export const DESCRIPTION_MAX_LENGTH = 500;

// ─── Row mapping ─────────────────────────────────────────────────────────────
// The DB returns snake_case columns; we convert to camelCase for the API.

interface KbCategoryRow {
  id: number;
  parent_id: number | null;
  name: string;
  slug: string;
  description: string | null;
  path: string;
  depth: number;
  is_active: boolean;
  entry_count: string; // COUNT() returns string in pg — convert to number
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: KbCategoryRow): KbCategory {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    path: row.path,
    depth: row.depth,
    isActive: row.is_active,
    entryCount: Number(row.entry_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── listKbCategories ────────────────────────────────────────────────────────
/**
 * Returns ALL categories (active + inactive), ordered by `path` ASC so
 * the tree can be reconstructed by the caller without further sorting.
 *
 * Includes a denormalized `entryCount` (LEFT JOIN + COUNT against
 * ai_kb_entries). For Phase 1 the entries table is empty, so every row
 * returns 0 — but the JOIN is in place so Phase 2 needs no changes.
 *
 * Returns an empty array on DB error (same pattern as promptVersioning).
 */
export async function listKbCategories(): Promise<KbCategory[]> {
  try {
    const result = await pool.query<KbCategoryRow>(
      `SELECT
         c.id, c.parent_id, c.name, c.slug, c.description,
         c.path, c.depth, c.is_active, c.created_at, c.updated_at,
         COALESCE(e.cnt, 0)::bigint AS entry_count
       FROM ai_kb_categories c
       LEFT JOIN (
         SELECT category_id, COUNT(*)::bigint AS cnt
         FROM ai_kb_entries
         WHERE category_id IS NOT NULL
         GROUP BY category_id
       ) e ON e.category_id = c.id
       ORDER BY c.path ASC, c.name ASC`,
    );
    return result.rows.map(mapRow);
  } catch (err) {
    logger.error({ err }, "KB categories: list failed");
    return [];
  }
}

// ─── getKbCategory ───────────────────────────────────────────────────────────
/**
 * Returns a single category by id (with denormalized entry_count).
 * Returns null if not found or on DB error.
 */
export async function getKbCategory(id: number): Promise<KbCategory | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const result = await pool.query<KbCategoryRow>(
      `SELECT
         c.id, c.parent_id, c.name, c.slug, c.description,
         c.path, c.depth, c.is_active, c.created_at, c.updated_at,
         COALESCE(e.cnt, 0)::bigint AS entry_count
       FROM ai_kb_categories c
       LEFT JOIN (
         SELECT category_id, COUNT(*)::bigint AS cnt
         FROM ai_kb_entries
         WHERE category_id = $1
         GROUP BY category_id
       ) e ON e.category_id = c.id
       WHERE c.id = $1
       LIMIT 1`,
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  } catch (err) {
    logger.error({ err, id }, "KB categories: get failed");
    return null;
  }
}

// ─── getKbCategoryTree ───────────────────────────────────────────────────────
/**
 * Returns a nested tree structure for the admin UI.
 *
 * Built by fetching all categories (flat) and assembling the tree in
 * Node — not in SQL. Postgres recursive CTEs are overkill for ~200
 * nodes and slower than a single SELECT + in-memory build.
 *
 * Children are sorted by name ASC for stable display. Root nodes (those
 * with parentId = null) appear at the top level, also sorted by name.
 *
 * Returns an empty array if there are no categories or on DB error.
 */
export async function getKbCategoryTree(): Promise<KbCategoryNode[]> {
  const flat = await listKbCategories();
  if (flat.length === 0) return [];

  // Index by id for O(1) parent lookup.
  const byId = new Map<number, KbCategoryNode>();
  for (const cat of flat) {
    byId.set(cat.id, { ...cat, children: [] });
  }

  const roots: KbCategoryNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId === null) {
      roots.push(node);
    } else {
      const parent = byId.get(node.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        // Orphan — parent was deleted but CASCADE didn't catch it
        // (shouldn't happen, but be defensive). Promote to root so the
        // admin can see it + re-parent it.
        logger.warn(
          { categoryId: node.id, parentId: node.parentId },
          "KB categories: orphan node (parent missing) — promoting to root",
        );
        roots.push(node);
      }
    }
  }

  // Sort each level by name for stable display.
  const sortTree = (nodes: KbCategoryNode[]): KbCategoryNode[] => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) sortTree(n.children);
    return nodes;
  };

  return sortTree(roots);
}

// ─── createKbCategory ────────────────────────────────────────────────────────
/**
 * Creates a new category.
 *
 * Path computation: the path includes the NEW row's id, which isn't
 * known until after INSERT. So we:
 *   1. INSERT with a placeholder path (`'/'`).
 *   2. Compute the real path: parent? path = parentPath + id + '/';
 *      root? path = '/' + id + '/'.
 *   3. UPDATE the row's path.
 *
 * Both steps run in a transaction so a failure during step 3 rolls back
 * the INSERT (no orphan rows with placeholder paths).
 *
 * Slug validation: lowercase + digits + hyphens only. We check
 * uniqueness within the parent (matches the DB's UNIQUE(parent_id, slug)
 * constraint, but with a better error message than the DB gives).
 *
 * Returns the created category (with entry_count = 0), or null on:
 *   - Validation failure (bad slug, name too long, etc.)
 *   - Parent not found (if parentId was provided)
 *   - Slug conflict within the parent
 *   - DB error
 */
export async function createKbCategory(params: {
  name: string;
  slug: string;
  description?: string | null;
  parentId?: number | null;
}): Promise<KbCategory | null> {
  const name = params.name?.trim() ?? "";
  const slug = params.slug?.trim() ?? "";
  const description = params.description?.trim() || null;
  const parentId = params.parentId ?? null;

  // Validate name.
  if (!name) {
    logger.warn({ name: params.name }, "KB categories: create failed — empty name");
    return null;
  }
  if (name.length > NAME_MAX_LENGTH) {
    logger.warn({ nameLength: name.length }, "KB categories: create failed — name too long");
    return null;
  }
  // Validate slug.
  if (!slug || !SLUG_REGEX.test(slug) || slug.length > SLUG_MAX_LENGTH) {
    logger.warn({ slug }, "KB categories: create failed — invalid slug");
    return null;
  }
  if (slug.startsWith("-") || slug.endsWith("-")) {
    logger.warn({ slug }, "KB categories: create failed — slug has leading/trailing hyphen");
    return null;
  }
  if (description && description.length > DESCRIPTION_MAX_LENGTH) {
    logger.warn({ descLength: description.length }, "KB categories: create failed — description too long");
    return null;
  }

  try {
    // If a parent was specified, fetch it (we need its path + depth).
    let parentPath = "/";
    let parentDepth = -1;
    if (parentId !== null) {
      const parentResult = await pool.query<{ path: string; depth: number }>(
        "SELECT path, depth FROM ai_kb_categories WHERE id = $1",
        [parentId],
      );
      if (parentResult.rows.length === 0) {
        logger.warn({ parentId }, "KB categories: create failed — parent not found");
        return null;
      }
      parentPath = parentResult.rows[0].path;
      parentDepth = parentResult.rows[0].depth;
    }

    // Check slug uniqueness within the parent. The DB has a
    // UNIQUE(parent_id, slug) constraint, but checking up-front gives a
    // better error + avoids the raw PG error surfacing.
    // For root categories (parent_id IS NULL), Postgres treats NULL
    // parent_ids as distinct in the UNIQUE constraint — so we add an
    // app-level check to keep root slugs globally unique too (otherwise
    // we'd allow two roots with slug "plant-care", which would confuse
    // the admin UI).
    if (parentId === null) {
      const dup = await pool.query(
        "SELECT 1 FROM ai_kb_categories WHERE parent_id IS NULL AND slug = $1 LIMIT 1",
        [slug],
      );
      if (dup.rows.length > 0) {
        logger.warn({ slug }, "KB categories: create failed — root slug conflict");
        return null;
      }
    } else {
      const dup = await pool.query(
        "SELECT 1 FROM ai_kb_categories WHERE parent_id = $1 AND slug = $2 LIMIT 1",
        [parentId, slug],
      );
      if (dup.rows.length > 0) {
        logger.warn({ slug, parentId }, "KB categories: create failed — slug conflict within parent");
        return null;
      }
    }

    // INSERT in a transaction, then UPDATE the path once we know the id.
    // We use BEGIN/COMMIT directly (same pattern as promptVersioning.ts).
    await pool.query("BEGIN");
    let createdId: number | null = null;
    try {
      const insertResult = await pool.query<{ id: number }>(
        `INSERT INTO ai_kb_categories (parent_id, name, slug, description, path, depth, is_active)
         VALUES ($1, $2, $3, $4, '/', $5, TRUE)
         RETURNING id`,
        [parentId, name, slug, description, parentDepth + 1],
      );
      createdId = insertResult.rows[0].id;
      // Compute the real path: parentPath + id + '/' for children,
      // '/' + id + '/' for roots.
      const realPath = parentId === null
        ? `/${createdId}/`
        : `${parentPath}${createdId}/`;
      await pool.query(
        "UPDATE ai_kb_categories SET path = $1 WHERE id = $2",
        [realPath, createdId],
      );
      await pool.query("COMMIT");
    } catch (txErr) {
      await pool.query("ROLLBACK");
      throw txErr;
    }

    // Re-fetch the created row (with entry_count) to return.
    // `createdId` is guaranteed non-null here (the INSERT RETURNING
    // succeeded inside the transaction), but we guard defensively in
    // case the ROLLBACK path left it null.
    if (createdId === null) {
      logger.error({ name, slug, parentId }, "KB categories: create failed — no id returned from INSERT");
      return null;
    }
    return await getKbCategory(createdId);
  } catch (err) {
    logger.error({ err, name, slug, parentId }, "KB categories: create failed");
    return null;
  }
}

// ─── updateKbCategory ────────────────────────────────────────────────────────
/**
 * Updates a category's name, slug, description, and/or isActive flag.
 *
 * Path notes:
 *   - The path is built from ids, NOT slugs. So changing the slug does
 *     NOT require a path update (or a descendant path update). Good.
 *   - Changing the parent is a MOVE, not an update — use moveKbCategory
 *     for that. This function rejects parentId changes.
 *
 * If `isActive` changes TRUE → FALSE, we cascade-deactivate all
 * descendants (set is_active = FALSE on every node whose path is a
 * prefix-extension of this node's path). This prevents the admin from
 * leaving active children under an inactive parent (which would be
 * confusing in the UI + inconsistent in the search tool). We log a
 * warning so the admin can see the cascade in logs.
 *
 * Returns the updated category, or null on:
 *   - Not found
 *   - Validation failure (bad slug, name too long, etc.)
 *   - Slug conflict within the parent
 *   - DB error
 */
export async function updateKbCategory(
  id: number,
  updates: {
    name?: string;
    slug?: string;
    description?: string | null;
    isActive?: boolean;
  },
): Promise<KbCategory | null> {
  if (!Number.isInteger(id) || id <= 0) return null;

  // Validate optional fields up-front so we can fail fast.
  const name = updates.name?.trim();
  if (name !== undefined) {
    if (!name) {
      logger.warn({ id }, "KB categories: update failed — empty name");
      return null;
    }
    if (name.length > NAME_MAX_LENGTH) {
      logger.warn({ id, nameLength: name.length }, "KB categories: update failed — name too long");
      return null;
    }
  }
  const slug = updates.slug?.trim();
  if (slug !== undefined) {
    if (!slug || !SLUG_REGEX.test(slug) || slug.length > SLUG_MAX_LENGTH) {
      logger.warn({ id, slug }, "KB categories: update failed — invalid slug");
      return null;
    }
    if (slug.startsWith("-") || slug.endsWith("-")) {
      logger.warn({ id, slug }, "KB categories: update failed — slug has leading/trailing hyphen");
      return null;
    }
  }
  const description = updates.description !== undefined
    ? (updates.description?.trim() || null)
    : undefined;
  if (description !== undefined && description && description.length > DESCRIPTION_MAX_LENGTH) {
    logger.warn({ id, descLength: description.length }, "KB categories: update failed — description too long");
    return null;
  }

  try {
    // Fetch the existing row (we need parent_id for slug-uniqueness check
    // + the current path/isActive for the cascade-deactivate logic).
    const existing = await pool.query<{
      id: number;
      parent_id: number | null;
      name: string;
      slug: string;
      description: string | null;
      path: string;
      is_active: boolean;
    }>(
      `SELECT id, parent_id, name, slug, description, path, is_active
       FROM ai_kb_categories WHERE id = $1`,
      [id],
    );
    if (existing.rows.length === 0) {
      logger.warn({ id }, "KB categories: update failed — not found");
      return null;
    }
    const current = existing.rows[0];

    // If slug is changing, check uniqueness within the parent (excluding self).
    if (slug !== undefined && slug !== current.slug) {
      if (current.parent_id === null) {
        const dup = await pool.query(
          "SELECT 1 FROM ai_kb_categories WHERE parent_id IS NULL AND slug = $1 AND id <> $2 LIMIT 1",
          [slug, id],
        );
        if (dup.rows.length > 0) {
          logger.warn({ id, slug }, "KB categories: update failed — root slug conflict");
          return null;
        }
      } else {
        const dup = await pool.query(
          "SELECT 1 FROM ai_kb_categories WHERE parent_id = $1 AND slug = $2 AND id <> $3 LIMIT 1",
          [current.parent_id, slug, id],
        );
        if (dup.rows.length > 0) {
          logger.warn({ id, slug, parentId: current.parent_id }, "KB categories: update failed — slug conflict within parent");
          return null;
        }
      }
    }

    // Build the UPDATE query dynamically (only set fields that were provided).
    const setClauses: string[] = ["updated_at = NOW()"];
    const values: (string | boolean | null)[] = [];
    let paramIdx = 1;
    if (name !== undefined) {
      setClauses.push(`name = $${paramIdx++}`);
      values.push(name);
    }
    if (slug !== undefined) {
      setClauses.push(`slug = $${paramIdx++}`);
      values.push(slug);
    }
    if (description !== undefined) {
      setClauses.push(`description = $${paramIdx++}`);
      values.push(description);
    }
    if (updates.isActive !== undefined) {
      setClauses.push(`is_active = $${paramIdx++}`);
      values.push(updates.isActive);
    }
    values.push(id.toString());

    await pool.query(
      `UPDATE ai_kb_categories SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
      values,
    );

    // Cascade-deactivate descendants if isActive went TRUE → FALSE.
    // We use the materialized path: every descendant's path starts with
    // this node's path (e.g. node '/1/3/' has descendants '/1/3/7/',
    // '/1/3/7/12/', etc.). The LIKE pattern '/1/3/%' matches all of them
    // EXCEPT the node itself (which has path '/1/3/'). We add `id <> $1`
    // to be explicit + safe even if the path format ever changes.
    if (updates.isActive === false && current.is_active === true) {
      const cascadeResult = await pool.query(
        `UPDATE ai_kb_categories
           SET is_active = FALSE, updated_at = NOW()
         WHERE path LIKE $1 || '%'
           AND id <> $2`,
        [current.path, id],
      );
      if (cascadeResult.rowCount && cascadeResult.rowCount > 0) {
        logger.warn(
          { id, deactivatedDescendants: cascadeResult.rowCount },
          "KB categories: cascade-deactivated descendants (parent set inactive)",
        );
      }
    }

    return await getKbCategory(id);
  } catch (err) {
    logger.error({ err, id, updates }, "KB categories: update failed");
    return null;
  }
}

// ─── moveKbCategory ──────────────────────────────────────────────────────────
/**
 * Moves a category to a new parent (changes parent_id, path, depth for
 * the moved node + ALL its descendants).
 *
 * Cycle check: rejects if `newParentId` is the node itself OR one of
 * its descendants (the new parent's path starts with the moved node's
 * path). Otherwise we'd create a cycle, which would break every
 * subtree query + the tree build.
 *
 * Path rebuild: the moved node's new path is `newParentPath + id + '/'`
 * (or `'/'+id+'/'` for roots). Every descendant's path is rebuilt by
 * string replacement: `REPLACE(path, oldPath, newPath)`. The depth
 * delta is `newDepth - oldDepth`, applied to the moved node + all
 * descendants.
 *
 * All updates run in a transaction so a failure mid-move rolls back
 * (no half-moved trees).
 *
 * Returns true on success, false on:
 *   - Not found
 *   - New parent not found (if newParentId was provided)
 *   - Cycle detected (newParentId is self or a descendant)
 *   - DB error
 */
export async function moveKbCategory(id: number, newParentId: number | null): Promise<boolean> {
  if (!Number.isInteger(id) || id <= 0) return false;
  if (newParentId !== null && (!Number.isInteger(newParentId) || newParentId <= 0)) return false;
  // Reject moving a node to itself.
  if (newParentId === id) {
    logger.warn({ id }, "KB categories: move failed — new parent is self");
    return false;
  }

  try {
    // Fetch the moved node.
    const nodeResult = await pool.query<{ path: string; depth: number }>(
      "SELECT path, depth FROM ai_kb_categories WHERE id = $1",
      [id],
    );
    if (nodeResult.rows.length === 0) {
      logger.warn({ id }, "KB categories: move failed — node not found");
      return false;
    }
    const oldPath = nodeResult.rows[0].path;
    const oldDepth = nodeResult.rows[0].depth;

    // Fetch the new parent (if any).
    let newParentPath = "/";
    let newParentDepth = -1;
    if (newParentId !== null) {
      const parentResult = await pool.query<{ path: string; depth: number }>(
        "SELECT path, depth FROM ai_kb_categories WHERE id = $1",
        [newParentId],
      );
      if (parentResult.rows.length === 0) {
        logger.warn({ id, newParentId }, "KB categories: move failed — new parent not found");
        return false;
      }
      newParentPath = parentResult.rows[0].path;
      newParentDepth = parentResult.rows[0].depth;

      // Cycle check: the new parent's path must NOT start with the moved
      // node's path (that would mean the new parent is a descendant of
      // the moved node — moving would create a cycle).
      if (newParentPath.startsWith(oldPath)) {
        logger.warn(
          { id, newParentId, oldPath, newParentPath },
          "KB categories: move failed — cycle detected (new parent is a descendant)",
        );
        return false;
      }
    }

    // Compute the new path + depth for the moved node.
    const newPath = newParentId === null
      ? `/${id}/`
      : `${newParentPath}${id}/`;
    const newDepth = newParentDepth + 1;
    const depthDelta = newDepth - oldDepth;

    // Begin the transaction.
    await pool.query("BEGIN");
    try {
      // Update the moved node.
      await pool.query(
        "UPDATE ai_kb_categories SET parent_id = $1, path = $2, depth = $3, updated_at = NOW() WHERE id = $4",
        [newParentId, newPath, newDepth, id],
      );

      // Update all descendants: rebuild path via string replacement +
      // shift depth by the delta. The LIKE pattern matches descendants
      // (paths that start with oldPath AND aren't the moved node itself).
      // REPLACE(path, oldPath, newPath) swaps the prefix correctly for
      // nested descendants (e.g. '/1/3/7/' → '/2/5/3/7/' if old='/1/3/'
      // and new='/2/5/3/').
      await pool.query(
        `UPDATE ai_kb_categories
           SET path = REPLACE(path, $1, $2),
               depth = depth + $3,
               updated_at = NOW()
         WHERE path LIKE $1 || '%'
           AND id <> $4`,
        [oldPath, newPath, depthDelta, id],
      );

      await pool.query("COMMIT");
    } catch (txErr) {
      await pool.query("ROLLBACK");
      throw txErr;
    }

    logger.info(
      { id, newParentId, oldPath, newPath, depthDelta },
      "KB categories: moved category",
    );
    return true;
  } catch (err) {
    logger.error({ err, id, newParentId }, "KB categories: move failed");
    return false;
  }
}

// ─── deleteKbCategory ────────────────────────────────────────────────────────
/**
 * Deletes a category. Rejects if the category OR any descendant has
 * entries (we don't want to silently orphan entries by cascading the
 * delete — the admin must move or delete the entries first).
 *
 * The check is a single query: count entries whose category_id is in
 * the set of (this node + all descendants). We compute the descendant
 * set via the materialized path (LIKE current.path || '%').
 *
 * On success, the DELETE cascades to children (the FK has ON DELETE
 * CASCADE). Returns:
 *   { ok: true }                          — deleted
 *   { ok: false, reason: "not found" }    — id doesn't exist
 *   { ok: false, reason: "has entries" }  — entries block the delete
 *   { ok: false, reason: "db error" }     — unexpected DB error
 */
export async function deleteKbCategory(
  id: number,
): Promise<{ ok: boolean; reason?: string }> {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: "Invalid id." };
  try {
    // Fetch the category (we need its path for the descendant query).
    const nodeResult = await pool.query<{ path: string }>(
      "SELECT path FROM ai_kb_categories WHERE id = $1",
      [id],
    );
    if (nodeResult.rows.length === 0) {
      return { ok: false, reason: "not found" };
    }
    const nodePath = nodeResult.rows[0].path;

    // Count entries in this category + all descendants.
    const entryCountResult = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::bigint AS cnt
         FROM ai_kb_entries
        WHERE category_id IN (
          SELECT id FROM ai_kb_categories WHERE path LIKE $1 || '%'
        )`,
      [nodePath],
    );
    const entryCount = Number(entryCountResult.rows[0].cnt) || 0;
    if (entryCount > 0) {
      return {
        ok: false,
        reason: `has entries`,
      };
    }

    // Safe to delete — CASCADE removes descendants.
    await pool.query("DELETE FROM ai_kb_categories WHERE id = $1", [id]);
    logger.info({ id }, "KB categories: deleted category (cascade removed descendants)");
    return { ok: true };
  } catch (err) {
    logger.error({ err, id }, "KB categories: delete failed");
    return { ok: false, reason: "db error" };
  }
}
