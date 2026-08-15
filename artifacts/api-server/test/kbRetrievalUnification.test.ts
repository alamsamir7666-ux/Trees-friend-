/**
 * BUG-I1 fix: unified KB retrieval contract tests.
 *
 * Verifies that the auto-inject path (getTopKbEntriesForPrompt in
 * kbSearch.ts) and the tool path (searchKb in aiTools.ts) use the SAME
 * retrieval parameters (minScore, skipRerank, maxResults, content
 * truncation). Previously they diverged, causing the LLM to see two
 * different views of the KB for the same query.
 *
 * Uses source-shape inspection (same pattern as `kbCategories.test.ts`,
 * `toolCallCache.test.ts`, `rerankerFallbackCache.test.ts`).
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/kbRetrievalUnification.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

const REPO_ROOT = "/home/z/my-project/Trees-friend-";

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

describe("BUG-I1 fix: kbSearch.ts defines UNIFIED_* constants", () => {
  const source = readSource("artifacts/api-server/src/lib/kbSearch.ts");

  it("defines UNIFIED_MIN_SCORE = 0.3", () => {
    expect(source).toContain("UNIFIED_MIN_SCORE = 0.3");
  });

  it("defines UNIFIED_MAX_RESULTS = 5", () => {
    expect(source).toContain("UNIFIED_MAX_RESULTS = 5");
  });

  it("defines UNIFIED_SKIP_RERANK = false", () => {
    expect(source).toContain("UNIFIED_SKIP_RERANK = false");
  });

  it("defines UNIFIED_CONTENT_TRUNCATE_CHARS = 500", () => {
    expect(source).toContain("UNIFIED_CONTENT_TRUNCATE_CHARS = 500");
  });
});

describe("BUG-I1 fix: UNIFIED_* constants are exported", () => {
  const source = readSource("artifacts/api-server/src/lib/kbSearch.ts");

  it("UNIFIED_MIN_SCORE is exported", () => {
    expect(source).toMatch(/export\s+const\s+UNIFIED_MIN_SCORE/);
  });

  it("UNIFIED_CONTENT_TRUNCATE_CHARS is exported", () => {
    expect(source).toMatch(/export\s+const\s+UNIFIED_CONTENT_TRUNCATE_CHARS/);
  });

  it("UNIFIED_MAX_RESULTS is exported", () => {
    expect(source).toMatch(/export\s+const\s+UNIFIED_MAX_RESULTS/);
  });

  it("UNIFIED_SKIP_RERANK is exported", () => {
    expect(source).toMatch(/export\s+const\s+UNIFIED_SKIP_RERANK/);
  });
});

describe("BUG-I1 fix: getTopKbEntriesForPrompt uses unified config", () => {
  const source = readSource("artifacts/api-server/src/lib/kbSearch.ts");

  it("default maxEntries is UNIFIED_MAX_RESULTS (was MAX_AUTO_INJECT_ENTRIES = 3)", () => {
    expect(source).toMatch(/maxEntries:\s*number\s*=\s*UNIFIED_MAX_RESULTS/);
  });

  it("passes UNIFIED_MIN_SCORE to searchKnowledgeBase", () => {
    expect(source).toMatch(/getTopKbEntriesForPrompt[\s\S]*?minScore:\s*UNIFIED_MIN_SCORE/);
  });

  it("passes UNIFIED_SKIP_RERANK to searchKnowledgeBase (was hardcoded true)", () => {
    expect(source).toMatch(/getTopKbEntriesForPrompt[\s\S]*?skipRerank:\s*UNIFIED_SKIP_RERANK/);
  });
});

describe("BUG-I1 fix: old divergent constants are removed", () => {
  const source = readSource("artifacts/api-server/src/lib/kbSearch.ts");

  it("MIN_SCORE_AUTO_INJECT is removed (was 0.5)", () => {
    // The old constant caused the auto-inject path to use a higher
    // threshold than the tool path. It must be gone.
    expect(source).not.toContain("MIN_SCORE_AUTO_INJECT");
  });

  it("MAX_AUTO_INJECT_ENTRIES is removed (was 3)", () => {
    expect(source).not.toContain("MAX_AUTO_INJECT_ENTRIES");
  });
});

describe("BUG-I1 fix: formatKbContextForPrompt uses UNIFIED_CONTENT_TRUNCATE_CHARS", () => {
  const source = readSource("artifacts/api-server/src/lib/kbSearch.ts");

  it("formatKbContextForPrompt truncates content using UNIFIED_CONTENT_TRUNCATE_CHARS", () => {
    // Previously the truncation used a hardcoded `500`. Now both paths
    // use the shared constant.
    expect(source).toMatch(/r\.entry\.content\.length\s*>\s*UNIFIED_CONTENT_TRUNCATE_CHARS/);
    expect(source).toMatch(/r\.entry\.content\.slice\(0,\s*UNIFIED_CONTENT_TRUNCATE_CHARS\)/);
  });
});

describe("BUG-I1 fix: routes/ai.ts calls getTopKbEntriesForPrompt without explicit 3", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("calls getTopKbEntriesForPrompt(safeMessage) without the explicit `3` arg", () => {
    // The old call was `getTopKbEntriesForPrompt(safeMessage, 3)` —
    // the explicit `3` was part of the divergent config. The unified
    // default (5) is now used.
    // We check the actual call (an await statement), not comments.
    expect(source).toMatch(/await\s+getTopKbEntriesForPrompt\(safeMessage\)/);
  });

  it("does NOT have an executable call with the explicit `3` arg", () => {
    // Strip comments before checking — the BUG-I1 fix comment mentions
    // the old call shape for documentation purposes.
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/getTopKbEntriesForPrompt\(safeMessage,\s*3\)/);
  });
});

describe("BUG-I1 fix: aiTools.ts searchKb uses unified config", () => {
  const source = readSource("artifacts/api-server/src/lib/aiTools.ts");

  it("imports UNIFIED_MIN_SCORE from kbSearch", () => {
    expect(source).toMatch(
      /import\s*\{[\s\S]*?UNIFIED_MIN_SCORE[\s\S]*?\}\s*from\s*["']\.\/kbSearch["']/,
    );
  });

  it("imports UNIFIED_CONTENT_TRUNCATE_CHARS from kbSearch", () => {
    expect(source).toMatch(
      /import\s*\{[\s\S]*?UNIFIED_CONTENT_TRUNCATE_CHARS[\s\S]*?\}\s*from\s*["']\.\/kbSearch["']/,
    );
  });

  it("searchKb uses UNIFIED_MIN_SCORE (not hardcoded 0.3)", () => {
    expect(source).toMatch(/minScore:\s*UNIFIED_MIN_SCORE/);
    // The old hardcoded `minScore: 0.3` should NOT remain in executable
    // code. Strip comments before checking — the BUG-I1 fix comment
    // mentions the old `0.3` value for documentation purposes.
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/minScore:\s*0\.3/);
  });

  it("searchKb truncates content using UNIFIED_CONTENT_TRUNCATE_CHARS", () => {
    expect(source).toMatch(/r\.entry\.content\.slice\(0,\s*UNIFIED_CONTENT_TRUNCATE_CHARS\)/);
  });

  it("searchKb appends … (ellipsis) on truncation", () => {
    expect(source).toMatch(
      /r\.entry\.content\.slice\(0,\s*UNIFIED_CONTENT_TRUNCATE_CHARS\)\s*\+\s*["']…["']/,
    );
  });

  it("searchKb no longer returns bare r.entry.content as the content field", () => {
    // The old code had `content: r.entry.content,` (no truncation).
    // The new code uses a conditional expression. Verify the bare
    // assignment is gone.
    // We look for `content: r.entry.content,` as a standalone line
    // (with trailing comma + newline) — the new code has
    // `content:\n  r.entry.content.length > ...`
    expect(source).not.toMatch(/^\s*content:\s*r\.entry\.content,\s*$/m);
  });
});

describe("BUG-I1 fix: tool declaration mentions auto-inject consistency", () => {
  const source = readSource("artifacts/api-server/src/lib/aiTools.ts");

  it("max_results description mentions auto-injected KB block", () => {
    // The description should tell the LLM that the auto-injected block
    // also returns up to 5 entries — so if an entry appears in both,
    // they're the same source (cite once).
    expect(source).toMatch(/auto-injected/i);
    expect(source).toMatch(/cite once/i);
  });
});

describe("BUG-I1 fix: aiContext.ts system prompt documents unified behavior", () => {
  const source = readSource("artifacts/api-server/src/lib/aiContext.ts");

  it("system prompt mentions SAME retrieval parameters", () => {
    expect(source).toMatch(/SAME retrieval parameters/i);
  });

  it("system prompt documents the unified contract (minScore, reranked, 5 entries, 500 chars)", () => {
    // The prompt must tell the LLM the exact parameters so it knows the
    // two paths are consistent.
    expect(source).toMatch(/minScore=0\.3/i);
    expect(source).toMatch(/reranked/i);
    expect(source).toMatch(/5 entries max/i);
    expect(source).toMatch(/500 chars per entry/i);
  });

  it("system prompt tells the LLM to cite only once if entry appears in both", () => {
    expect(source).toMatch(/cite it only once/i);
  });

  it("system prompt references the BUG-I1 fix", () => {
    expect(source).toMatch(/BUG-I1/);
  });
});

describe("BUG-I1 fix: back-compat aliases preserved", () => {
  const source = readSource("artifacts/api-server/src/lib/kbSearch.ts");

  it("MAX_RESULTS_DEFAULT is preserved as a deprecated alias", () => {
    // The brief says: "preserve the existing MAX_RESULTS_DEFAULT and
    // MIN_SCORE_DEFAULT constants (mark them as deprecated aliases for
    // back-compat with existing tests) — don't delete them outright
    // unless no tests reference them."
    expect(source).toMatch(/MAX_RESULTS_DEFAULT\s*=\s*UNIFIED_MAX_RESULTS/);
  });

  it("MIN_SCORE_DEFAULT is preserved as a deprecated alias", () => {
    expect(source).toMatch(/MIN_SCORE_DEFAULT\s*=\s*UNIFIED_MIN_SCORE/);
  });

  it("MAX_RESULTS_CAP is preserved (used by the tool to cap max_results)", () => {
    expect(source).toContain("MAX_RESULTS_CAP = 10");
  });
});
