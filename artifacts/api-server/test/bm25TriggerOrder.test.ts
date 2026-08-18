/**
 * BUG-K19 fix: BM25 doc-length trigger order is inverted.
 *
 * Verifies (via source-shape inspection of migration files) that:
 *   1. Migration `0009_bm25_trigger_order_fix.sql` exists.
 *   2. The buggy trigger (`ai_kb_entries_bm25_doclength_trigger`) is dropped.
 *   3. A new trigger (`zz_ai_kb_entries_bm25_doclength_trigger`) is created
 *      so it sorts AFTER `ai_kb_entries_search_tsvector_trigger` (PostgreSQL
 *      fires BEFORE triggers in alphabetical name order).
 *   4. The migration backfills `bm25_doc_length` for existing rows.
 *   5. The migration refreshes BM25 term stats (`refresh_kb_term_stats()`).
 *   6. Migration 0007 is NOT modified (it's already shipped).
 *   7. The Drizzle migration journal (`_journal.json`) includes 0009.
 *   8. The trigger function comment explains the alphabetical ordering rule.
 *   9. The migration is idempotent (uses `IF EXISTS` / `OR REPLACE`).
 *
 * These tests verify the SQL files are correct, not that they're applied
 * to a live database (would require a real Postgres). The source-shape
 * approach mirrors `kbCategories.test.ts` and `toolCallCache.test.ts`.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/bm25TriggerOrder.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

function exists(rel: string): boolean {
  return fs.existsSync(`${REPO_ROOT}/${rel}`);
}

describe("BUG-K19 fix: migration 0009 file exists + is well-formed", () => {
  const migrationPath = "lib/db/migrations/0009_bm25_trigger_order_fix.sql";

  it("migration file exists", () => {
    expect(exists(migrationPath)).toBe(true);
  });

  it("migration drops the buggy trigger name (sorts BEFORE search_tsvector)", () => {
    const source = readSource(migrationPath);
    // The buggy trigger from migration 0007 was named
    // `ai_kb_entries_bm25_doclength_trigger` — sorts BEFORE
    // `ai_kb_entries_search_tsvector_trigger` because 'b' < 's'.
    expect(source).toMatch(
      /DROP\s+TRIGGER\s+IF\s+EXISTS\s+ai_kb_entries_bm25_doclength_trigger\s+ON\s+ai_kb_entries/i,
    );
  });

  it("migration drops the buggy function so it can be recreated cleanly", () => {
    const source = readSource(migrationPath);
    expect(source).toMatch(
      /DROP\s+FUNCTION\s+IF\s+EXISTS\s+ai_kb_entries_bm25_doclength_update\(\)/i,
    );
  });

  it("migration recreates the function with `OR REPLACE` (idempotent)", () => {
    const source = readSource(migrationPath);
    expect(source).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+ai_kb_entries_bm25_doclength_update\(\)/i,
    );
  });

  it("migration creates the new trigger with `zz_` prefix (sorts AFTER search_tsvector)", () => {
    const source = readSource(migrationPath);
    // `zz_` sorts AFTER `ai_` in ASCII / UTF-8 collation, so the new
    // trigger fires AFTER `ai_kb_entries_search_tsvector_trigger`.
    expect(source).toMatch(/CREATE\s+TRIGGER\s+zz_ai_kb_entries_bm25_doclength_trigger/i);
  });

  it("new trigger fires BEFORE INSERT OR UPDATE OF title, content (same as old)", () => {
    const source = readSource(migrationPath);
    // The trigger event spec must match the original (BEFORE INSERT OR
    // UPDATE OF title, content) so it still maintains bm25_doc_length
    // on the same operations.
    expect(source).toMatch(/BEFORE\s+INSERT\s+OR\s+UPDATE\s+OF\s+title,\s*content/i);
  });

  it("new trigger is FOR EACH ROW", () => {
    const source = readSource(migrationPath);
    expect(source).toMatch(/FOR\s+EACH\s+ROW/i);
  });
});

describe("BUG-K19 fix: migration backfills bm25_doc_length + refreshes stats", () => {
  const source = readSource("lib/db/migrations/0009_bm25_trigger_order_fix.sql");

  it("backfills bm25_doc_length for existing rows (recompute from search_tsvector)", () => {
    expect(source).toMatch(/UPDATE\s+ai_kb_entries\s+SET\s+bm25_doc_length\s*=/i);
    expect(source).toMatch(/unnest\(search_tsvector\)/i);
  });

  it("backfill is guarded by `WHERE search_tsvector IS NOT NULL` (skip empty rows)", () => {
    expect(source).toMatch(/WHERE\s+search_tsvector\s+IS\s+NOT\s+NULL/i);
  });

  it("calls refresh_kb_term_stats() so bm25_score uses corrected doc lengths", () => {
    // The refresh function is defined in migration 0007. We call it
    // conditionally (only if it exists) to be safe on partial migrations.
    expect(source).toMatch(/refresh_kb_term_stats\(\)/);
  });

  it("refresh_kb_term_stats call is guarded by an EXISTS check (safe if function missing)", () => {
    // If migration 0007 wasn't applied (partial migration scenario), the
    // function doesn't exist — calling it would error. The guard makes
    // the migration safe.
    expect(source).toMatch(
      /WHERE\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_proc\s+WHERE\s+proname\s*=\s*'refresh_kb_term_stats'/i,
    );
  });
});

describe("BUG-K19 fix: trigger function comment explains the ordering rule", () => {
  const source = readSource("lib/db/migrations/0009_bm25_trigger_order_fix.sql");

  it("comment mentions alphabetical name ordering", () => {
    expect(source).toMatch(/alphabetical\s+name\s+order/i);
  });

  it("comment explains why zz_ prefix is used", () => {
    // The comment must explain that zz_ sorts AFTER ai_ so the trigger
    // fires after the search_tsvector trigger.
    expect(source).toMatch(/zz_/i);
    expect(source).toMatch(/sorts?\s+AFTER/i);
  });

  it("comment references migration 0006 (where the search_tsvector trigger is defined)", () => {
    expect(source).toMatch(/migration\s+0006/i);
  });

  it("comment references the original buggy name", () => {
    // Future maintainers need to know the old name + why we renamed,
    // so they don't accidentally rename it back.
    expect(source).toMatch(/ai_kb_entries_bm25_doclength_trigger/);
    expect(source).toMatch(/sorts?\s+BEFORE/i);
  });
});

describe("BUG-K19 fix: migration is idempotent (safe to re-run)", () => {
  const source = readSource("lib/db/migrations/0009_bm25_trigger_order_fix.sql");

  it("DROP TRIGGER uses IF EXISTS", () => {
    expect(source).toMatch(/DROP\s+TRIGGER\s+IF\s+EXISTS/i);
  });

  it("DROP FUNCTION uses IF EXISTS", () => {
    expect(source).toMatch(/DROP\s+FUNCTION\s+IF\s+EXISTS/i);
  });

  it("CREATE FUNCTION uses OR REPLACE", () => {
    expect(source).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
  });

  it("CREATE TRIGGER is preceded by DROP TRIGGER IF EXISTS (CREATE TRIGGER has no OR REPLACE)", () => {
    // PostgreSQL's CREATE TRIGGER doesn't support OR REPLACE until PG 14+,
    // and even then only for the same name. We DROP first to be safe.
    // The DROP and CREATE must both target `zz_ai_kb_entries_bm25_doclength_trigger`.
    expect(source).toMatch(
      /DROP\s+TRIGGER\s+IF\s+EXISTS\s+zz_ai_kb_entries_bm25_doclength_trigger/i,
    );
  });
});

describe("BUG-K19 fix: migration 0007 is NOT modified", () => {
  it("migration 0007 has no recent git modifications", () => {
    // We can't easily check git history in a unit test, but we can verify
    // the file still contains the buggy trigger name (proof it wasn't
    // edited to drop + rename). The fix lives in migration 0009 only.
    const source = readSource("lib/db/migrations/0007_bm25_reranker.sql");
    // The original buggy CREATE TRIGGER statement must still be present
    // in 0007 (we don't edit shipped migrations).
    expect(source).toMatch(/CREATE\s+TRIGGER\s+ai_kb_entries_bm25_doclength_trigger/i);
    expect(source).toMatch(/ai_kb_entries_bm25_doclength_update\(\)/i);
  });
});

describe("BUG-K19 fix: Drizzle migration journal includes 0009", () => {
  it("_journal.json parses as valid JSON", () => {
    const raw = readSource("lib/db/migrations/meta/_journal.json");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("_journal.json includes an entry for 0009_bm25_trigger_order_fix", () => {
    const raw = readSource("lib/db/migrations/meta/_journal.json");
    const journal = JSON.parse(raw) as { entries: { tag: string }[] };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags).toContain("0009_bm25_trigger_order_fix");
  });

  it("_journal.json also includes 0008_kb_content_version (BUG-3 fix)", () => {
    // Sanity check — both new migrations should be journaled.
    const raw = readSource("lib/db/migrations/meta/_journal.json");
    const journal = JSON.parse(raw) as { entries: { tag: string }[] };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags).toContain("0008_kb_content_version");
  });
});

describe("BUG-K19 fix: verification query is documented in the migration", () => {
  const source = readSource("lib/db/migrations/0009_bm25_trigger_order_fix.sql");

  it("documents the trigger-ordering verification query", () => {
    // The migration should include (as a comment) the SQL an operator
    // can run to verify the trigger firing order is correct.
    expect(source).toMatch(/SELECT\s+tgname\s+FROM\s+pg_trigger/i);
    expect(source).toMatch(/tgtype\s*&\s*2\s*=\s*2/i);
  });

  it("documents the bm25_doc_length backfill verification query", () => {
    expect(source).toMatch(/COUNT\(\*\)\s+FILTER\s*\(\s*WHERE\s+bm25_doc_length\s*=\s*0\)/i);
  });
});

describe("BUG-K19 fix: file path sanity", () => {
  it("migration file is at the expected path", () => {
    const expected = "lib/db/migrations/0009_bm25_trigger_order_fix.sql";
    expect(exists(expected)).toBe(true);
    // Sanity check: also verify the parent directory exists.
    const dir = path.dirname(`${REPO_ROOT}/${expected}`);
    expect(fs.existsSync(dir)).toBe(true);
  });
});
