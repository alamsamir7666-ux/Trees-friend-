/**
 * Phase 1: Knowledge Base schema + category management — source-shape tests.
 *
 * These tests verify the SHAPE of the Phase 1 implementation without
 * requiring a live database. They check that:
 *   - `kbCategories.ts` exports all 7 functions + the validation constants.
 *   - `aiAdmin.ts` registers all 7 endpoints with correct paths.
 *   - `ensureAiTables.ts` has the Phase 1 migration block + seed data.
 *   - `aiChat.ts` (Drizzle schema) has the 4 new tables.
 *   - The seed creates the "Manual" creator + 3 root categories.
 *
 * Style mirrors the existing test files (adminRoutePrefix.test.ts,
 * promptVersioning.test.ts): read the source as text, assert substrings
 * + regex matches. This catches regressions where a refactor accidentally
 * removes an endpoint or renames a function.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/kbCategories.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

const REPO_ROOT = "/home/z/my-project/Trees-friend-";

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

describe("Phase 1: kbCategories.ts lib module", () => {
  const source = readSource("artifacts/api-server/src/lib/kbCategories.ts");

  it("exports all 7 functions", () => {
    expect(source).toContain("export async function listKbCategories");
    expect(source).toContain("export async function getKbCategory(");
    expect(source).toContain("export async function getKbCategoryTree");
    expect(source).toContain("export async function createKbCategory");
    expect(source).toContain("export async function updateKbCategory");
    expect(source).toContain("export async function moveKbCategory");
    expect(source).toContain("export async function deleteKbCategory");
  });

  it("exports the KbCategory + KbCategoryNode types", () => {
    expect(source).toContain("export interface KbCategory");
    expect(source).toContain("export interface KbCategoryNode");
  });

  it("exports validation constants", () => {
    expect(source).toContain("export const SLUG_REGEX");
    expect(source).toContain("export const SLUG_MAX_LENGTH");
    expect(source).toContain("export const NAME_MAX_LENGTH");
    expect(source).toContain("export const DESCRIPTION_MAX_LENGTH");
  });

  it("SLUG_REGEX matches the documented format (lowercase + digits + hyphens)", () => {
    expect(source).toContain("/^[a-z0-9-]+$/");
  });

  it("createKbCategory uses a transaction (BEGIN/COMMIT/ROLLBACK)", () => {
    expect(source).toContain("BEGIN");
    expect(source).toContain("COMMIT");
    expect(source).toContain("ROLLBACK");
  });

  it("createKbCategory inserts with placeholder path then updates with real path", () => {
    // The INSERT uses path = '/' (placeholder), then UPDATE sets the real path.
    expect(source).toMatch(/INSERT INTO ai_kb_categories.*path.*'\/'/s);
    expect(source).toContain("UPDATE ai_kb_categories SET path = $1 WHERE id = $2");
  });

  it("moveKbCategory has a cycle check (rejects moving into own subtree)", () => {
    expect(source).toContain("startsWith(oldPath)");
    expect(source).toContain("cycle");
  });

  it("moveKbCategory updates descendants via REPLACE(path, oldPath, newPath)", () => {
    expect(source).toContain("REPLACE(path, $1, $2)");
    expect(source).toContain("depth = depth + $3");
  });

  it("moveKbCategory uses a transaction", () => {
    // BEGIN/COMMIT/ROLLBACK already checked above — just verify the move
    // function has its own transaction block.
    expect(source).toMatch(/async function moveKbCategory[\s\S]*BEGIN[\s\S]*COMMIT/s);
  });

  it("deleteKbCategory rejects when the subtree has entries (409 path)", () => {
    expect(source).toContain("has entries");
    expect(source).toContain("not found");
    expect(source).toContain("db error");
  });

  it("deleteKbCategory counts entries via the materialized path (LIKE current.path || '%')", () => {
    expect(source).toContain("path LIKE $1 || '%'");
  });

  it("updateKbCategory cascade-deactivates descendants when isActive goes TRUE → FALSE", () => {
    expect(source).toContain("cascade");
    expect(source).toMatch(/WHERE path LIKE \$1 \|\| '%'/);
  });

  it("listKbCategories returns a denormalized entry_count via LEFT JOIN", () => {
    expect(source).toContain("LEFT JOIN");
    expect(source).toContain("entry_count");
    expect(source).toContain("COALESCE(e.cnt, 0)");
  });

  it("getKbCategoryTree builds the tree in Node (not SQL recursive CTE)", () => {
    expect(source).toContain("byId");
    expect(source).toContain("children");
    // Should NOT use a recursive CTE.
    expect(source).not.toMatch(/WITH RECURSIVE/);
  });
});

describe("Phase 1: aiAdmin.ts endpoints", () => {
  const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");

  it("imports all 7 KB category functions + constants from kbCategories", () => {
    expect(source).toContain("listKbCategories");
    expect(source).toContain("getKbCategoryTree");
    expect(source).toContain("getKbCategory");
    expect(source).toContain("createKbCategory");
    expect(source).toContain("updateKbCategory");
    expect(source).toContain("moveKbCategory");
    expect(source).toContain("deleteKbCategory");
    expect(source).toContain("SLUG_REGEX");
    expect(source).toContain("SLUG_MAX_LENGTH");
    expect(source).toContain("NAME_MAX_LENGTH");
    expect(source).toContain("DESCRIPTION_MAX_LENGTH");
  });

  it("registers GET /ai/admin/kb/categories", () => {
    expect(source).toMatch(/router\.get\(\s*["']\/ai\/admin\/kb\/categories["']/);
  });

  it("registers GET /ai/admin/kb/categories/tree", () => {
    expect(source).toMatch(/router\.get\(\s*["']\/ai\/admin\/kb\/categories\/tree["']/);
  });

  it("registers GET /ai/admin/kb/categories/:id", () => {
    expect(source).toMatch(/router\.get\(\s*["']\/ai\/admin\/kb\/categories\/:id["']/);
  });

  it("registers POST /ai/admin/kb/categories", () => {
    expect(source).toMatch(/router\.post\(\s*["']\/ai\/admin\/kb\/categories["']/);
  });

  it("registers PUT /ai/admin/kb/categories/:id", () => {
    expect(source).toMatch(/router\.put\(\s*["']\/ai\/admin\/kb\/categories\/:id["']/);
  });

  it("registers POST /ai/admin/kb/categories/:id/move", () => {
    expect(source).toMatch(/router\.post\(\s*["']\/ai\/admin\/kb\/categories\/:id\/move["']/);
  });

  it("registers DELETE /ai/admin/kb/categories/:id", () => {
    expect(source).toMatch(/router\.delete\(\s*["']\/ai\/admin\/kb\/categories\/:id["']/);
  });

  it("NO KB route uses the double /api/ prefix (Bug #6 regression guard)", () => {
    const brokenPattern = /router\.(get|post|put|delete|patch)\(\s*["']\/api\/ai\/admin\/kb\//;
    expect(brokenPattern.test(source)).toBe(false);
  });

  it("POST /ai/admin/kb/categories validates name + slug presence", () => {
    expect(source).toContain("name is required (non-empty string)");
    expect(source).toContain("slug is required (non-empty string)");
  });

  it("POST /ai/admin/kb/categories validates slug format with SLUG_REGEX", () => {
    expect(source).toContain("SLUG_REGEX.test(slug.trim())");
  });

  it("DELETE /ai/admin/kb/categories/:id returns 409 when category has entries", () => {
    expect(source).toContain("Cannot delete a category that has entries");
  });

  it("POST /ai/admin/kb/categories/:id/move returns 409 on cycle", () => {
    expect(source).toContain("Cannot move a category into its own descendant (cycle)");
  });

  it("POST /ai/admin/kb/categories/:id/move rejects moving a category into itself (400)", () => {
    expect(source).toContain("Cannot move a category into itself.");
  });
});

describe("Phase 1: ensureAiTables.ts migration block", () => {
  const source = readSource("artifacts/api-server/src/lib/ensureAiTables.ts");

  it("has a Phase 1 migration block header", () => {
    expect(source).toContain("Phase 1: Knowledge Base schema");
  });

  it("creates ai_kb_creators table", () => {
    expect(source).toContain("CREATE TABLE IF NOT EXISTS ai_kb_creators");
    expect(source).toContain("ai_kb_creators_slug_idx");
    expect(source).toContain("ai_kb_creators_active_idx");
    expect(source).toContain("ai_kb_creators_entry_count_idx");
  });

  it("creates ai_kb_categories table with parent_id self-reference + UNIQUE(parent_id, slug)", () => {
    expect(source).toContain("CREATE TABLE IF NOT EXISTS ai_kb_categories");
    expect(source).toContain("parent_id INTEGER REFERENCES ai_kb_categories(id) ON DELETE CASCADE");
    expect(source).toContain("UNIQUE(parent_id, slug)");
    expect(source).toContain("ai_kb_categories_path_idx");
    expect(source).toContain("ai_kb_categories_parent_idx");
    expect(source).toContain("ai_kb_categories_active_idx");
  });

  it("creates ai_kb_sources table with partial unique index on source_url", () => {
    expect(source).toContain("CREATE TABLE IF NOT EXISTS ai_kb_sources");
    expect(source).toContain("ai_kb_sources_url_unique");
    expect(source).toContain("WHERE source_url IS NOT NULL");
    expect(source).toContain("ai_kb_sources_creator_idx");
    expect(source).toContain("ai_kb_sources_status_idx");
  });

  it("creates ai_kb_entries table with GIN index on keywords", () => {
    expect(source).toContain("CREATE TABLE IF NOT EXISTS ai_kb_entries");
    expect(source).toContain("ai_kb_entries_category_idx");
    expect(source).toContain("ai_kb_entries_creator_idx");
    expect(source).toContain("ai_kb_entries_product_idx");
    expect(source).toContain("ai_kb_entries_active_idx");
    expect(source).toContain("ai_kb_entries_keywords_idx");
    expect(source).toContain("USING gin (keywords)");
  });

  it("Phase 1 block does NOT add the embedding column (Phase 2 does, in a separate block)", () => {
    // The Phase 1 block creates the ai_kb_entries table WITHOUT an embedding
    // column. Phase 2 adds it via a separate ALTER TABLE block (tested in
    // kbSources.test.ts). The Phase 1 block's CREATE TABLE should NOT
    // mention `embedding vector`.
    //
    // We extract just the Phase 1 block (between the Phase 1 header and
    // the Phase 2 header) to verify it doesn't add the embedding column.
    const phase1Start = source.indexOf("Phase 1: Knowledge Base schema");
    const phase2Start = source.indexOf("Phase 2: KB entries embedding");
    expect(phase1Start).toBeGreaterThan(-1);
    expect(phase2Start).toBeGreaterThan(-1);
    const phase1Block = source.slice(phase1Start, phase2Start);
    // The Phase 1 block's CREATE TABLE should NOT include `embedding vector`.
    // (The Phase 1 block DOES mention "Phase 2" in a comment saying the
    // embedding column is deferred — that's fine, it's not actually adding it.)
    expect(phase1Block).not.toMatch(/CREATE TABLE[\s\S]*?embedding\s+vector/i);
    expect(phase1Block).not.toMatch(/ADD COLUMN[\s\S]*?embedding\s+vector/i);
  });

  it("seeds the 'Manual' creator idempotently (WHERE NOT EXISTS)", () => {
    expect(source).toContain("INSERT INTO ai_kb_creators (name, slug, source_type, profile_url)");
    expect(source).toContain("'Manual'");
    expect(source).toContain("'manual'");
    expect(source).toContain("WHERE NOT EXISTS (SELECT 1 FROM ai_kb_creators WHERE slug = 'manual')");
  });

  it("seeds the 'Plant Care' root category", () => {
    expect(source).toContain("'Plant Care'");
    expect(source).toContain("'plant-care'");
    expect(source).toContain("'General plant care guides'");
  });

  it("seeds the 'Pests & Diseases' child category", () => {
    expect(source).toContain("'Pests & Diseases'");
    expect(source).toContain("'pests-diseases'");
  });

  it("seeds the 'Gardening Tips' child category", () => {
    expect(source).toContain("'Gardening Tips'");
    expect(source).toContain("'gardening-tips'");
  });

  it("backfills root category paths from '/' to '/<id>/' after INSERT", () => {
    expect(source).toContain("UPDATE ai_kb_categories");
    expect(source).toContain("'/' || id || '/'");
  });
});

describe("Phase 1: aiChat.ts Drizzle schema additions", () => {
  const source = readSource("lib/db/src/schema/aiChat.ts");

  it("imports AnyPgColumn for self-references", () => {
    expect(source).toContain("type AnyPgColumn");
  });

  it("defines aiKbCreatorsTable", () => {
    expect(source).toContain('pgTable(\n  "ai_kb_creators"');
    expect(source).toContain("aiKbCreatorsTable");
    expect(source).toContain("export type AiKbCreator");
  });

  it("defines aiKbCategoriesTable with self-referencing parentId", () => {
    expect(source).toContain('pgTable(\n  "ai_kb_categories"');
    expect(source).toContain("aiKbCategoriesTable");
    expect(source).toContain("AnyPgColumn => aiKbCategoriesTable.id");
    expect(source).toContain("export type AiKbCategory");
  });

  it("defines aiKbSourcesTable with partial unique index on sourceUrl", () => {
    expect(source).toContain('pgTable(\n  "ai_kb_sources"');
    expect(source).toContain("aiKbSourcesTable");
    expect(source).toContain("ai_kb_sources_url_unique");
    expect(source).toContain("source_url IS NOT NULL");
    expect(source).toContain("export type AiKbSource");
  });

  it("defines aiKbEntriesTable with GIN index on keywords", () => {
    expect(source).toContain('pgTable(\n  "ai_kb_entries"');
    expect(source).toContain("aiKbEntriesTable");
    expect(source).toContain('using("gin", table.keywords)');
    expect(source).toContain("export type AiKbEntry");
  });

  it("defines the embedding column on aiKbEntriesTable as text (Phase 2 added it)", () => {
    // Phase 2 added the embedding column. Drizzle doesn't have a native
    // vector type, so it's declared as text (the actual SQL column is
    // vector(768), created by the Phase 2 migration in ensureAiTables.ts).
    // The route code casts with `$1::vector` on INSERT/UPDATE.
    expect(source).toMatch(/embedding:\s*text\("embedding"\)/);
  });
});

describe("Phase 1: frontend wiring", () => {
  const adminPageSource = readSource("artifacts/tree-friend/src/pages/AdminPage.tsx");

  it("AdminPage imports KbTab", () => {
    expect(adminPageSource).toContain('import { KbTab }');
  });

  it("AdminPage registers the 'kb' nav item", () => {
    expect(adminPageSource).toContain('{ id: "kb"');
    expect(adminPageSource).toContain('label: "Knowledge Base"');
  });

  it("AdminPage renders <KbTab /> for the 'kb' tab", () => {
    expect(adminPageSource).toMatch(/case "kb":\s*return <KbTab \/>/);
  });

  it("kbApi.ts exports all 7 API functions + types + autoSlug", () => {
    const source = readSource("artifacts/tree-friend/src/lib/kbApi.ts");
    expect(source).toContain("export async function fetchKbCategories");
    expect(source).toContain("export async function fetchKbCategoryTree");
    expect(source).toContain("export async function fetchKbCategory(");
    expect(source).toContain("export async function createKbCategory");
    expect(source).toContain("export async function updateKbCategory");
    expect(source).toContain("export async function moveKbCategory");
    expect(source).toContain("export async function deleteKbCategory");
    expect(source).toContain("export interface KbCategory");
    expect(source).toContain("export interface KbCategoryNode");
    expect(source).toContain("export function autoSlug");
  });

  it("KbCategoryModal.tsx exists + uses createKbCategory/updateKbCategory", () => {
    const source = readSource("artifacts/tree-friend/src/components/admin/modals/KbCategoryModal.tsx");
    expect(source).toContain("KbCategoryModal");
    expect(source).toContain("createKbCategory");
    expect(source).toContain("updateKbCategory");
  });

  it("KbTab.tsx exists + renders a tree + handles CRUD/move/delete", () => {
    const source = readSource("artifacts/tree-friend/src/components/admin/tabs/KbTab.tsx");
    expect(source).toContain("export function KbTab");
    expect(source).toContain("fetchKbCategoryTree");
    // createKbCategory is handled by the modal (KbCategoryModal), not
    // KbTab — KbTab only needs update/move/delete (creation is delegated).
    expect(source).toContain("updateKbCategory");
    expect(source).toContain("moveKbCategory");
    expect(source).toContain("deleteKbCategory");
    // Tree rendering helpers.
    expect(source).toContain("function TreeView");
    expect(source).toContain("function TreeNode");
    // Move + delete modals.
    expect(source).toContain("moveTarget");
    expect(source).toContain("deleteTarget");
  });
});
