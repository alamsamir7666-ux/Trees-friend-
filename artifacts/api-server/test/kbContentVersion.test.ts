/**
 * BUG-3 fix: KB content version computation tests.
 *
 * Tests the `kbContentVersion.ts` module:
 *   - Source-shape tests (verifies the module exports + structure).
 *   - Behavioral tests using a mocked `pool.query` (verifies the
 *     version computation, caching, and fail-safe behavior).
 *
 * The behavioral tests use `vi.mock` to replace `@workspace/db`'s `pool`
 * with a controllable mock. This lets us test the version computation
 * without a real Postgres connection.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/kbContentVersion.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Ensure env vars required by transitive imports are set.
process.env.AI_SESSION_SECRET ??= "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";
process.env.MOBILE_JWT_SECRET ??= "test-mobile-jwt-secret-do-not-use-in-prod";
process.env.COURIER_WEBHOOK_SECRET ??= "test-courier-webhook-secret-do-not-use-in-prod";
process.env.CREDENTIAL_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.CLERK_PUBLISHABLE_KEY ??= "pk_test_Y2xlcmsudGVzdC5leGFtcGxlLmNvbSQ";
process.env.CLERK_SECRET_KEY ??= `sk_test_${"a".repeat(40)}`;

// Use vi.hoisted so the mockQuery reference is available inside the
// hoisted vi.mock factory (vi.mock runs before any other code).
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("@workspace/db", () => ({
  pool: {
    query: mockQuery,
  },
}));

// Import after mock setup.
import {
  getKbContentVersion,
  clearKbContentVersionCache,
  KB_CONTENT_VERSION_UNKNOWN,
} from "../src/lib/kbContentVersion";

// We also need access to the source for source-shape tests.
import * as fs from "node:fs";
const REPO_ROOT = "/home/z/my-project/Trees-friend-";
function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

// Helper: build a fake pg result row.
interface FakeRow {
  id: number;
  updated_at: Date;
  is_active: boolean;
}
function fakeRow(id: number, updatedAt: Date, isActive: boolean): FakeRow {
  return { id, updated_at: updatedAt, is_active: isActive };
}

describe("BUG-3 fix: kbContentVersion.ts source shape", () => {
  const source = readSource("artifacts/api-server/src/lib/kbContentVersion.ts");

  it("exports getKbContentVersion(): Promise<string>", () => {
    expect(source).toMatch(
      /export\s+async\s+function\s+getKbContentVersion\s*\(\s*\)\s*:\s*Promise<string>/,
    );
  });

  it("exports clearKbContentVersionCache(): void", () => {
    expect(source).toMatch(/export\s+function\s+clearKbContentVersionCache\s*\(\s*\)\s*:\s*void/);
  });

  it("exports KB_CONTENT_VERSION_UNKNOWN constant", () => {
    expect(source).toMatch(/export\s+const\s+KB_CONTENT_VERSION_UNKNOWN/);
  });

  it("uses sha1 hash truncated to 16 hex chars", () => {
    expect(source).toMatch(/createHash\(\s*["']sha1["']\s*\)/);
    expect(source).toMatch(/\.slice\(\s*0,\s*16\s*\)/);
  });

  it("queries ai_kb_entries ordered by id ASC for stable hash input", () => {
    expect(source).toMatch(
      /SELECT\s+id,\s+updated_at,\s+is_active\s+FROM\s+ai_kb_entries\s+ORDER\s+BY\s+id\s+ASC/i,
    );
  });

  it("includes is_active in the hash input (activation flips change version)", () => {
    // The hash input must include is_active so activation/deactivation
    // changes the version.
    expect(source).toMatch(/is_active\s*\?\s*1\s*:\s*0/);
  });

  it("includes updated_at in the hash input (content changes bump version)", () => {
    expect(source).toMatch(/updated_at\.toISOString\(\)/);
  });

  it("caches the version in-process for 5 seconds", () => {
    expect(source).toMatch(/CACHE_TTL_MS\s*=\s*5000/);
  });

  it("returns 'unknown' on DB error (fail-safe)", () => {
    expect(source).toMatch(/return\s+KB_CONTENT_VERSION_UNKNOWN/);
  });
});

describe("BUG-3 fix: getKbContentVersion behavioral tests", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    clearKbContentVersionCache();
  });

  afterEach(() => {
    clearKbContentVersionCache();
  });

  it("returns a 16-char hex string", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [fakeRow(1, new Date("2026-01-01T00:00:00Z"), true)],
    });
    const version = await getKbContentVersion();
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    expect(version.length).toBe(16);
  });

  it("two calls within 5s return the same version (in-process cache)", async () => {
    mockQuery.mockResolvedValue({
      rows: [fakeRow(1, new Date("2026-01-01T00:00:00Z"), true)],
    });
    const v1 = await getKbContentVersion();
    const v2 = await getKbContentVersion();
    expect(v1).toBe(v2);
    // The pool.query should have been called only once (second call hit
    // the in-process cache).
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("clearKbContentVersionCache forces next call to re-query the DB", async () => {
    mockQuery.mockResolvedValue({
      rows: [fakeRow(1, new Date("2026-01-01T00:00:00Z"), true)],
    });
    await getKbContentVersion();
    expect(mockQuery).toHaveBeenCalledTimes(1);

    clearKbContentVersionCache();

    await getKbContentVersion();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("different KB states produce different versions", async () => {
    // State 1: one entry, active, updated 2026-01-01.
    mockQuery.mockResolvedValueOnce({
      rows: [fakeRow(1, new Date("2026-01-01T00:00:00Z"), true)],
    });
    const v1 = await getKbContentVersion();
    clearKbContentVersionCache();

    // State 2: same entry, but content changed (updated_at bumped).
    mockQuery.mockResolvedValueOnce({
      rows: [fakeRow(1, new Date("2026-02-01T00:00:00Z"), true)],
    });
    const v2 = await getKbContentVersion();

    expect(v1).not.toBe(v2);
    expect(v1).toMatch(/^[0-9a-f]{16}$/);
    expect(v2).toMatch(/^[0-9a-f]{16}$/);
  });

  it("DB error returns 'unknown' (fail-safe)", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection refused"));
    const version = await getKbContentVersion();
    expect(version).toBe(KB_CONTENT_VERSION_UNKNOWN);
    expect(version).toBe("unknown");
  });

  it("activation flip changes version (is_active is part of the hash input)", async () => {
    // Entry active.
    mockQuery.mockResolvedValueOnce({
      rows: [fakeRow(1, new Date("2026-01-01T00:00:00Z"), true)],
    });
    const vActive = await getKbContentVersion();
    clearKbContentVersionCache();

    // Same entry, same updated_at, but deactivated.
    mockQuery.mockResolvedValueOnce({
      rows: [fakeRow(1, new Date("2026-01-01T00:00:00Z"), false)],
    });
    const vInactive = await getKbContentVersion();

    expect(vActive).not.toBe(vInactive);
  });

  it("updated_at bump changes version (content edit detected)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [fakeRow(1, new Date("2026-01-01T00:00:00Z"), true)],
    });
    const v1 = await getKbContentVersion();
    clearKbContentVersionCache();

    // Same entry, same is_active, but updated_at bumped (content edit).
    mockQuery.mockResolvedValueOnce({
      rows: [fakeRow(1, new Date("2026-01-02T00:00:00Z"), true)],
    });
    const v2 = await getKbContentVersion();

    expect(v1).not.toBe(v2);
  });

  it("deleted entry changes version (row removed from hash input)", async () => {
    // Two entries.
    mockQuery.mockResolvedValueOnce({
      rows: [
        fakeRow(1, new Date("2026-01-01T00:00:00Z"), true),
        fakeRow(2, new Date("2026-01-01T00:00:00Z"), true),
      ],
    });
    const v1 = await getKbContentVersion();
    clearKbContentVersionCache();

    // One entry deleted.
    mockQuery.mockResolvedValueOnce({
      rows: [fakeRow(1, new Date("2026-01-01T00:00:00Z"), true)],
    });
    const v2 = await getKbContentVersion();

    expect(v1).not.toBe(v2);
  });

  it("empty KB produces a stable non-'unknown' version", async () => {
    // Empty KB (no entries) — the version should still be computable
    // (sha1 of empty string) and not "unknown".
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const v1 = await getKbContentVersion();
    expect(v1).not.toBe("unknown");
    expect(v1).toMatch(/^[0-9a-f]{16}$/);

    clearKbContentVersionCache();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const v2 = await getKbContentVersion();
    expect(v2).toBe(v1); // empty KB is stable
  });
});

describe("BUG-3 fix: invalidateKbCache calls clearKbContentVersionCache", () => {
  const source = readSource("artifacts/api-server/src/lib/kbCache.ts");

  it("kbCache.ts imports clearKbContentVersionCache", () => {
    expect(source).toContain('import { clearKbContentVersionCache } from "./kbContentVersion"');
  });

  it("invalidateKbCache calls clearKbContentVersionCache() BEFORE invalidateCatalogCache", () => {
    // The clearKbContentVersionCache call must come BEFORE invalidateCatalogCache
    // so a concurrent request can't read the stale versioned cache during the
    // invalidation window.
    const clearIdx = source.indexOf("clearKbContentVersionCache()");
    const invalidateIdx = source.indexOf("invalidateCatalogCache(`kb:${reason}`)");
    expect(clearIdx).toBeGreaterThan(-1);
    expect(invalidateIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeLessThan(invalidateIdx);
  });
});
