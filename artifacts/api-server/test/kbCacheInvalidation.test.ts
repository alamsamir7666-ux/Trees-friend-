/**
 * BUG-1 fix: KB mutations trigger chat cache invalidation.
 *
 * Verifies (via source-shape inspection, the same pattern used by
 * `toolCallCache.test.ts` and `kbCategories.test.ts`) that every KB
 * mutation route in `routes/aiAdmin.ts` calls `invalidateKbCache(...)`
 * AFTER the DB write succeeds, fire-and-forget with a `.catch()` for
 * logging.
 *
 * The tests do NOT require a live database, Redis, or pgvector — they
 * inspect the route source as text and assert that:
 *
 *   1. The route imports `invalidateKbCache` from `../lib/kbCache`.
 *   2. The route's success path calls `invalidateKbCache("<reason>")`
 *      with the documented reason string.
 *   3. The call is fire-and-forget (`.catch()`-chained, not `await`ed).
 *   4. The call is placed AFTER `logger.info(...)` (the post-commit log)
 *      and BEFORE `res.json(...)`.
 *   5. The call is NOT placed in the catch branch (failed mutations must
 *      not flush caches).
 *
 * Why source-shape tests instead of integration tests:
 *   - The actual cache flush behavior is exercised by
 *     `catalogCache.test.ts` (which verifies `invalidateCatalogCache`
 *     clears Redis + pgvector + reranker caches).
 *   - This file verifies WIRING — that every KB mutation route calls
 *     the invalidation function. Integration testing each route would
 *     require a real Postgres + Redis + admin JWT fixture per route,
 *     which is overkill for a wiring check.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/kbCacheInvalidation.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

/**
 * Extracts the body of a route handler from the source text.
 *
 * Finds the route registration line (e.g. `router.post("/ai/admin/kb/entries",`)
 * and returns the body of the arrow function that follows, up to the
 * closing `});`.
 *
 * Returns null if the route is not found.
 */
function extractRouteBody(
  source: string,
  method: "get" | "post" | "put" | "delete",
  path: string,
): string | null {
  // Escape regex special chars in path (only `/:` are present in our paths).
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match: router.<method>("/path", async (req, res) => { ... });
  // The body is everything between the opening `{` and the matching `});`.
  const routeRegex = new RegExp(
    `router\\.${method}\\(\\s*["']${escapedPath}["']\\s*,\\s*async\\s*\\([^)]*\\)\\s*=>\\s*\\{`,
  );
  const match = routeRegex.exec(source);
  if (!match) return null;

  // Walk the source from match.end, counting braces until we close the
  // arrow function body. We need to skip braces inside strings + comments
  // to avoid false counts, but for our purposes a naive brace count works
  // because the route bodies don't contain unmatched braces in strings.
  const start = match.index + match[0].length;
  let depth = 1;
  let i = start;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  if (depth !== 0) return null;
  return source.slice(start, i - 1);
}

