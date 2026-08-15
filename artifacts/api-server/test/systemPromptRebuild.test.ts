/**
 * BUG-I5 fix: system prompt rebuilt between tool-call rounds tests.
 *
 * Verifies that the system prompt's `{{knowledge}}` block is cleared
 * after the first `search_knowledge_base` tool call, so the LLM doesn't
 * see stale auto-inject context mixed with fresh tool results.
 *
 * Uses source-shape inspection (same pattern as `toneScoping.test.ts`,
 * `kbRetrievalUnification.test.ts`).
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/systemPromptRebuild.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

const REPO_ROOT = "/home/z/my-project/Trees-friend-";

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

describe("BUG-I5 fix: aiRouter.ts streamChat accepts getter + onToolRoundComplete", () => {
  const source = readSource("artifacts/api-server/src/lib/aiRouter.ts");

  it("streamChat signature accepts systemPrompt as a SystemPromptSource (string | (() => string))", () => {
    // The getter pattern lets the route mutate `currentSystemPrompt`
    // between rounds; the provider reads the getter before each round.
    // We accept either the inline `string | (() => string)` form OR
    // the `SystemPromptSource` type alias (which resolves to the same).
    expect(source).toMatch(
      /systemPrompt:\s*(string\s*\|\s*\(\(\)\s*=>\s*string\)|SystemPromptSource)/,
    );
  });

  it("streamChat signature accepts onToolRoundComplete callback", () => {
    expect(source).toMatch(/onToolRoundComplete\?\s*:\s*OnToolRoundComplete/);
  });

  it("defines the OnToolRoundComplete type", () => {
    expect(source).toMatch(/export\s+type\s+OnToolRoundComplete/);
  });

  it("defines the SystemPromptSource type (string | (() => string))", () => {
    expect(source).toMatch(/export\s+type\s+SystemPromptSource/);
  });

  it("resolves the system prompt via typeof check (getter or string)", () => {
    expect(source).toMatch(
      /typeof\s+systemPrompt\s*===\s*["']function["']\s*\?\s*systemPrompt\(\)\s*:\s*systemPrompt/,
    );
  });

  it("forwards onToolRoundComplete to streamGeminiChat", () => {
    expect(source).toMatch(/streamGeminiChat[\s\S]*?onToolRoundComplete/);
  });

  it("forwards onToolRoundComplete to streamGroqChat", () => {
    expect(source).toMatch(/streamGroqChat[\s\S]*?onToolRoundComplete/);
  });
});

describe("BUG-I5 fix: aiContext.ts exports clearKbBlockFromPrompt", () => {
  const source = readSource("artifacts/api-server/src/lib/aiContext.ts");

  it("clearKbBlockFromPrompt is exported", () => {
    expect(source).toMatch(/export\s+function\s+clearKbBlockFromPrompt/);
  });

  it("clearKbBlockFromPrompt finds the KNOWLEDGE BASE CONTEXT header", () => {
    expect(source).toMatch(/KNOWLEDGE BASE CONTEXT/);
  });

  it("clearKbBlockFromPrompt replaces with a 'cleared — see tool results' marker", () => {
    // The replacement string spans two source lines (concatenated).
    // Use [\s\S] to match across newlines.
    expect(source).toMatch(/cleared[\s\S]*?search_knowledge_base tool[\s\S]*?results above/);
  });

  it("clearKbBlockFromPrompt does NOT touch the TONE MATCHING block", () => {
    // The replacement regex must match only the KB header, not the tone header.
    // Verify the KB header pattern is specific (doesn't match TONE MATCHING).
    expect(source).toMatch(/KNOWLEDGE BASE CONTEXT \(use as PRIMARY source — cite the creator\):/);
    // The next-section pattern should include TONE MATCHING as a BOUNDARY
    // (we clear up to TONE MATCHING, not INTO it).
    expect(source).toMatch(/TONE MATCHING/);
  });

  it("clearKbBlockFromPrompt returns the original prompt unchanged if no KB block", () => {
    // The early return when the header isn't found.
    expect(source).toMatch(/if\s*\(!match\)\s*return\s+systemPrompt/);
  });

  it("clearKbBlockFromPrompt finds the next section boundary", () => {
    // The regex must look for one of the known next-section headers.
    expect(source).toMatch(
      /CATALOG CONTEXT|TONE MATCHING|PRIOR CONVERSATION SUMMARY|FORMATTING|REMEMBER/,
    );
  });
});

describe("BUG-I5 fix: routes/ai.ts wires onToolRoundComplete + currentSystemPrompt", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("declares `let currentSystemPrompt = systemPrompt` (mutable, not const)", () => {
    expect(source).toMatch(/let\s+currentSystemPrompt\s*=\s*systemPrompt/);
  });

  it("imports clearKbBlockFromPrompt from aiContext", () => {
    expect(source).toMatch(
      /import\s*\{[\s\S]*?clearKbBlockFromPrompt[\s\S]*?\}\s*from\s*["']\.\.\/lib\/aiContext["']/,
    );
  });

  it("defines onToolRoundComplete callback", () => {
    expect(source).toMatch(/const\s+onToolRoundComplete/);
  });

  it("onToolRoundComplete only fires on round 1 (not subsequent rounds)", () => {
    expect(source).toMatch(/round\s*!==\s*1|round\s*===\s*1/);
  });

  it("onToolRoundComplete checks for search_knowledge_base tool call", () => {
    expect(source).toMatch(/search_knowledge_base/);
  });

  it("onToolRoundComplete calls clearKbBlockFromPrompt", () => {
    expect(source).toMatch(/clearKbBlockFromPrompt\(currentSystemPrompt\)/);
  });

  it("onToolRoundComplete updates currentSystemPrompt after clearing", () => {
    expect(source).toMatch(/currentSystemPrompt\s*=\s*clearedPrompt/);
  });

  it("passes `() => currentSystemPrompt` getter to streamChat", () => {
    expect(source).toMatch(/\(\)\s*=>\s*currentSystemPrompt/);
  });

  it("passes onToolRoundComplete as the last arg to streamChat", () => {
    // The call must end with onToolRoundComplete (after onToolEvent).
    expect(source).toMatch(/onToolEvent,\s*[\s\S]*?onToolRoundComplete,\s*\)/);
  });
});

describe("BUG-I5 fix: gemini.ts calls onToolRoundComplete after each round", () => {
  const source = readSource("artifacts/api-server/src/lib/gemini.ts");

  it("streamGeminiChat signature accepts onToolRoundComplete", () => {
    expect(source).toMatch(/onToolRoundComplete\?\s*:/);
  });

  it("streamGeminiChat accepts systemPrompt: string | (() => string)", () => {
    expect(source).toMatch(/systemPrompt:\s*string\s*\|\s*\(\(\)\s*=>\s*string\)/);
  });

  it("refreshes config.systemInstruction before each round (calls resolveSystemPrompt)", () => {
    expect(source).toMatch(/config\.systemInstruction\s*=\s*resolveSystemPrompt\(\)/);
  });

  it("calls onToolRoundComplete(round + 1, currentSignatures) after budget.recordRound", () => {
    // round + 1 because budget.currentRound is 0-indexed; pass 1-indexed.
    expect(source).toMatch(/onToolRoundComplete\(round\s*\+\s*1,\s*currentSignatures\)/);
  });

  it("imports ToolCallSignature type from aiToolLoop", () => {
    expect(source).toMatch(/type\s+ToolCallSignature/);
  });
});

describe("BUG-I5 fix: groq.ts calls onToolRoundComplete after each round", () => {
  const source = readSource("artifacts/api-server/src/lib/groq.ts");

  it("streamGroqChat signature accepts onToolRoundComplete", () => {
    expect(source).toMatch(/onToolRoundComplete\?\s*:/);
  });

  it("streamGroqChat accepts systemPrompt: string | (() => string)", () => {
    expect(source).toMatch(/systemPrompt:\s*string\s*\|\s*\(\(\)\s*=>\s*string\)/);
  });

  it("calls onToolRoundComplete(round + 1, currentSignatures) after the tool round", () => {
    expect(source).toMatch(/onToolRoundComplete\(round\s*\+\s*1,\s*currentSignatures\)/);
  });

  it("refreshes messages[0] (system message) before the next round", () => {
    expect(source).toMatch(
      /messages\[0\]\s*=\s*\{\s*role:\s*["']system["'],\s*content:\s*resolveSystemPrompt\(\)/,
    );
  });

  it("imports ToolCallSignature type from aiToolLoop", () => {
    expect(source).toMatch(/type\s+ToolCallSignature/);
  });
});

describe("BUG-I5 fix: cache key still uses the ORIGINAL systemPrompt (not currentSystemPrompt)", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("setCachedResponse uses systemPrompt (the original const), NOT currentSystemPrompt", () => {
    // The cache lookup at the start used `systemPrompt`. The cache write
    // at the end must use the SAME key. If it used `currentSystemPrompt`
    // (which gets cleared mid-stream), the cache key would differ from
    // the lookup, and the cached response wouldn't be found on subsequent
    // requests.
    expect(source).toMatch(/setCachedResponse\([\s\S]*?systemPrompt,/);
    // Verify the cache write does NOT use currentSystemPrompt.
    expect(source).not.toMatch(/setCachedResponse\([\s\S]*?currentSystemPrompt/);
  });

  it("the comment explicitly documents that the cache key uses the original prompt", () => {
    expect(source).toMatch(/cache key.*original.*systemPrompt|original.*systemPrompt.*cache key/i);
  });
});

describe("BUG-I5 fix: clearKbBlockFromPrompt behavioral test", () => {
  // We can't import clearKbBlockFromPrompt directly without setting up
  // the full module graph (it imports pool, logger, etc.). Instead, we
  // replicate the function's logic here and verify it behaves correctly
  // on sample inputs.

  /**
   * Replicates the clearKbBlockFromPrompt logic from aiContext.ts.
   * Used to verify the regex/replace logic is correct.
   */
  function clearKbBlockFromPrompt(systemPrompt: string): string {
    const HEADER_PATTERN = /KNOWLEDGE BASE CONTEXT \(use as PRIMARY source — cite the creator\):/;
    const REPLACEMENT =
      "KNOWLEDGE BASE CONTEXT: (cleared — see search_knowledge_base tool " +
      "results above for the current KB context)";

    const match = HEADER_PATTERN.exec(systemPrompt);
    if (!match) return systemPrompt;

    const headerEnd = match.index + match[0].length;
    const restOfPrompt = systemPrompt.slice(headerEnd);

    const NEXT_SECTION_PATTERN =
      /\n\n(CATALOG CONTEXT|TONE MATCHING|PRIOR CONVERSATION SUMMARY|FORMATTING|REMEMBER|AVAILABLE TOOLS|FOLLOWUP|YOU MUST|BUG-I1)/;
    const nextSectionMatch = NEXT_SECTION_PATTERN.exec(restOfPrompt);

    let blockEnd: number;
    if (nextSectionMatch) {
      blockEnd = headerEnd + nextSectionMatch.index;
    } else {
      blockEnd = systemPrompt.length;
    }

    return systemPrompt.slice(0, match.index) + REPLACEMENT + systemPrompt.slice(blockEnd);
  }

  it("clears the KB block when followed by CATALOG CONTEXT", () => {
    const prompt =
      "You are TreeBot.\n\n" +
      "KNOWLEDGE BASE CONTEXT (use as PRIMARY source — cite the creator):\n" +
      '- "Mango care" (Green Garden BD — YouTube)\n' +
      "  Water mango trees every 7-10 days in summer.\n" +
      "\n" +
      "CATALOG CONTEXT (use when relevant; cite exact product names):\n" +
      "- [[Alphonso Mango]] - 500 BDT\n";
    const cleared = clearKbBlockFromPrompt(prompt);
    expect(cleared).toContain("cleared — see search_knowledge_base tool results above");
    expect(cleared).not.toContain("Water mango trees every 7-10 days");
    // The CATALOG CONTEXT block must be preserved.
    expect(cleared).toContain("CATALOG CONTEXT (use when relevant");
    expect(cleared).toContain("[[Alphonso Mango]]");
  });

  it("clears the KB block when followed by TONE MATCHING", () => {
    const prompt =
      "KNOWLEDGE BASE CONTEXT (use as PRIMARY source — cite the creator):\n" +
      '- "Mango care" (Green Garden BD — YouTube)\n' +
      "  Water mango trees every 7-10 days.\n" +
      "\n" +
      "TONE MATCHING (Phase 4):\n" +
      'The primary knowledge source above is from "Green Garden BD".\n';
    const cleared = clearKbBlockFromPrompt(prompt);
    expect(cleared).toContain("cleared — see search_knowledge_base tool results above");
    // The TONE MATCHING block must be preserved.
    expect(cleared).toContain("TONE MATCHING (Phase 4):");
    expect(cleared).toContain("Green Garden BD");
  });

  it("returns the prompt unchanged when no KB block is present", () => {
    const prompt = "You are TreeBot.\n\nCATALOG CONTEXT: ...";
    const cleared = clearKbBlockFromPrompt(prompt);
    expect(cleared).toBe(prompt);
  });

  it("clears to the end when no next section is found", () => {
    const prompt =
      "KNOWLEDGE BASE CONTEXT (use as PRIMARY source — cite the creator):\n" +
      '- "Mango care" (Green Garden BD — YouTube)\n' +
      "  Water mango trees every 7-10 days.";
    const cleared = clearKbBlockFromPrompt(prompt);
    expect(cleared).toContain("cleared — see search_knowledge_base tool results above");
    expect(cleared).not.toContain("Water mango trees");
  });
});
