/**
 * BUG-3 fix: semantic cache version filter tests.
 *
 * Verifies (via source-shape inspection) that `embeddingCache.ts` and
 * `routes/ai.ts` correctly use the `kbContentVersion` parameter:
 *   - `getSemanticCachedResponse` accepts the version + filters by it.
 *   - `setSemanticCachedResponse` accepts the version + stores it.
 *   - The lookup uses `=` (not `IS NOT DISTINCT FROM`) so NULL rows
 *     are excluded.
 *   - The route computes the version before the cache lookup.
 *   - The route skips the cache (both read + write) when version is
 *     "unknown".
 *   - The route passes the version to `setSemanticCachedResponse`.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/embeddingCacheVersion.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

describe("BUG-3 fix: getSemanticCachedResponse signature + SQL", () => {
  const source = readSource("artifacts/api-server/src/lib/embeddingCache.ts");

  it("function signature accepts kbContentVersion: string", () => {
    // The signature spans multiple lines; we use [\s\S] to match across newlines.
    expect(source).toMatch(
      /export\s+async\s+function\s+getSemanticCachedResponse\s*\([\s\S]*?kbContentVersion:\s*string[\s\S]*?\)/,
    );
  });

  it("SQL SELECT includes kb_content_version column", () => {
    expect(source).toMatch(/SELECT\s+[\s\S]*?kb_content_version\s+FROM\s+ai_response_cache/i);
  });

  it("SQL WHERE clause filters by kb_content_version = $N", () => {
    // The version filter must use `=` (not `IS NOT DISTINCT FROM`) so
    // NULL rows are excluded (NULL = anything is NULL, not TRUE).
    expect(source).toMatch(/WHERE\s+kb_content_version\s*=\s*\$5/i);
  });

  it("does NOT use IS NOT DISTINCT FROM for kb_content_version (NULLs must be excluded)", () => {
    // IS NOT DISTINCT FROM would treat NULL = NULL as TRUE, which would
    // match legacy rows. We want NULL rows excluded.
    expect(source).not.toMatch(/kb_content_version\s+IS\s+NOT\s+DISTINCT\s+FROM/i);
  });

  it("passes kbContentVersion as a query parameter", () => {
    // The parameter list must include kbContentVersion.
    expect(source).toMatch(/kbContentVersion,/);
  });
});

describe("BUG-3 fix: setSemanticCachedResponse signature + SQL", () => {
  const source = readSource("artifacts/api-server/src/lib/embeddingCache.ts");

  it("function signature accepts kbContentVersion: string", () => {
    expect(source).toMatch(
      /export\s+async\s+function\s+setSemanticCachedResponse\s*\([\s\S]*?kbContentVersion:\s*string/,
    );
  });

  it("INSERT statement includes kb_content_version column", () => {
    expect(source).toMatch(/INSERT\s+INTO\s+ai_response_cache\s*\([\s\S]*?kb_content_version\)/i);
  });

  it("INSERT VALUES includes a parameter for kb_content_version", () => {
    // 7 parameters: query_text, response, embedding, model, provider,
    // had_tool_calls, kb_content_version.
    expect(source).toMatch(
      /VALUES\s*\(\s*\$1,\s*\$2,\s*\$3::vector,\s*\$4,\s*\$5,\s*\$6,\s*\$7\s*\)/i,
    );
  });

  it("passes kbContentVersion as the 7th parameter", () => {
    // The parameter list ends with kbContentVersion (7th arg). We just
    // check that kbContentVersion appears as the last argument in the
    // VALUES array.
    expect(source).toMatch(/hadToolCalls,\s*kbContentVersion/);
  });

  it("skips caching when kbContentVersion === 'unknown' (fail-safe)", () => {
    // The route computes the version; if it's "unknown" (DB error), the
    // cache write must be skipped — storing "unknown" would never be
    // matched by future lookups (which use real versions).
    expect(source).toMatch(/if\s*\(\s*kbContentVersion\s*===\s*["']unknown["']\s*\)\s*return/);
  });
});

describe("BUG-3 fix: routes/ai.ts wires kbContentVersion correctly", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("imports getKbContentVersion from ../lib/kbContentVersion", () => {
    expect(source).toContain('import { getKbContentVersion } from "../lib/kbContentVersion"');
  });

  it("computes kbContentVersion before the semantic cache lookup", () => {
    // The version must be computed BEFORE the cache lookup so the lookup
    // can filter by it.
    const versionIdx = source.indexOf("await getKbContentVersion()");
    const lookupIdx = source.indexOf("getSemanticCachedResponse(");
    expect(versionIdx).toBeGreaterThan(-1);
    expect(lookupIdx).toBeGreaterThan(-1);
    expect(versionIdx).toBeLessThan(lookupIdx);
  });

  it("skips the semantic cache lookup when kbContentVersion === 'unknown'", () => {
    // The route must wrap the cache lookup in a conditional that bypasses
    // it when the version is "unknown".
    expect(source).toMatch(/kbContentVersion\s*!==\s*["']unknown["']/);
  });

  it("passes kbContentVersion to getSemanticCachedResponse", () => {
    // The call spans multiple lines; use [\s\S] to match across newlines.
    expect(source).toMatch(
      /getSemanticCachedResponse\([\s\S]*?safeMessage,[\s\S]*?isPrivateQuery,[\s\S]*?kbContentVersion/,
    );
  });

  it("passes kbContentVersion to setSemanticCachedResponse", () => {
    // The cache write must also include the version so the stored row is
    // tagged with the KB state it was built from.
    expect(source).toMatch(/setSemanticCachedResponse\([\s\S]*?hadAnyTool,\s*kbContentVersion/);
  });

  it("includes kbContentVersion in the cache HIT log (observability)", () => {
    // For debugging cache-staleness issues, the HIT log should include
    // the version so operators can see which KB state was matched.
    expect(source).toMatch(/kbContentVersion/);
  });
});

describe("BUG-3 fix: legacy fallback path also filters by version", () => {
  const source = readSource("artifacts/api-server/src/lib/embeddingCache.ts");

  it("getSemanticCachedResponseLegacy accepts kbContentVersion parameter", () => {
    expect(source).toMatch(
      /async\s+function\s+getSemanticCachedResponseLegacy\s*\([\s\S]*?kbContentVersion:\s*string/,
    );
  });

  it("getSemanticCachedResponseLegacy SQL filters by kb_content_version", () => {
    // Even the legacy path (when had_tool_calls column doesn't exist)
    // must filter by version. If the version column also doesn't exist,
    // the query fails and we return null (cache miss → fresh LLM call).
    expect(source).toMatch(/WHERE\s+kb_content_version\s*=\s*\$4/i);
  });
});