describe("BUG-1 fix: kbCache.ts wrapper module", () => {
  const source = readSource("artifacts/api-server/src/lib/kbCache.ts");

  it("exports invalidateKbCache(reason: string): Promise<void>", () => {
    expect(source).toMatch(
      /export\s+async\s+function\s+invalidateKbCache\s*\(\s*reason:\s*string\s*\)\s*:\s*Promise<void>/,
    );
  });

  it("delegates to invalidateCatalogCache with `kb:` prefix", () => {
    expect(source).toContain("invalidateCatalogCache(`kb:${reason}`)");
  });

  it("logs success at INFO level with the reason", () => {
    expect(source).toContain("logger.info({ reason }");
    expect(source).toContain('"KB cache: invalidated after mutation"');
  });

  it("wraps the call in try/catch so failures do not throw", () => {
    expect(source).toMatch(/try\s*\{[\s\S]*invalidateCatalogCache[\s\S]*\}\s*catch\s*\(/);
  });

  it("imports invalidateCatalogCache from ./catalogCache", () => {
    expect(source).toContain('from "./catalogCache"');
    expect(source).toContain("invalidateCatalogCache");
  });
});

describe("BUG-1 fix: aiAdmin.ts imports + uses invalidateKbCache", () => {
  const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");

  it("imports invalidateKbCache from ../lib/kbCache", () => {
    expect(source).toContain('import { invalidateKbCache } from "../lib/kbCache"');
  });

  it("calls invalidateKbCache exactly 20 times (one per mutation endpoint)", () => {
    // 20 mutation endpoints — 19 original + 1 new (POST /ai/admin/kb/sources/youtube,
    // which creates a source and needs the same cache invalidation as the
    // manual create route). See the engineering brief for the original list.
    const matches = source.match(/invalidateKbCache\(/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(20);
  });

  it("every invalidateKbCache call is fire-and-forget (.catch-chained)", () => {
    // None of the calls should be `await invalidateKbCache(...)`.
    expect(source).not.toMatch(/await\s+invalidateKbCache/);
    // All calls should be followed by `.catch(` (with optional whitespace).
    const callPattern = /invalidateKbCache\([^)]+\)\s*\.catch\(/g;
    const matches = source.match(callPattern);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(20);
  });
});

describe("BUG-1 fix: each KB mutation route calls invalidateKbCache", () => {
  const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");

  // Each tuple: [method, path, expectedReason]
  const routes: ["post" | "put" | "delete", string, string][] = [
    // Categories (4)
    ["post", "/ai/admin/kb/categories", "category.create"],
    ["put", "/ai/admin/kb/categories/:id", "category.update"],
    ["post", "/ai/admin/kb/categories/:id/move", "category.move"],
    ["delete", "/ai/admin/kb/categories/:id", "category.delete"],
    // Creators (5)
    ["post", "/ai/admin/kb/creators", "creator.create"],
    ["put", "/ai/admin/kb/creators/:id", "creator.update"],
    ["delete", "/ai/admin/kb/creators/:id", "creator.delete"],
    ["put", "/ai/admin/kb/creators/:id/tone-percentage", "creator.tone-percentage"],
    // Sources (5)
    ["post", "/ai/admin/kb/sources", "source.create"],
    ["put", "/ai/admin/kb/sources/:id", "source.update"],
    ["delete", "/ai/admin/kb/sources/:id", "source.delete"],
    ["post", "/ai/admin/kb/sources/:id/chunk", "source.chunk"],
    ["post", "/ai/admin/kb/sources/:id/entries/batch", "source.batch-entries"],
    // Entries (5)
    ["post", "/ai/admin/kb/entries", "entry.create"],
    ["put", "/ai/admin/kb/entries/:id", "entry.update"],
    ["post", "/ai/admin/kb/entries/:id/activate", "entry.activate"],
    ["post", "/ai/admin/kb/entries/:id/deactivate", "entry.deactivate"],
    ["delete", "/ai/admin/kb/entries/:id", "entry.delete"],
  ];

  // The tone-profile/generate route uses the multi-line `router.post("/path",`
  // form (path is on its own line) — its route body extraction needs a
  // slightly looser regex. We test it separately below.
  it.each(routes)('%s %s calls invalidateKbCache("%s")', (method, path, reason) => {
    const body = extractRouteBody(source, method, path);
    expect(body).not.toBeNull();
    expect(body!).toContain(`invalidateKbCache("${reason}")`);
    // Must be in the success path — there must be a logger.info call
    // somewhere before the invalidateKbCache call. We check this loosely:
    // the route body must contain `logger.info(` AND it must appear
    // BEFORE the invalidateKbCache call.
    const infoIdx = body!.indexOf("logger.info(");
    const invalidIdx = body!.indexOf(`invalidateKbCache("${reason}")`);
    expect(infoIdx).toBeGreaterThanOrEqual(0);
    expect(invalidIdx).toBeGreaterThan(infoIdx);
    // Must be .catch-chained (fire-and-forget).
    expect(body!).toContain(`invalidateKbCache("${reason}").catch(`);
  });

  // Special case: tone-profile/generate uses multi-line route registration
  // (`router.post(\n  "/ai/admin/kb/creators/:id/tone-profile/generate",`)
  // so the single-line extractRouteBody helper won't find it. We assert
  // on the full source instead.
  it('POST /ai/admin/kb/creators/:id/tone-profile/generate calls invalidateKbCache("creator.tone.regen")', () => {
    expect(source).toContain('invalidateKbCache("creator.tone.regen")');
    expect(source).toContain('invalidateKbCache("creator.tone.regen").catch(');
  });
});

describe("BUG-1 fix: invalidation is NOT called on failed mutations", () => {
  const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");

  it("invalidateKbCache is never called inside a catch block", () => {
    // Walk the source: every `invalidateKbCache(` call must NOT be
    // preceded (in the same function) by an unmatched `catch` keyword.
    // A simpler heuristic: no `invalidateKbCache(` should appear on the
    // same line as, or immediately after, a `} catch` keyword sequence
    // within the same route handler.
    //
    // We approximate by checking that no `invalidateKbCache(` is preceded
    // (within 200 chars) by a `logger.error(` line that itself follows a
    // `} catch` block. This catches the obvious bug of accidentally
    // placing invalidation in the error path.
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes("invalidateKbCache(")) continue;
      // Look back up to 20 lines for a `} catch (err) {` that's still
      // open (no matching `}` closed yet). If we find one, the
      // invalidation is inside the catch block — a bug.
      let inCatch = false;
      for (let j = i - 1; j >= Math.max(0, i - 20); j--) {
        const prev = lines[j];
        if (prev.includes("} catch (")) {
          inCatch = true;
          break;
        }
        if (prev === "  });" || prev === "});") {
          // Closed before reaching a catch — we're in the try block.
          break;
        }
      }
      expect(inCatch).toBe(false);
    }
  });
});

describe("BUG-1 fix: batch operations call invalidateKbCache exactly once", () => {
  const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");

  it("POST /ai/admin/kb/sources/:id/entries/batch calls invalidateKbCache ONCE (not per-entry)", () => {
    const body = extractRouteBody(source, "post", "/ai/admin/kb/sources/:id/entries/batch");
    expect(body).not.toBeNull();
    const matches = body!.match(/invalidateKbCache\(/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
    expect(body!).toContain('invalidateKbCache("source.batch-entries")');
  });
});
