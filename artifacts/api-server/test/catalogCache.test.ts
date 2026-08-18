/**
 * BUG-1 fix: catalogCache.ts now clears ALL cache entries (not just tool-call ones).
 *
 * Verifies (via source-shape inspection — same pattern as
 * `toolCallCache.test.ts` + `kbCategories.test.ts`) that:
 *
 *   1. `invalidateRedisCatalogCache()` deletes ALL `ai:cache:*` keys
 *      (no `endsWith(":t:1")` filter).
 *   2. `invalidateSemanticCatalogCache()` runs `DELETE FROM ai_response_cache`
 *      (no `WHERE had_tool_calls = TRUE` clause).
 *   3. `invalidateCatalogCache()` also calls `clearAllRerankCache()`.
 *   4. The misleading docstring about "non-tool entries contain general
 *      botanical knowledge" is gone.
 *   5. The `TOOL_CALL_KEY_SUFFIX` constant is removed (no longer needed).
 *   6. Best-effort behavior: each invalidation runs in its own
 *      `Promise.allSettled` slot, so a Redis outage doesn't block the
 *      pgvector clear and vice versa.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/catalogCache.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

describe("BUG-1 fix: catalogCache.ts clears ALL Redis cache entries (not just tool-call)", () => {
  const source = readSource("artifacts/api-server/src/lib/catalogCache.ts");

  it("invalidateRedisCatalogCache deletes ALL ai:cache:* keys", () => {
    // The fixed function should `redis.del(...keys)` directly (no filter).
    expect(source).toMatch(/await\s+redis\.del\(\.\.\.keys\)/);
  });

  it("invalidateRedisCatalogCache does NOT filter by ':t:1' suffix", () => {
    // The buggy version filtered keys with `keys.filter((k) => k.endsWith(TOOL_CALL_KEY_SUFFIX))`.
    // The fix removes that filter entirely.
    expect(source).not.toMatch(/keys\.filter\([^)]*endsWith/);
    expect(source).not.toMatch(/TOOL_CALL_KEY_SUFFIX/);
  });

  it("TOOL_CALL_KEY_SUFFIX constant is removed", () => {
    expect(source).not.toContain("const TOOL_CALL_KEY_SUFFIX");
  });
});

describe("BUG-1 fix: catalogCache.ts clears ALL pgvector rows (not just tool-call)", () => {
  const source = readSource("artifacts/api-server/src/lib/catalogCache.ts");

  it("invalidateSemanticCatalogCache runs DELETE FROM ai_response_cache with NO WHERE clause", () => {
    // The fixed query is `DELETE FROM ai_response_cache` (no filter).
    expect(source).toMatch(/DELETE\s+FROM\s+ai_response_cache\s*`/);
  });

  it("invalidateSemanticCatalogCache does NOT filter by had_tool_calls = TRUE", () => {
    // The buggy version had `WHERE had_tool_calls = TRUE`. The fix removes it.
    expect(source).not.toMatch(
      /DELETE\s+FROM\s+ai_response_cache\s+WHERE\s+had_tool_calls\s*=\s*TRUE/i,
    );
  });

  it("preserves the had_tool_calls column for analytics (does NOT drop it)", () => {
    // The fix is about removing the WHERE filter, not the column itself.
    // The column is still used by embeddingCache.ts for TTL-aware SELECT.
    expect(source).not.toMatch(/DROP\s+COLUMN\s+had_tool_calls/i);
    expect(source).not.toMatch(/ALTER\s+TABLE.*DROP.*had_tool_calls/i);
  });
});

describe("BUG-1 fix: catalogCache.ts also clears the reranker cache", () => {
  const source = readSource("artifacts/api-server/src/lib/catalogCache.ts");

  it("imports clearAllRerankCache from ./rerankerCache", () => {
    expect(source).toContain('from "./rerankerCache"');
    expect(source).toContain("clearAllRerankCache");
  });

  it("invalidateCatalogCache calls clearAllRerankCache()", () => {
    // The call should be in the Promise.allSettled array alongside the
    // Redis + pgvector invalidations.
    expect(source).toMatch(/clearAllRerankCache\(\)/);
  });

  it("fires all three invalidations in parallel via Promise.allSettled", () => {
    // Three best-effort slots: Redis, pgvector, reranker.
    expect(source).toMatch(
      /Promise\.allSettled\(\s*\[[\s\S]*invalidateRedisCatalogCache\(\)[\s\S]*invalidateSemanticCatalogCache\(\)[\s\S]*clearAllRerankCache\(\)[\s\S]*\]\s*\)/,
    );
  });

  it("logs reranker invalidation failures non-fatally", () => {
    expect(source).toContain("Reranker cache invalidation failed (non-fatal)");
  });

  it("includes reranker count in the success log", () => {
    expect(source).toContain("rerankDeleted: rerankCount");
    expect(source).toContain("rerankDeleted: rerankCount");
  });
});

describe("BUG-1 fix: misleading docstring removed", () => {
  const source = readSource("artifacts/api-server/src/lib/catalogCache.ts");

  it("does NOT contain the false claim about non-tool entries being safe", () => {
    // The buggy docstring said: "We do NOT clear non-tool cache entries
    // because they contain general botanical knowledge that doesn't depend
    // on the catalog." That claim is false (non-tool entries also embed
    // {{knowledge}} + {{catalog}} + {{tone}} blocks) and must be removed.
    expect(source).not.toMatch(/general botanical knowledge/i);
    expect(source).not.toMatch(/doesn't depend on the catalog/i);
    expect(source).not.toMatch(/does not depend on the catalog/i);
  });

  it("does NOT describe tool-call-only filtering in the docstring", () => {
    expect(source).not.toMatch(/delete all keys matching\s*`ai:cache:\*:t:1`/i);
    expect(source).not.toMatch(/had_tool_calls\s*=\s*TRUE.*same rationale/i);
  });

  it("documents that ALL entries are now cleared", () => {
    expect(source).toMatch(/delete ALL keys matching\s*`ai:cache:\*`/i);
    expect(source).toMatch(/DELETE FROM ai_response_cache\s*\(all rows\)/i);
  });
});

describe("BUG-1 fix: best-effort behavior preserved", () => {
  const source = readSource("artifacts/api-server/src/lib/catalogCache.ts");

  it("invalidateCatalogCache never throws (Promise.allSettled absorbs rejections)", () => {
    // Each invalidation runs in its own Promise.allSettled slot, so a
    // rejection in one doesn't fail the others. The wrapper then logs
    // each failure separately at DEBUG level.
    expect(source).toMatch(/if\s*\(\s*redisDeleted\.status\s*===\s*"rejected"\s*\)/);
    expect(source).toMatch(/if\s*\(\s*pgDeleted\.status\s*===\s*"rejected"\s*\)/);
    expect(source).toMatch(/if\s*\(\s*rerankDeleted\.status\s*===\s*"rejected"\s*\)/);
  });

  it("logs failures at DEBUG level (non-fatal)", () => {
    expect(source).toContain("non-fatal — TTL will expire stale entries");
  });
});

describe("BUG-1 fix: existing product/seller-listing callers still work", () => {
  // The contract for `invalidateCatalogCache(reason?: string)` is unchanged
  // — it still accepts an optional reason string and returns Promise<void>.
  // Existing callers in routes/products.ts, routes/sellerListings.ts, and
  // routes/bulkImport.ts will continue to work; they'll just clear MORE
  // entries (correct behavior).
  const source = readSource("artifacts/api-server/src/lib/catalogCache.ts");

  it("invalidateCatalogCache accepts an optional reason string", () => {
    expect(source).toMatch(
      /export\s+async\s+function\s+invalidateCatalogCache\s*\(\s*reason:\s*string\s*=\s*"catalog\.mutation"\s*\)\s*:\s*Promise<void>/,
    );
  });

  it("reason is used for logging only (not filtering)", () => {
    // The docstring must explicitly say reason is NOT used for filtering.
    expect(source).toMatch(/Not used for filtering/i);
  });
});

describe("BUG-1 fix: queryEmbeddingCache is NOT cleared", () => {
  const source = readSource("artifacts/api-server/src/lib/catalogCache.ts");

  it("does NOT import or call clearQueryEmbeddingCache", () => {
    expect(source).not.toContain("clearQueryEmbeddingCache");
    expect(source).not.toMatch(/from\s+["']\.\/queryEmbeddingCache["']/);
  });

  it("documents why queryEmbeddingCache is not cleared", () => {
    expect(source).toMatch(/queryEmbeddingCache/i);
    expect(source).toMatch(/deterministic per query/i);
  });
});
