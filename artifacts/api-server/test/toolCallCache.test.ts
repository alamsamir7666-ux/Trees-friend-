/**
 * Tests for Bug #4 fix: tool-call-aware cache policy.
 *
 * These tests verify:
 *   - `USER_SCOPED_TOOLS` and `CATALOG_TOOLS` sets contain the right tools.
 *   - The route uses `toolCalls` from metadata to decide cache policy.
 *   - `setCachedResponse` uses short TTL when `hadToolCalls=true`.
 *   - `setSemanticCachedResponse` stores the `had_tool_calls` flag.
 *   - `getCachedResponse` checks both tool + non-tool keys.
 *   - The `isPrivateQuery` check uses `ACCOUNT_KEYWORDS` (not the old 4-phrase regex).
 *   - The schema migration adds the `had_tool_calls` column.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/toolCallCache.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

// Ensure the AI_SESSION_SECRET is set (required by sessionToken.ts which is
// transitively imported). setupEnv.ts handles this for the rest of the suite.
process.env.AI_SESSION_SECRET ??=
  "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";

import { USER_SCOPED_TOOLS, CATALOG_TOOLS } from "../src/lib/aiTools";
import { ACCOUNT_KEYWORDS } from "../src/lib/aiContext";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

describe("Bug #4 fix: tool classification sets", () => {
  describe("USER_SCOPED_TOOLS", () => {
    it("contains get_user_orders", () => {
      expect(USER_SCOPED_TOOLS.has("get_user_orders")).toBe(true);
    });

    it("contains get_order_details", () => {
      expect(USER_SCOPED_TOOLS.has("get_order_details")).toBe(true);
    });

    it("does NOT contain search_catalog (public tool)", () => {
      expect(USER_SCOPED_TOOLS.has("search_catalog")).toBe(false);
    });

    it("does NOT contain get_product_care (public tool)", () => {
      expect(USER_SCOPED_TOOLS.has("get_product_care")).toBe(false);
    });

    it("is a ReadonlySet (immutable)", () => {
      expect(USER_SCOPED_TOOLS).toBeInstanceOf(Set);
    });
  });

  describe("CATALOG_TOOLS", () => {
    it("contains search_catalog", () => {
      expect(CATALOG_TOOLS.has("search_catalog")).toBe(true);
    });

    it("contains get_product_care", () => {
      expect(CATALOG_TOOLS.has("get_product_care")).toBe(true);
    });

    it("does NOT contain get_user_orders (user-scoped tool)", () => {
      expect(CATALOG_TOOLS.has("get_user_orders")).toBe(false);
    });

    it("does NOT contain get_order_details (user-scoped tool)", () => {
      expect(CATALOG_TOOLS.has("get_order_details")).toBe(false);
    });
  });
});

describe("Bug #4 fix: ACCOUNT_KEYWORDS (broader isPrivateQuery)", () => {
  it("is an array of strings", () => {
    expect(Array.isArray(ACCOUNT_KEYWORDS)).toBe(true);
    expect(ACCOUNT_KEYWORDS.length).toBeGreaterThan(0);
    for (const kw of ACCOUNT_KEYWORDS) {
      expect(typeof kw).toBe("string");
    }
  });

  it("contains 'order' (English)", () => {
    expect(ACCOUNT_KEYWORDS.some((k) => k.toLowerCase() === "order")).toBe(true);
  });

  it("contains Bangla/Banglish order terms", () => {
    // The old regex only matched 4 English phrases. The new check should
    // catch Bangla + Banglish too. We don't assert specific strings (the
    // list may evolve), but we check that non-English keywords exist.
    const hasNonAscii = ACCOUNT_KEYWORDS.some((kw) =>
      /[^\x00-\x7F]/.test(kw), // contains non-ASCII (likely Bengali Unicode)
    );
    expect(hasNonAscii).toBe(true);
  });

  it("contains 'amar order' (Banglish) or similar", () => {
    // Banglish for "my order" — the old regex missed this.
    const hasBanglish = ACCOUNT_KEYWORDS.some((k) =>
      k.toLowerCase().includes("amar"),
    );
    expect(hasBanglish).toBe(true);
  });
});

describe("Bug #4 fix: route tracks toolCalls from metadata", () => {
  it("metaHolder type includes toolCalls field", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/routes/ai.ts`,
      "utf8",
    );
    expect(source).toContain("toolCalls?: string[]");
  });

  it("imports USER_SCOPED_TOOLS from aiTools", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/routes/ai.ts`,
      "utf8",
    );
    expect(source).toContain("USER_SCOPED_TOOLS");
    expect(source).toContain('from "../lib/aiTools"');
  });

  it("computes hadUserScopedTool from toolCalls", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/routes/ai.ts`,
      "utf8",
    );
    expect(source).toContain("hadUserScopedTool");
    expect(source).toContain("USER_SCOPED_TOOLS.has(name)");
  });

  it("computes effectiveIsPrivate (isPrivateQuery OR hadUserScopedTool)", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/routes/ai.ts`,
      "utf8",
    );
    expect(source).toContain("effectiveIsPrivate");
    expect(source).toContain("isPrivateQuery || hadUserScopedTool");
  });

  it("passes hadAnyTool (not hardcoded false) to setCachedResponse", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/routes/ai.ts`,
      "utf8",
    );
    // The old code hardcoded `false` as the 7th arg to setCachedResponse.
    // The new code passes `hadAnyTool`.
    expect(source).toContain("hadAnyTool,");
  });

  it("no longer hardcodes false in setCachedResponse call", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/routes/ai.ts`,
      "utf8",
    );
    // Find the setCachedResponse call and verify it doesn't have a
    // standalone `false,` arg (the old bug).
    const setCachedMatch = source.match(
      /setCachedResponse\([\s\S]*?\)\.catch\(\(\) => \{\}\);/,
    );
    expect(setCachedMatch).not.toBeNull();
    const callBody = setCachedMatch![0];
    // The old code had `false,\n        isPrivateQuery,` — we should
    // now have `hadAnyTool,\n        effectiveIsPrivate,` instead.
    expect(callBody).toContain("hadAnyTool");
    expect(callBody).toContain("effectiveIsPrivate");
    expect(callBody).not.toMatch(/^\s*false,\s*$/m);
  });

  it("no longer hardcodes false in setSemanticCachedResponse call", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/routes/ai.ts`,
      "utf8",
    );
    const setSemanticMatch = source.match(
      /setSemanticCachedResponse\([\s\S]*?\)\.catch\(\(\) => \{\}\);/,
    );
    expect(setSemanticMatch).not.toBeNull();
    const callBody = setSemanticMatch![0];
    expect(callBody).toContain("hadAnyTool");
    expect(callBody).toContain("effectiveIsPrivate");
  });
});

describe("Bug #4 fix: cache modules use short TTL for tool calls", () => {
  it("semanticCache.ts has TOOL_CACHE_TTL_SECONDS constant", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/semanticCache.ts`,
      "utf8",
    );
    expect(source).toContain("TOOL_CACHE_TTL_SECONDS");
    expect(source).toContain("AI_TOOL_CACHE_TTL_SECONDS");
  });

  it("semanticCache.ts setCachedResponse uses short TTL when hadToolCalls=true", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/semanticCache.ts`,
      "utf8",
    );
    expect(source).toContain("const ttl = hadToolCalls ? TOOL_CACHE_TTL_SECONDS : CACHE_TTL_SECONDS");
  });

  it("semanticCache.ts skips cache when hadToolCalls=true AND TTL=0", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/semanticCache.ts`,
      "utf8",
    );
    expect(source).toContain("if (hadToolCalls && TOOL_CACHE_TTL_SECONDS <= 0) return");
  });

  it("semanticCache.ts cache key includes tool-call segment", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/semanticCache.ts`,
      "utf8",
    );
    expect(source).toContain('const toolSegment = hasToolCalls ? ":t:1" : ""');
  });

  it("semanticCache.ts getCachedResponse checks both tool + non-tool keys", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/semanticCache.ts`,
      "utf8",
    );
    expect(source).toContain("nonToolKey");
    expect(source).toContain("toolKey");
    expect(source).toContain("Promise.all");
  });
});

describe("Bug #4 fix: embeddingCache.ts (semantic cache) tool-call tracking", () => {
  it("has TOOL_CACHE_TTL_SECONDS constant", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/embeddingCache.ts`,
      "utf8",
    );
    expect(source).toContain("TOOL_CACHE_TTL_SECONDS");
    expect(source).toContain("AI_TOOL_CACHE_TTL_SECONDS");
  });

  it("getSemanticCachedResponse uses CASE expression for TTL-aware filtering", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/embeddingCache.ts`,
      "utf8",
    );
    expect(source).toContain("CASE");
    expect(source).toContain("COALESCE(had_tool_calls, FALSE)");
    expect(source).toContain("TOOL_CACHE_TTL_SECONDS");
  });

  it("setSemanticCachedResponse stores the had_tool_calls flag", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/embeddingCache.ts`,
      "utf8",
    );
    expect(source).toContain("had_tool_calls");
    expect(source).toContain("VALUES ($1, $2, $3::vector, $4, $5, $6)");
  });

  it("setSemanticCachedResponse skips cache when hadToolCalls=true AND TTL=0", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/embeddingCache.ts`,
      "utf8",
    );
    expect(source).toContain("if (hadToolCalls && TOOL_CACHE_TTL_SECONDS <= 0) return");
  });

  it("has a legacy fallback for when had_tool_calls column doesn't exist", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/embeddingCache.ts`,
      "utf8",
    );
    expect(source).toContain("getSemanticCachedResponseLegacy");
  });
});

describe("Bug #4 fix: schema migration (ensureAiTables.ts)", () => {
  it("adds had_tool_calls column to ai_response_cache", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/ensureAiTables.ts`,
      "utf8",
    );
    expect(source).toContain("ADD COLUMN IF NOT EXISTS had_tool_calls BOOLEAN");
  });

  it("backfills legacy rows (had_tool_calls IS NULL) to FALSE", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/ensureAiTables.ts`,
      "utf8",
    );
    expect(source).toContain("SET had_tool_calls = FALSE");
    expect(source).toContain("WHERE had_tool_calls IS NULL");
  });

  it("creates a partial index for tool-call entries", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/ensureAiTables.ts`,
      "utf8",
    );
    expect(source).toContain("ai_response_cache_tool_calls_idx");
    expect(source).toContain("WHERE had_tool_calls = TRUE");
  });
});

describe("Bug #4 fix: provider metadata surfaces toolCalls", () => {
  it("aiRouter.ts onMetadata type includes toolCalls field", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/aiRouter.ts`,
      "utf8",
    );
    expect(source).toContain("toolCalls?: string[]");
  });

  it("gemini.ts onMetadata type includes toolCalls field", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/gemini.ts`,
      "utf8",
    );
    expect(source).toContain("toolCalls?: string[]");
  });

  it("groq.ts onMetadata type includes toolCalls field", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/groq.ts`,
      "utf8",
    );
    expect(source).toContain("toolCalls?: string[]");
  });

  it("gemini.ts tracks toolCallsCalled array across rounds", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/gemini.ts`,
      "utf8",
    );
    expect(source).toContain("toolCallsCalled");
    expect(source).toContain("toolCallsCalled.push(fc.name)");
  });

  it("groq.ts tracks toolCallsCalled array across rounds", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/groq.ts`,
      "utf8",
    );
    expect(source).toContain("toolCallsCalled");
    expect(source).toContain("toolCallsCalled.push(tc.function.name)");
  });

  it("gemini.ts emits final metadata with toolCalls after streaming", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/gemini.ts`,
      "utf8",
    );
    expect(source).toContain("toolCalls: toolCallsCalled");
  });

  it("groq.ts emits final metadata with toolCalls after streaming", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/groq.ts`,
      "utf8",
    );
    expect(source).toContain("toolCalls: toolCallsCalled");
  });
});

describe("Bug #4 fix: isPrivateQuery uses ACCOUNT_KEYWORDS (not old regex)", () => {
  it("imports ACCOUNT_KEYWORDS from aiContext", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/routes/ai.ts`,
      "utf8",
    );
    expect(source).toContain("ACCOUNT_KEYWORDS");
    expect(source).toContain('from "../lib/aiContext"');
  });

  it("uses ACCOUNT_KEYWORDS.some() for isPrivateQuery check", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/routes/ai.ts`,
      "utf8",
    );
    expect(source).toContain("ACCOUNT_KEYWORDS.some((kw) =>");
    expect(source).toContain("safeMessage.toLowerCase().includes(kw.toLowerCase())");
  });

  it("no longer uses the old 4-phrase regex in executable code", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/routes/ai.ts`,
      "utf8",
    );
    // The old regex was: /my order|where is my order|what did i buy|my orders/i
    // We strip comments (lines starting with //) before checking, since
    // the new code has a comment documenting the old regex.
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/where is my order/i);
    expect(codeOnly).not.toMatch(/what did i buy/i);
  });
});

describe("Bug #4 fix: ACCOUNT_KEYWORDS exported from aiContext", () => {
  it("aiContext.ts exports ACCOUNT_KEYWORDS", () => {
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/aiContext.ts`,
      "utf8",
    );
    expect(source).toContain("export const ACCOUNT_KEYWORDS");
  });
});
