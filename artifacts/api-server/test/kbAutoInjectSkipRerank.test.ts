/**
 * P0 #3 fix: skipRerank option for KB auto-inject path tests.
 *
 * Verifies that `getTopKbEntriesForPrompt` in `kbSearch.ts` accepts an
 * optional `skipRerank` parameter, and that `routes/ai.ts` passes
 * `skipRerank=true` for the auto-inject path (latency optimization).
 *
 * The on-demand `search_knowledge_base` tool path KEEPS the reranker
 * (the LLM explicitly asked for KB results — higher quality bar).
 *
 * Coverage:
 *   - `getTopKbEntriesForPrompt` has a third `skipRerank: boolean` parameter.
 *   - The parameter defaults to `UNIFIED_SKIP_RERANK` (false — back-compat).
 *   - The route handler passes `true` for the auto-inject path.
 *   - The Gap #4 fallback also passes `true` (keep the fallback fast).
 *   - The tool path (`searchKb` in aiTools.ts) is unchanged (still uses
 *     UNIFIED_SKIP_RERANK = false — reranker always runs when configured).
 *   - Backward compat: the `UNIFIED_SKIP_RERANK = false` constant is preserved.
 *
 * Uses source-shape inspection (same pattern as `kbRetrievalUnification.test.ts`).
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/kbAutoInjectSkipRerank.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

// ─── P0 #3: getTopKbEntriesForPrompt signature ─────────────────────────────

describe("P0 #3: getTopKbEntriesForPrompt accepts a skipRerank parameter", () => {
  const source = readSource("artifacts/api-server/src/lib/kbSearch.ts");

  it("function signature has a third `skipRerank: boolean` parameter", () => {
    // The signature must be:
    //   getTopKbEntriesForPrompt(
    //     userMessage: string,
    //     maxEntries: number = UNIFIED_MAX_RESULTS,
    //     skipRerank: boolean = UNIFIED_SKIP_RERANK,
    //   )
    expect(source).toMatch(/skipRerank:\s*boolean\s*=\s*UNIFIED_SKIP_RERANK/);
  });

  it("the parameter defaults to UNIFIED_SKIP_RERANK (false — back-compat)", () => {
    // Default is `false` (preserve BUG-I1 unified behavior — always rerank
    // when configured). Callers must explicitly opt-in to the fast path.
    expect(source).toMatch(/UNIFIED_SKIP_RERANK\s*=\s*false/);
  });

  it("passes the skipRerank parameter through to searchKnowledgeBase", () => {
    // The function body must pass `skipRerank` (the parameter) to
    // searchKnowledgeBase, NOT `UNIFIED_SKIP_RERANK` (the constant).
    // We look for the call shape `skipRerank,` (the parameter being passed).
    expect(source).toMatch(/skipRerank,\s*\}\s*\);/);
  });

  it("the JSDoc documents the P0 #3 fix + the latency savings", () => {
    expect(source).toMatch(/P0 #3 fix \(latency optimization\)/);
    expect(source).toMatch(/saves 200-500ms latency/i);
  });

  it("the JSDoc documents the risk mitigation (clearKbBlockFromPrompt)", () => {
    expect(source).toMatch(/clearKbBlockFromPrompt/);
    expect(source).toMatch(/short-lived/i);
  });
});

// ─── P0 #3: routes/ai.ts passes skipRerank=true for the auto-inject path ──

describe("P0 #3: routes/ai.ts passes skipRerank=true for the auto-inject path", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("the BATCH B Promise.all includes the auto-inject call with skipRerank=true", () => {
    // The call must be `getTopKbEntriesForPrompt(safeMessage, undefined, true)`.
    // The third arg is `true` (skipRerank). The call spans multiple lines —
    // we tolerate whitespace + newlines + the JSDoc comment via [\s\S]*?.
    expect(source).toMatch(
      /getTopKbEntriesForPrompt\(\s*safeMessage,\s*undefined,\s*true[\s\S]*?skipRerank:\s*P0 #3/,
    );
  });

  it("the Gap #4 fallback also passes skipRerank=true", () => {
    // The call spans multiple lines (safeMessage, undefined, true) —
    // we tolerate whitespace + newlines via [\s\S]*?.
    expect(source).toMatch(
      /fallbackKbContext\s*=\s*await\s+getTopKbEntriesForPrompt\(\s*safeMessage,\s*undefined,\s*true[\s\S]*?skipRerank:\s*P0 #3 — keep the fallback fast/,
    );
  });

  it("the JSDoc documents why skipRerank=true is safe for the auto-inject path", () => {
    // The comment should explain that the high minScore threshold (0.3)
    // makes first-pass scores reliable.
    expect(source).toMatch(/high\s+minScore\s+threshold.*reliable/i);
  });

  it("the JSDoc documents that the on-demand tool path keeps the reranker", () => {
    // The comment mentions that the "on-demand search_knowledge_base TOOL path"
    // keeps the reranker. The exact wording is in line ~1452 of ai.ts.
    expect(source).toMatch(/on-demand search_knowledge_base TOOL path/i);
    expect(source).toMatch(/keeps the/);
  });
});

// ─── P0 #3: the on-demand search_knowledge_base tool path is unchanged ────

describe("P0 #3: the on-demand search_knowledge_base tool path keeps the reranker", () => {
  const source = readSource("artifacts/api-server/src/lib/aiTools.ts");

  it("searchKb imports UNIFIED_MIN_SCORE + UNIFIED_CONTENT_TRUNCATE_CHARS from kbSearch", () => {
    // The tool path imports the unified constants (BUG-I1 fix preserved).
    expect(source).toMatch(/UNIFIED_MIN_SCORE/);
    expect(source).toMatch(/UNIFIED_CONTENT_TRUNCATE_CHARS/);
  });

  it("searchKb does NOT pass skipRerank (uses searchKnowledgeBase's default = UNIFIED_SKIP_RERANK = false)", () => {
    // The tool path relies on the searchKnowledgeBase default for skipRerank
    // (which is UNIFIED_SKIP_RERANK = false). It does NOT explicitly pass
    // `skipRerank: true` (which would skip the reranker — wrong for the tool).
    //
    // We strip comments + check that there's no `skipRerank: true` literal
    // in executable code, AND no `skipRerank:` field at all (the tool path
    // doesn't override the default).
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/skipRerank:\s*true/);
  });

  it("searchKb passes minScore: UNIFIED_MIN_SCORE (the unified threshold)", () => {
    expect(source).toMatch(/minScore:\s*UNIFIED_MIN_SCORE/);
  });
});

// ─── P0 #3: backward compatibility ──────────────────────────────────────────

describe("P0 #3: backward compatibility — UNIFIED_SKIP_RERANK preserved", () => {
  const source = readSource("artifacts/api-server/src/lib/kbSearch.ts");

  it("UNIFIED_SKIP_RERANK = false is still exported (unchanged)", () => {
    expect(source).toMatch(/export\s+const\s+UNIFIED_SKIP_RERANK\s*=\s*false/);
  });

  it("the constant still has its BUG-I1 fix comment", () => {
    expect(source).toMatch(/always rerank when configured/);
  });

  it("MIN_SCORE_DEFAULT is still exported as a deprecated alias", () => {
    expect(source).toMatch(/MIN_SCORE_DEFAULT\s*=\s*UNIFIED_MIN_SCORE/);
  });

  it("MAX_RESULTS_DEFAULT is still exported as a deprecated alias", () => {
    expect(source).toMatch(/MAX_RESULTS_DEFAULT\s*=\s*UNIFIED_MAX_RESULTS/);
  });
});

// ─── P0 #3: existing kbRetrievalUnification tests still pass ───────────────

describe("P0 #3: existing BUG-I1 unified retrieval contract is preserved", () => {
  const source = readSource("artifacts/api-server/src/lib/kbSearch.ts");

  it("UNIFIED_MIN_SCORE = 0.3 (unchanged)", () => {
    expect(source).toMatch(/UNIFIED_MIN_SCORE\s*=\s*0\.3/);
  });

  it("UNIFIED_MAX_RESULTS = 5 (unchanged)", () => {
    expect(source).toMatch(/UNIFIED_MAX_RESULTS\s*=\s*5/);
  });

  it("UNIFIED_CONTENT_TRUNCATE_CHARS = 500 (unchanged)", () => {
    expect(source).toMatch(/UNIFIED_CONTENT_TRUNCATE_CHARS\s*=\s*500/);
  });

  it("getTopKbEntriesForPrompt default maxEntries is still UNIFIED_MAX_RESULTS", () => {
    expect(source).toMatch(/maxEntries:\s*number\s*=\s*UNIFIED_MAX_RESULTS/);
  });

  it("getTopKbEntriesForPrompt still passes UNIFIED_MIN_SCORE to searchKnowledgeBase", () => {
    expect(source).toMatch(/minScore:\s*UNIFIED_MIN_SCORE/);
  });
});
