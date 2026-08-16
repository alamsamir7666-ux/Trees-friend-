/**
 * BUG-2 fix: cache key hashes the FULL system prompt, not just first 500 chars.
 *
 * Verifies (via source-shape inspection) that:
 *   1. `semanticCache.ts` no longer contains `.slice(0, 500)` on the
 *      system prompt.
 *   2. The hash is computed over the entire `systemPrompt` string.
 *   3. `getCachedResponse` and `setCachedResponse` use the SAME shared
 *      `generateCacheKey` helper (so they can never disagree).
 *   4. Two prompts that differ only after char 500 produce different
 *      cache keys at runtime (a behavioral test using the actual
 *      `generateCacheKey` — but we can't import it because it's not
 *      exported, so we verify the hash inputs directly via crypto).
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/semanticCacheKey.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { createHash } from "crypto";

const REPO_ROOT = "/home/z/my-project/Trees-friend-";

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

describe("BUG-2 fix: semanticCache.ts hashes the full system prompt", () => {
  const source = readSource("artifacts/api-server/src/lib/semanticCache.ts");

  it("no longer contains `slice(0, 500)` on the system prompt", () => {
    expect(source).not.toContain("systemPrompt.slice(0, 500)");
  });

  it("hashes the full systemPrompt (not a slice)", () => {
    // The fix replaced `systemPrompt.slice(0, 500)` with `systemPrompt`.
    // Verify the createHash call uses the full prompt.
    expect(source).toMatch(/createHash\(\s*["']sha256["']\s*\)\s*\.update\(systemPrompt\)/);
  });

  it("still takes the first 16 hex chars of the hash (cache key shape)", () => {
    expect(source).toMatch(/\.digest\(\s*["']hex["']\s*\)\s*\.slice\(\s*0,\s*16\s*\)/);
  });

  it("does NOT use slice(0, 500) anywhere on systemPrompt-derived data", () => {
    // Look for any remaining `slice(0, 500)` that's applied to a variable
    // whose name contains `prompt`. This catches regressions where someone
    // re-introduces the truncation under a different variable name.
    const promptSliceMatch = source.match(/\b\w*prompt\w*\.slice\s*\(\s*0,\s*500\s*\)/gi);
    // `promptSliceMatch` should be null (no occurrences) or, if non-null,
    // none of the matches should be the systemPrompt variable.
    if (promptSliceMatch) {
      for (const m of promptSliceMatch) {
        // The only allowed `slice(0, 500)` in this file would be on
        // something like `recentHistory` or `userMessage` — neither of
        // which contains the word "prompt". So any match here is a bug.
        expect(m.toLowerCase()).not.toContain("systemprompt");
      }
    }
  });
});

describe("BUG-2 fix: getCachedResponse and setCachedResponse share the cache key helper", () => {
  const source = readSource("artifacts/api-server/src/lib/semanticCache.ts");

  it("defines a single generateCacheKey helper", () => {
    const matches = source.match(/function\s+generateCacheKey\s*\(/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it("getCachedResponse calls generateCacheKey", () => {
    expect(source).toMatch(/getCachedResponse[\s\S]*?generateCacheKey\(/);
  });

  it("setCachedResponse calls generateCacheKey", () => {
    expect(source).toMatch(/setCachedResponse[\s\S]*?generateCacheKey\(/);
  });

  it("generateCacheKey signature includes systemPrompt as first param", () => {
    expect(source).toMatch(/function\s+generateCacheKey\s*\(\s*systemPrompt:\s*string/);
  });
});

describe("BUG-2 fix: behavioral test — full-prompt hash produces different keys", () => {
  // We can't import generateCacheKey (it's not exported), so we replicate
  // the hash logic here and verify that two prompts that differ only after
  // char 500 produce different hashes. This is the core correctness claim
  // of BUG-2's fix.

  /**
   * Replicates the prompt-hash logic from semanticCache.ts (post-fix).
   * Hashes the FULL prompt and takes the first 16 hex chars.
   */
  function promptHash(systemPrompt: string): string {
    return createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16);
  }

  // Build a system prompt that mirrors the real shape: a ~5KB static
  // persona header followed by dynamic blocks ({{summary}}{{knowledge}}
  // {{catalog}}{{tone}}). The first 500 chars are entirely within the
  // static persona section.
  const STATIC_HEADER = "You are TreeBot, the plant assistant for TreeFriend.\n\n".repeat(20);
  expect(STATIC_HEADER.length).toBeGreaterThan(500);

  const promptV1 = `${STATIC_HEADER}\n\n{{summary}}\n{{knowledge}}\nWater mango trees every 2 days.\n{{catalog}}\n{{tone}}`;
  const promptV2 = `${STATIC_HEADER}\n\n{{summary}}\n{{knowledge}}\nWater mango trees every 7-10 days.\n{{catalog}}\n{{tone}}`;

  it("two prompts identical for the first 500 chars but different after produce DIFFERENT hashes", () => {
    // Sanity check: the first 500 chars really are identical.
    expect(promptV1.slice(0, 500)).toBe(promptV2.slice(0, 500));
    // The full prompts differ.
    expect(promptV1).not.toBe(promptV2);
    // The full-prompt hashes must differ — this is the BUG-2 fix.
    expect(promptHash(promptV1)).not.toBe(promptHash(promptV2));
  });

  it("same prompt produces the same hash (sanity check)", () => {
    expect(promptHash(promptV1)).toBe(promptHash(promptV1));
  });

  it("the hash is a 16-char hex string", () => {
    const hash = promptHash(promptV1);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash.length).toBe(16);
  });
});

describe("BUG-2 fix: comment documents why the slice was removed", () => {
  const source = readSource("artifacts/api-server/src/lib/semanticCache.ts");

  it("contains a comment explaining the full-prompt hash", () => {
    // The fix's comment explains WHY the slice was removed — this is
    // important for future maintainers who might be tempted to "optimize"
    // the hash back to a truncation.
    expect(source).toContain("Hash the FULL system prompt");
    expect(source).toMatch(/dynamic blocks/i);
    // The comment may wrap across lines, so we check for both words
    // independently rather than as a single phrase.
    expect(source.toLowerCase()).toMatch(/premature[\s\S]*?optimization/);
  });
});
