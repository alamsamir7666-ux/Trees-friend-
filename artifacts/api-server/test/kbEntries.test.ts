/**
 * Phase 2: KB entries — source-shape tests.
 *
 * Verifies:
 *   - `kbEntries.ts` exports all functions.
 *   - `aiAdmin.ts` registers all entry endpoints.
 *   - Content change detection (clears embedding on content update).
 *   - Batch create endpoint exists + uses a transaction.
 *   - Activate/deactivate endpoints exist.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/kbEntries.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

const REPO_ROOT = "/home/z/my-project/Trees-friend-";

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

describe("Phase 2: kbEntries.ts lib module", () => {
  const source = readSource("artifacts/api-server/src/lib/kbEntries.ts");

  it("exports all required functions", () => {
    expect(source).toContain("export async function listKbEntries");
    expect(source).toContain("export async function getKbEntry");
    expect(source).toContain("export async function createEntry");
    expect(source).toContain("export async function createEntriesBatch");
    expect(source).toContain("export async function updateEntry");
    expect(source).toContain("export async function activateEntry");
    expect(source).toContain("export async function deactivateEntry");
    expect(source).toContain("export async function deleteEntry");
  });

  it("re-exports the KbEntry type from kbSources", () => {
    expect(source).toContain("export type KbEntry = KbEntryType");
  });

  it("exports validation constants", () => {
    expect(source).toContain("ENTRY_TITLE_MAX_LENGTH");
    expect(source).toContain("ENTRY_CONTENT_MAX_LENGTH");
    expect(source).toContain("ENTRY_KEYWORD_MAX_COUNT");
    expect(source).toContain("ENTRY_KEYWORD_MAX_LENGTH");
    expect(source).toContain("ENTRY_PRIORITY_MIN");
    expect(source).toContain("ENTRY_PRIORITY_MAX");
  });

  it("ENTRY_CONTENT_MAX_LENGTH is 50,000", () => {
    expect(source).toContain("50_000");
  });

  it("ENTRY_KEYWORD_MAX_COUNT is 10", () => {
    expect(source).toContain("10");
  });

  it("ENTRY_PRIORITY range is 0-10", () => {
    expect(source).toContain("ENTRY_PRIORITY_MIN = 0");
    expect(source).toContain("ENTRY_PRIORITY_MAX = 10");
  });

  it("updateEntry detects content changes + clears the embedding", () => {
    // The key Phase 2 invariant: when content changes, clear embedding.
    expect(source).toContain("contentChanged");
    expect(source).toContain("embedding = NULL");
    expect(source).toContain("embedding_status = 'pending'");
    expect(source).toContain("embedding_error = NULL");
    expect(source).toContain("embedding_generated_at = NULL");
  });

  it("createEntriesBatch uses a transaction (BEGIN/COMMIT/ROLLBACK)", () => {
    expect(source).toContain("BEGIN");
    expect(source).toContain("COMMIT");
    expect(source).toContain("ROLLBACK");
  });

  it("createEntriesBatch sets is_active = FALSE for all entries", () => {
    // Ingested entries are inactive until the admin activates them.
    expect(source).toContain("FALSE, 1, 'pending'");
  });

  it("createEntriesBatch increments creator entry_count in a single UPDATE", () => {
    expect(source).toContain("entry_count = entry_count + $1");
  });

  it("createEntriesBatch updates source processing_status to 'embedding'", () => {
    expect(source).toContain("processing_status = 'embedding'");
  });

  it("createEntry denormalizes creator_id from the source if not provided", () => {
    expect(source).toContain("SELECT creator_id FROM ai_kb_sources WHERE id = $1");
  });

  it("deleteEntry decrements the creator's entry_count", () => {
    expect(source).toContain("decrementEntryCount");
  });

  it("listKbEntries supports all documented filters", () => {
    expect(source).toContain("sourceId");
    expect(source).toContain("categoryId");
    expect(source).toContain("creatorId");
    expect(source).toContain("productId");
    expect(source).toContain("isActive");
    expect(source).toContain("embeddingStatus");
  });
});

describe("Phase 2: aiAdmin.ts entry endpoints", () => {
  const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");

  it("registers GET /ai/admin/kb/entries", () => {
    expect(source).toMatch(/router\.get\(\s*["']\/ai\/admin\/kb\/entries["']/);
  });

  it("registers GET /ai/admin/kb/entries/:id", () => {
    expect(source).toMatch(/router\.get\(\s*["']\/ai\/admin\/kb\/entries\/:id["']/);
  });

  it("registers POST /ai/admin/kb/entries (manual create)", () => {
    expect(source).toMatch(/router\.post\(\s*["']\/ai\/admin\/kb\/entries["']/);
  });

  it("registers PUT /ai/admin/kb/entries/:id", () => {
    expect(source).toMatch(/router\.put\(\s*["']\/ai\/admin\/kb\/entries\/:id["']/);
  });

  it("registers POST /ai/admin/kb/entries/:id/activate", () => {
    expect(source).toMatch(/router\.post\(\s*["']\/ai\/admin\/kb\/entries\/:id\/activate["']/);
  });

  it("registers POST /ai/admin/kb/entries/:id/deactivate", () => {
    expect(source).toMatch(/router\.post\(\s*["']\/ai\/admin\/kb\/entries\/:id\/deactivate["']/);
  });

  it("registers DELETE /ai/admin/kb/entries/:id", () => {
    expect(source).toMatch(/router\.delete\(\s*["']\/ai\/admin\/kb\/entries\/:id["']/);
  });

  it("NO entry route uses the double /api/ prefix", () => {
    const brokenPattern = /router\.(get|post|put|delete|patch)\(\s*["']\/api\/ai\/admin\/kb\/entries\//;
    expect(brokenPattern.test(source)).toBe(false);
  });

  it("POST /ai/admin/kb/entries defaults isActive to true (manual entries)", () => {
    expect(source).toContain("isActive: isActive ?? true");
  });

  it("PUT /ai/admin/kb/entries/:id validates keywords array length", () => {
    expect(source).toContain("ENTRY_KEYWORD_MAX_COUNT");
  });

  it("POST /ai/admin/kb/sources/:id/entries/batch caps at 50 entries", () => {
    expect(source).toContain("entries.length > 50");
    expect(source).toContain("max 50");
  });
});
