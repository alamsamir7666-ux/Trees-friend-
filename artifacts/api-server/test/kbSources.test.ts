/**
 * Phase 2: KB sources — source-shape tests.
 *
 * Verifies:
 *   - `kbSources.ts` exports all functions.
 *   - `aiAdmin.ts` registers all source endpoints.
 *   - `ensureAiTables.ts` has the Phase 2 migration block (chunking metadata).
 *   - Drizzle schema has the new chunking columns on aiKbSourcesTable.
 *   - Dedup logic (source_url uniqueness) is present in the code.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/kbSources.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

const REPO_ROOT = "/home/z/my-project/Trees-friend-";

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

describe("Phase 2: kbSources.ts lib module", () => {
  const source = readSource("artifacts/api-server/src/lib/kbSources.ts");

  it("exports all required functions", () => {
    expect(source).toContain("export async function listKbSources");
    expect(source).toContain("export async function getKbSource");
    expect(source).toContain("export async function createKbSource");
    expect(source).toContain("export async function updateKbSource");
    expect(source).toContain("export async function deleteKbSource");
    expect(source).toContain("export async function updateProcessingStatus");
    expect(source).toContain("export async function updateChunkingMetadata");
  });

  it("exports the KbSource + KbSourceWithEntries types", () => {
    expect(source).toContain("export interface KbSource");
    expect(source).toContain("export interface KbSourceWithEntries");
  });

  it("exports validation constants", () => {
    expect(source).toContain("SOURCE_TITLE_MAX_LENGTH");
    expect(source).toContain("SOURCE_URL_MAX_LENGTH");
    expect(source).toContain("RAW_TEXT_MAX_LENGTH");
    expect(source).toContain("VALID_LANGUAGES");
  });

  it("RAW_TEXT_MAX_LENGTH is 100,000 (handles long transcripts)", () => {
    expect(source).toContain("100_000");
  });

  it("VALID_LANGUAGES includes en, bn, banglish", () => {
    expect(source).toContain('"en"');
    expect(source).toContain('"bn"');
    expect(source).toContain('"banglish"');
  });

  it("createKbSource has dedup logic (checks source_url before INSERT)", () => {
    expect(source).toContain("SELECT id FROM ai_kb_sources WHERE source_url = $1");
  });

  it("deleteKbSource decrements creator entry_count before CASCADE delete", () => {
    expect(source).toContain("decrementEntryCount");
  });

  it("markSourceReadyIfAllEntriesEmbedded updates status to 'ready'", () => {
    expect(source).toContain("markSourceReadyIfAllEntriesEmbedded");
    expect(source).toContain("processing_status = 'ready'");
  });

  it("listKbSources returns { sources, total } with denormalized entry_count", () => {
    expect(source).toContain("COALESCE(e.cnt, 0)");
    expect(source).toContain("entry_count");
  });
});

describe("Phase 2: aiAdmin.ts source endpoints", () => {
  const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");

  it("registers GET /ai/admin/kb/sources", () => {
    expect(source).toMatch(/router\.get\(\s*["']\/ai\/admin\/kb\/sources["']/);
  });

  it("registers GET /ai/admin/kb/sources/:id", () => {
    expect(source).toMatch(/router\.get\(\s*["']\/ai\/admin\/kb\/sources\/:id["']/);
  });

  it("registers POST /ai/admin/kb/sources", () => {
    expect(source).toMatch(/router\.post\(\s*["']\/ai\/admin\/kb\/sources["']/);
  });

  it("registers PUT /ai/admin/kb/sources/:id", () => {
    expect(source).toMatch(/router\.put\(\s*["']\/ai\/admin\/kb\/sources\/:id["']/);
  });

  it("registers DELETE /ai/admin/kb/sources/:id", () => {
    expect(source).toMatch(/router\.delete\(\s*["']\/ai\/admin\/kb\/sources\/:id["']/);
  });

  it("registers POST /ai/admin/kb/sources/:id/chunk (AI chunking)", () => {
    expect(source).toMatch(/router\.post\(\s*["']\/ai\/admin\/kb\/sources\/:id\/chunk["']/);
  });

  it("registers POST /ai/admin/kb/sources/:id/entries/batch", () => {
    expect(source).toMatch(/router\.post\(\s*["']\/ai\/admin\/kb\/sources\/:id\/entries\/batch["']/);
  });

  it("NO source route uses the double /api/ prefix", () => {
    const brokenPattern = /router\.(get|post|put|delete|patch)\(\s*["']\/api\/ai\/admin\/kb\/sources\//;
    expect(brokenPattern.test(source)).toBe(false);
  });

  it("POST /ai/admin/kb/sources validates sourceLanguage against VALID_LANGUAGES", () => {
    expect(source).toContain("VALID_LANGUAGES");
    expect(source).toContain("sourceLanguage");
  });

  it("POST /ai/admin/kb/sources/:id/chunk gates on English (sourceLanguage !== 'en' → 422)", () => {
    expect(source).toContain("source.sourceLanguage !== \"en\"");
    expect(source).toContain("AI chunking is only available for English content");
  });

  it("POST /ai/admin/kb/sources returns 409 on duplicate source_url", () => {
    expect(source).toContain("A source with this URL already exists");
  });
});

describe("Phase 2: ensureAiTables.ts chunking metadata migration", () => {
  const source = readSource("artifacts/api-server/src/lib/ensureAiTables.ts");

  it("has a Phase 2 migration block header", () => {
    expect(source).toContain("Phase 2: KB entries embedding + source chunking metadata");
  });

  it("adds embedding column (vector(768)) to ai_kb_entries", () => {
    expect(source).toContain("ADD COLUMN IF NOT EXISTS embedding vector(768)");
  });

  it("creates HNSW index on ai_kb_entries.embedding", () => {
    expect(source).toContain("ai_kb_entries_embedding_idx");
    expect(source).toContain("hnsw (embedding vector_cosine_ops)");
  });

  it("adds embedding_status + embedding_error + embedding_generated_at to ai_kb_entries", () => {
    expect(source).toContain("embedding_status TEXT NOT NULL DEFAULT 'pending'");
    expect(source).toContain("embedding_error TEXT");
    expect(source).toContain("embedding_generated_at TIMESTAMP");
  });

  it("adds chunking metadata columns to ai_kb_sources", () => {
    expect(source).toContain("chunking_method TEXT");
    expect(source).toContain("chunking_model TEXT");
    expect(source).toContain("chunked_at TIMESTAMP");
    expect(source).toContain("chunking_error TEXT");
  });
});

describe("Phase 2: Drizzle schema (aiChat.ts) chunking columns", () => {
  const source = readSource("lib/db/src/schema/aiChat.ts");

  it("aiKbSourcesTable has the 4 chunking columns", () => {
    expect(source).toContain('chunkingMethod: text("chunking_method")');
    expect(source).toContain('chunkingModel: text("chunking_model")');
    expect(source).toContain('chunkedAt: timestamp("chunked_at")');
    expect(source).toContain('chunkingError: text("chunking_error")');
  });

  it("aiKbEntriesTable has the embedding columns", () => {
    expect(source).toContain('embedding: text("embedding")');
    expect(source).toContain('embeddingStatus: text("embedding_status")');
    expect(source).toContain('embeddingError: text("embedding_error")');
    expect(source).toContain('embeddingGeneratedAt: timestamp("embedding_generated_at")');
  });

  it("documents that HNSW index is in SQL migration only (not Drizzle)", () => {
    expect(source).toContain("HNSW index on embedding");
  });
});
