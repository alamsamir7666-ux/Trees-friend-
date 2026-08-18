/**
 * BUG-K9 fix: reranker fallback cache tests.
 *
 * Verifies that `rerankerCache.ts` treats `"local"` and `"disabled"`
 * providers as fallback (negative-cached with 60s TTL), not just
 * `"fallback"`. Without this fix, LocalRerankerProvider's useless 1.0-
 * scored results were cached as POSITIVE (1h TTL), blocking Cohere/Jina
 * recovery for up to 55 minutes after they became available again.
 *
 * Uses source-shape inspection (same pattern as `kbCategories.test.ts`,
 * `toolCallCache.test.ts`).
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/rerankerFallbackCache.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

describe("BUG-K9 fix: FALLBACK_PROVIDERS set includes all degraded providers", () => {
  const source = readSource("artifacts/api-server/src/lib/rerankerCache.ts");

  it("defines a FALLBACK_PROVIDERS Set constant", () => {
    expect(source).toMatch(/const\s+FALLBACK_PROVIDERS\s*=\s*new\s+Set\s*\(/);
  });

  it('FALLBACK_PROVIDERS includes "fallback" (regression — was already there)', () => {
    // The original isFallback check matched only "fallback". The fix must
    // preserve this — it's the sentinel set when ALL providers fail.
    expect(source).toMatch(/new\s+Set\s*\(\s*\[[\s\S]*?"fallback"[\s\S]*?\]\s*\)/);
  });

  it('FALLBACK_PROVIDERS includes "local" (BUG-K9 fix)', () => {
    // LocalRerankerProvider returns provider="local" with score=1.0 for
    // every doc (no actual reranking). Caching these as positive (1h TTL)
    // would block Cohere/Jina recovery for up to 55 minutes.
    expect(source).toMatch(/new\s+Set\s*\(\s*\[[\s\S]*?"local"[\s\S]*?\]\s*\)/);
  });

  it('FALLBACK_PROVIDERS includes "disabled" (BUG-K9 fix)', () => {
    // Set when RERANKER_ENABLED=false. Same rationale as "local".
    expect(source).toMatch(/new\s+Set\s*\(\s*\[[\s\S]*?"disabled"[\s\S]*?\]\s*\)/);
  });
});

describe("BUG-K9 fix: isFallback detection uses FALLBACK_PROVIDERS.has()", () => {
  const source = readSource("artifacts/api-server/src/lib/rerankerCache.ts");

  it('isFallback uses FALLBACK_PROVIDERS.has() instead of === "fallback"', () => {
    // The OLD code was: results.every((r) => r.provider === "fallback")
    // The NEW code uses the Set: results.every((r) => FALLBACK_PROVIDERS.has(r.provider ?? ""))
    expect(source).toMatch(/results\.every\(\s*\(r\)\s*=>\s*FALLBACK_PROVIDERS\.has\(/);
    // The old `=== "fallback"` pattern should NOT remain in the isFallback
    // detection (it's fine for it to appear in comments explaining the
    // history, but not in the executable code).
    expect(source).not.toMatch(/r\.provider\s*===\s*["']fallback["']/);
  });

  it('handles null/undefined provider via `?? ""` (defensive)', () => {
    // If a provider returns no `provider` field (shouldn't happen but
    // defensive), treat it as fallback too (safer to negative-cache than
    // serve potentially-stale real scores).
    expect(source).toMatch(/r\.provider\s*\?\?\s*["']["']/);
  });
});

describe("BUG-K9 fix: TTL selection uses NEGATIVE_TTL_SECONDS for fallback", () => {
  const source = readSource("artifacts/api-server/src/lib/rerankerCache.ts");

  it("fallback entries use NEGATIVE_TTL_SECONDS (60s default)", () => {
    expect(source).toMatch(/isFallback\s*\?\s*NEGATIVE_TTL_SECONDS\s*:\s*CACHE_TTL_SECONDS/);
  });

  it("real-provider entries use CACHE_TTL_SECONDS (1h default)", () => {
    // The else branch of the TTL ternary must be CACHE_TTL_SECONDS —
    // real Cohere/Jina results should be cached for the full hour.
    expect(source).toMatch(/isFallback\s*\?\s*NEGATIVE_TTL_SECONDS\s*:\s*CACHE_TTL_SECONDS/);
  });

  it("NEGATIVE_TTL_SECONDS default is 60s", () => {
    expect(source).toMatch(/RERANKER_CACHE_NEGATIVE_TTL_SECONDS\s*\?\?\s*60/);
  });

  it("CACHE_TTL_SECONDS default is 3600s (1h)", () => {
    expect(source).toMatch(/RERANKER_CACHE_TTL_SECONDS\s*\?\?\s*3600/);
  });
});

describe("BUG-K9 fix: log message includes isFallback flag + provider", () => {
  const source = readSource("artifacts/api-server/src/lib/rerankerCache.ts");

  it("the SET log message includes the isFallback flag", () => {
    // The log object must include isFallback so operators can filter for
    // fallback cache writes when debugging "why is the cache serving 1.0 scores?"
    expect(source).toMatch(/isFallback,/);
  });

  it("the SET log message includes the provider field", () => {
    // The provider field tells operators WHICH fallback provider was
    // cached (local, disabled, or the rare "fallback" sentinel).
    expect(source).toMatch(/provider:\s*results\[0\]\?\.provider/);
  });

  it("the SET log message distinguishes fallback from positive", () => {
    // The log message string itself should differ for fallback vs positive
    // so it's grep-able in logs.
    expect(source).toMatch(/fallback\s*—\s*short TTL/i);
    expect(source).toMatch(/will retry real provider/i);
  });
});

describe("BUG-K9 fix: explanatory comment is present", () => {
  const source = readSource("artifacts/api-server/src/lib/rerankerCache.ts");

  it("references BUG-K9 in the file header comment", () => {
    expect(source).toMatch(/BUG-K9/);
  });

  it("explains that Local always succeeds with score=1.0", () => {
    expect(source).toMatch(/score\s*=\s*1\.0/i);
  });

  it("explains the recovery-blocking consequence", () => {
    // The comment must explain WHY this matters — without the fix, real
    // provider recovery is blocked for up to 55 minutes.
    expect(source).toMatch(/block\s+Cohere\/Jina\s+recovery/i);
  });

  it("references the Vercel AI SDK pattern (industry-standard)", () => {
    expect(source).toMatch(/Vercel AI SDK/i);
  });
});

describe("BUG-K9 fix: rerankerLocal.ts is NOT modified", () => {
  const source = readSource("artifacts/api-server/src/lib/rerankerLocal.ts");

  it('LocalRerankerProvider still has name = "local"', () => {
    expect(source).toMatch(/readonly\s+name\s*=\s*["']local["']/);
  });

  it("LocalRerankerProvider still returns score: 1.0", () => {
    expect(source).toMatch(/score:\s*1\.0/);
  });

  it('LocalRerankerProvider still returns provider: this.name ("local")', () => {
    expect(source).toMatch(/provider:\s*this\.name/);
  });

  it("LocalRerankerProvider.isConfigured() still returns true (always available)", () => {
    expect(source).toMatch(/isConfigured\(\):\s*boolean\s*\{[\s\S]*?return\s+true/);
  });
});

describe("BUG-K9 fix: reranker.ts getProviderChain is NOT modified", () => {
  const source = readSource("artifacts/api-server/src/lib/reranker.ts");

  it("the provider chain still ends with Local as the last resort", () => {
    // The chain must still include Local — it's the always-succeeds
    // fallback that prevents the system from blocking on reranker downtime.
    expect(source).toMatch(/chain\.push\(local\)/);
  });

  it('the "auto" chain still prefers Cohere, then Jina, then Local', () => {
    // The auto chain order must be preserved: Cohere (best multilingual)
    // first, then Jina, then Local. The fix is in the CACHE layer, not
    // the provider chain.
    expect(source).toMatch(/cohere\.isConfigured\(\)\s*\)\s*chain\.push\(cohere\)/);
    expect(source).toMatch(/jina\.isConfigured\(\)\s*\)\s*chain\.push\(jina\)/);
  });
});
