/**
 * BUG-I4 fix: tone profile scoping tests.
 *
 * Verifies that the tone block is scoped to the auto-inject entries and
 * that tool results include `tone_locked_creator` so the LLM can detect
 * creator mismatches and use neutral tone for off-creator citations.
 *
 * Uses source-shape inspection (same pattern as `kbRetrievalUnification.test.ts`,
 * `rerankerFallbackCache.test.ts`).
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/toneScoping.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

const REPO_ROOT = "/home/z/my-project/Trees-friend-";

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

describe("BUG-I4 fix: formatToneBlockForPrompt scopes tone to auto-inject", () => {
  const source = readSource("artifacts/api-server/src/lib/kbToneProfiles.ts");

  it("tone block mentions the tone applies ONLY to auto-injected entries", () => {
    // The new rule must tell the LLM the tone is scoped — not global.
    expect(source).toMatch(/applies ONLY/i);
    expect(source).toMatch(/auto-injected/i);
  });

  it("tone block mentions NEUTRAL tone for different creators", () => {
    // The LLM must be told to use neutral tone when tool results come
    // from a different creator than the tone-locked one.
    expect(source).toMatch(/NEUTRAL tone/i);
    expect(source).toMatch(/DIFFERENT creator/i);
  });

  it("tone block references the tone_locked_creator field", () => {
    // The LLM needs to know the field name to compare against.
    expect(source).toMatch(/tone_locked_creator/);
  });

  it("tone block references the search_knowledge_base tool", () => {
    // The rule must mention the tool by name so the LLM associates it.
    expect(source).toMatch(/search_knowledge_base/);
  });

  it("tone block does NOT change the function signature", () => {
    // The signature must remain (profile, creatorName, matchPercentage) —
    // the scoping is via prompt text, not new parameters. Use [\s\S] to
    // match across newlines (signature spans multiple lines).
    expect(source).toMatch(
      /export function formatToneBlockForPrompt\([\s\S]*?profile:\s*ToneProfile,[\s\S]*?creatorName:\s*string,[\s\S]*?matchPercentage:\s*number[\s\S]*?\)/,
    );
  });
});

describe("BUG-I4 fix: ToolContext interface is defined in aiTools.ts", () => {
  const source = readSource("artifacts/api-server/src/lib/aiTools.ts");

  it("defines the ToolContext interface", () => {
    expect(source).toMatch(/export\s+interface\s+ToolContext/);
  });

  it("ToolContext has toneLockedCreatorId field (number | null | undefined)", () => {
    expect(source).toMatch(/toneLockedCreatorId\?\s*:\s*number\s*\|\s*null/);
  });

  it("ToolContext has toneLockedCreatorName field (string | null | undefined)", () => {
    expect(source).toMatch(/toneLockedCreatorName\?\s*:\s*string\s*\|\s*null/);
  });
});

describe("BUG-I4 fix: ChatTools.execute accepts context?: ToolContext", () => {
  const source = readSource("artifacts/api-server/src/lib/aiTools.ts");

  it("ChatTools interface is defined", () => {
    expect(source).toMatch(/export\s+interface\s+ChatTools/);
  });

  it("ChatTools.execute accepts context?: ToolContext as the 4th parameter", () => {
    expect(source).toMatch(/context\?\s*:\s*ToolContext/);
  });

  it("ChatTools.execute still accepts the 3 original params (name, args, userId)", () => {
    // Backward compat — existing callers that don't pass context still work.
    expect(source).toMatch(
      /name:\s*string,\s*args:\s*Record<string,\s*unknown>,\s*userId:\s*string\s*\|\s*null/,
    );
  });
});

describe("BUG-I4 fix: executeTool accepts + passes context", () => {
  const source = readSource("artifacts/api-server/src/lib/aiTools.ts");

  it("executeTool signature accepts context?: ToolContext", () => {
    expect(source).toMatch(
      /export\s+async\s+function\s+executeTool[\s\S]*?context\?\s*:\s*ToolContext/,
    );
  });

  it("executeTool passes context to searchKb", () => {
    expect(source).toMatch(
      /case\s+["']search_knowledge_base["']:\s*[\s\S]*?searchKb\(args,\s*userId,\s*context\)/,
    );
  });
});

describe("BUG-I4 fix: searchKb returns tone_locked_creator", () => {
  const source = readSource("artifacts/api-server/src/lib/aiTools.ts");

  it("searchKb signature accepts context?: ToolContext as the 3rd param", () => {
    expect(source).toMatch(/async\s+function\s+searchKb[\s\S]*?context\?\s*:\s*ToolContext/);
  });

  it("searchKb returns tone_locked_creator: context?.toneLockedCreatorName ?? null", () => {
    expect(source).toMatch(/tone_locked_creator:\s*context\?\.toneLockedCreatorName\s*\?\?\s*null/);
  });

  it("searchKb includes tone_locked_creator in BOTH the success path and the empty-query early return", () => {
    // The empty-query early return (line ~848) and the success return
    // (line ~920) both need the field — count occurrences.
    const matches = source.match(
      /tone_locked_creator:\s*context\?\.toneLockedCreatorName\s*\?\?\s*null/g,
    );
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("BUG-I4 fix: routes/ai.ts passes tone context into tools closure", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("captures toneLockedCreatorId from kbContext.toneCreator", () => {
    expect(source).toMatch(
      /toneLockedCreatorId:\s*kbContext\.toneCreator\?\.creatorId\s*\?\?\s*null/,
    );
  });

  it("captures toneLockedCreatorName from kbContext.toneCreator", () => {
    expect(source).toMatch(
      /toneLockedCreatorName:\s*kbContext\.toneCreator\?\.creatorName\s*\?\?\s*null/,
    );
  });

  it("wraps executeTool in a closure that adds the context as the 4th arg", () => {
    // The closure pattern: (name, args, uid) => executeTool(name, args, uid, {...})
    expect(source).toMatch(
      /execute:\s*\(name,\s*args,\s*uid\)\s*=>\s*executeTool\(name,\s*args,\s*uid,\s*\{/,
    );
  });
});

describe("BUG-I4 fix: search_knowledge_base tool description mentions tone", () => {
  const source = readSource("artifacts/api-server/src/lib/aiTools.ts");

  it("tool description mentions tone_locked_creator field", () => {
    expect(source).toMatch(/tone_locked_creator/);
  });

  it("tool description mentions neutral tone for mismatched creators", () => {
    expect(source).toMatch(/neutral tone/i);
  });

  it("tool description tells the LLM to compare creator !== tone_locked_creator", () => {
    expect(source).toMatch(/creator.*tone_locked_creator|tone_locked_creator.*creator/i);
  });
});

describe("BUG-I4 fix: gemini.ts + groq.ts do NOT need changes (closure approach)", () => {
  // The closure approach in routes/ai.ts means gemini.ts/groq.ts still
  // call tools.execute(name, args, userId) with 3 args — the 4th (context)
  // is added by the closure. Verify both files still use the 3-arg call.
  const geminiSource = readSource("artifacts/api-server/src/lib/gemini.ts");
  const groqSource = readSource("artifacts/api-server/src/lib/groq.ts");

  it("gemini.ts calls tools.execute with 3 args (name, args, userId)", () => {
    expect(geminiSource).toMatch(/tools\.execute\(toolName,\s*toolArgs,\s*userId\s*\?\?\s*null\)/);
  });

  it("groq.ts calls tools.execute with 3 args (name, args, userId)", () => {
    expect(groqSource).toMatch(/tools\.execute\(/);
    expect(groqSource).toMatch(/userId\s*\?\?\s*null/);
  });

  it("gemini.ts does NOT reference ToolContext (closure handles it)", () => {
    expect(geminiSource).not.toMatch(/ToolContext/);
  });

  it("groq.ts does NOT reference ToolContext (closure handles it)", () => {
    expect(groqSource).not.toMatch(/ToolContext/);
  });
});
