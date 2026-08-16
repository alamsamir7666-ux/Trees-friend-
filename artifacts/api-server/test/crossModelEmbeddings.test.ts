/**
 * BUG-E1 critical fix: cross-model embedding comparison tests.
 *
 * Verifies that:
 *   - The `embedding_model` column exists in the schema + migration.
 *   - `kbEmbeddings.ts` stores the model name on each embedding write.
 *   - `kbSearch.ts` filters out stale-model embeddings in the SQL
 *     (CASE WHEN embedding_model = $model).
 *   - `markStaleEmbeddingsForReembedding` is exported + called on startup.
 *   - Migration 0010 exists + is journaled.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/crossModelEmbeddings.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

const REPO_ROOT = "/home/z/my-project/Trees-friend-";

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

function exists(rel: string): boolean {
  return fs.existsSync(`${REPO_ROOT}/${rel}`);
}

describe("BUG-E1 critical fix: migration 0010 exists + is well-formed", () => {
  const migrationPath = "lib/db/migrations/0010_embedding_model_tracking.sql";

  it("migration file exists", () => {
    expect(exists(migrationPath)).toBe(true);
  });

  it("adds embedding_model TEXT column", () => {
    const source = readSource(migrationPath);
    expect(source).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+embedding_model\s+TEXT/i);
  });

  it("marks existing embeddings (non-NULL embedding, NULL model) as pending", () => {
    const source = readSource(migrationPath);
    expect(source).toMatch(/UPDATE\s+ai_kb_entries/i);
    expect(source).toMatch(/embedding_status\s*=\s*['"]pending['"]/i);
    expect(source).toMatch(/embedding\s*=\s*NULL/i);
    expect(source).toMatch(/WHERE\s+embedding\s+IS\s+NOT\s+NULL/i);
    expect(source).toMatch(/embedding_model\s+IS\s+NULL/i);
  });

  it("creates an index on embedding_model", () => {
    const source = readSource(migrationPath);
    expect(source).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+ai_kb_entries_embedding_model_idx/i,
    );
  });

  it("is idempotent (uses IF NOT EXISTS)", () => {
    const source = readSource(migrationPath);
    expect(source).toMatch(/IF\s+NOT\s+EXISTS/i);
  });
});

describe("BUG-E1 critical fix: journal includes migration 0010", () => {
  it("_journal.json includes 0010_embedding_model_tracking", () => {
    const raw = readSource("lib/db/migrations/meta/_journal.json");
    const journal = JSON.parse(raw) as { entries: { tag: string }[] };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags).toContain("0010_embedding_model_tracking");
  });
});

describe("BUG-E1 critical fix: Drizzle schema declares embedding_model", () => {
  const source = readSource("lib/db/src/schema/aiChat.ts");

  it("aiKbEntriesTable has embeddingModel field", () => {
    expect(source).toMatch(/embeddingModel:\s*text\(["']embedding_model["']\)/);
  });
});

describe("BUG-E1 critical fix: ensureAiTables.ts adds the column for fresh DBs", () => {
  const source = readSource("artifacts/api-server/src/lib/ensureAiTables.ts");

  it("adds embedding_model TEXT column", () => {
    expect(source).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+embedding_model\s+TEXT/i);
  });

  it("creates the embedding_model index", () => {
    expect(source).toMatch(/ai_kb_entries_embedding_model_idx/i);
  });
});

describe("BUG-E1 critical fix: kbEmbeddings.ts stores the model name", () => {
  const source = readSource("artifacts/api-server/src/lib/kbEmbeddings.ts");

  it("UPDATE includes embedding_model = $3 (the model name)", () => {
    // The success-path UPDATE must set embedding_model to the model that
    // generated the embedding (result.model).
    expect(source).toMatch(/embedding_model\s*=\s*\$3/i);
    expect(source).toMatch(/result\.model/);
  });

  it("exports markStaleEmbeddingsForReembedding", () => {
    expect(source).toMatch(/export\s+async\s+function\s+markStaleEmbeddingsForReembedding/);
  });

  it("markStaleEmbeddingsForReembedding updates entries with stale/NULL model", () => {
    expect(source).toMatch(/embedding_model\s+IS\s+NULL\s+OR\s+embedding_model\s*!=\s*\$1/i);
  });

  it("markStaleEmbeddingsForReembedding sets embedding_status = 'pending'", () => {
    expect(source).toMatch(/embedding_status\s*=\s*['"]pending['"]/i);
  });

  it("markStaleEmbeddingsForReembedding clears the embedding vector", () => {
    expect(source).toMatch(/embedding\s*=\s*NULL/i);
  });
});

describe("BUG-E1 critical fix: kbSearch.ts filters stale embeddings in SQL", () => {
  const source = readSource("artifacts/api-server/src/lib/kbSearch.ts");

  it("semantic SELECT uses CASE WHEN embedding_model = $model", () => {
    // The primary search function's semantic score must guard against
    // stale embeddings with a CASE WHEN expression.
    expect(source).toMatch(/CASE\s+WHEN\s+e\.embedding_model\s*=\s*\$/i);
  });

  it("semantic WHERE clause checks embedding_model = $model", () => {
    // The WHERE clause that filters candidates must also guard.
    expect(source).toMatch(/e\.embedding_model\s*=\s*\$.*AND\s+1\s*-\s*\(e\.embedding\s*<=>/i);
  });

  it("passes EMBEDDING_MODEL as a SQL parameter", () => {
    // The current model name must be passed as a parameter (not string-interpolated).
    expect(source).toMatch(/sqlParams\.push\(EMBEDDING_MODEL\)/);
  });

  it("has embeddingModelParamIdx variable", () => {
    expect(source).toMatch(/embeddingModelParamIdx/);
  });
});

describe("BUG-E1 critical fix: app.ts calls markStaleEmbeddingsForReembedding on startup", () => {
  const source = readSource("artifacts/api-server/src/app.ts");

  it("imports markStaleEmbeddingsForReembedding", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*markStaleEmbeddingsForReembedding[^}]*\}\s*from\s*["']\.\/lib\/kbEmbeddings["']/,
    );
  });

  it("calls markStaleEmbeddingsForReembedding() after ensureAiTables", () => {
    const ensureIdx = source.indexOf("ensureAiTables()");
    const markIdx = source.indexOf("markStaleEmbeddingsForReembedding()");
    expect(ensureIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeGreaterThan(ensureIdx);
  });

  it("call is fire-and-forget (catch(() => {}))", () => {
    expect(source).toMatch(/markStaleEmbeddingsForReembedding\(\)\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
  });
});
