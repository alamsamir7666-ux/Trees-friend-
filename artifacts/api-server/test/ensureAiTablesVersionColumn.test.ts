/**
 * BUG-3 fix: ensureAiTables.ts includes kb_content_version for fresh DBs.
 *
 * Verifies (via source-shape inspection) that `ensureAiTables.ts`
 * includes the `kb_content_version` column + partial index in its
 * CREATE TABLE / ALTER TABLE block, so fresh environments (without
 * migration history) also get the column.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/ensureAiTablesVersionColumn.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

describe("BUG-3 fix: ensureAiTables.ts adds kb_content_version column", () => {
  const source = readSource("artifacts/api-server/src/lib/ensureAiTables.ts");

  it("ALTER TABLE ai_response_cache ADD COLUMN IF NOT EXISTS kb_content_version TEXT", () => {
    // The migration adds the column idempotently for existing DBs.
    // ensureAiTables.ts must do the same for fresh DBs that don't have
    // migration history (the CREATE TABLE block runs first; the ALTER
    // runs after as a safety net for already-existing tables).
    expect(source).toMatch(
      /ALTER\s+TABLE\s+ai_response_cache\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+kb_content_version\s+TEXT/i,
    );
  });

  it("creates the ai_response_cache_kb_version_idx partial index", () => {
    // The partial index (WHERE kb_content_version IS NOT NULL) lets the
    // lookup query efficiently find versioned rows.
    expect(source).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+ai_response_cache_kb_version_idx\s+ON\s+ai_response_cache\s*\(\s*kb_content_version\s*\)\s+WHERE\s+kb_content_version\s+IS\s+NOT\s+NULL/i,
    );
  });

  it("does NOT backfill kb_content_version on existing rows (NULL is correct)", () => {
    // Existing rows have NULL kb_content_version. We intentionally do NOT
    // backfill them with a value — NULL means "version unknown" and they
    // are excluded from cache hits (NULL = anything is NULL in SQL).
    // They'll expire via TTL (1h max) and be replaced by versioned rows.
    //
    // The had_tool_calls column DOES have a backfill (SET had_tool_calls =
    // FALSE WHERE had_tool_calls IS NULL) because NULL there means "treat
    // as non-tool" (long TTL). But for kb_content_version, NULL means
    // "skip this row" — no backfill is correct.
    //
    // We check that there's no UPDATE ai_response_cache SET kb_content_version
    // statement.
    expect(source).not.toMatch(/UPDATE\s+ai_response_cache\s+SET\s+kb_content_version\s*=/i);
  });

  it("comments explain the BUG-3 fix rationale", () => {
    // The migration block must include a comment explaining WHY the
    // column exists (the race window BUG-3 fixes).
    expect(source).toMatch(/BUG-3\s+fix/i);
    expect(source).toMatch(/kb_content_version/i);
    expect(source).toMatch(/race\s+window/i);
  });
});

describe("BUG-3 fix: ensureAiTables.ts column is nullable", () => {
  const source = readSource("artifacts/api-server/src/lib/ensureAiTables.ts");

  it("kb_content_version is declared TEXT (nullable, no NOT NULL)", () => {
    // The column must be nullable so existing rows can have NULL
    // (treated as "version unknown", excluded from cache hits).
    // The ADD COLUMN statement should be `TEXT` (no `NOT NULL`).
    expect(source).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+kb_content_version\s+TEXT(?!\s+NOT\s+NULL)/i,
    );
  });
});
