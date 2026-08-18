/**
 * BUG-I4 fix + Privacy fix: tone profile scoping tests.
 *
 * Verifies that:
 *   - The tone block is scoped to auto-injected entries (BUG-I4).
 *   - Creator names are NOT leaked to the LLM (Privacy fix).
 *   - ToolContext + ChatTools + executeTool plumbing still exists (internal).
 *   - The searchKb tool result does NOT include `creator` or
 *     `tone_locked_creator` fields (Privacy fix).
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/toneScoping.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

describe("Privacy fix: formatToneBlockForPrompt does NOT leak creator name", () => {
  const source = readSource("artifacts/api-server/src/lib/kbToneProfiles.ts");

  it("tone block does NOT include the creator name in the prompt text", () => {
    // The old code said: `The primary knowledge source above is from "${creatorName}".`
    // The new code says: `The primary knowledge source above has a distinctive writing style.`
    expect(source).toContain("distinctive writing style");
    // The creatorName parameter is accepted but prefixed with _ (unused).
    expect(source).toMatch(/_creatorName/);
  });

  it("tone block does NOT reference tone_locked_creator field", () => {
    // Strip comments before checking — the source has comments explaining
    // the history of the BUG-I4 fix that mention tone_locked_creator.
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(codeOnly).not.toMatch(/tone_locked_creator/);
  });

  it("tone block does NOT reference the search_knowledge_base tool by name", () => {
    // The old rule said "If you call the search_knowledge_base tool..."
    // The new rule just says "Present KB content as authoritative..."
    expect(source).not.toMatch(/search_knowledge_base/);
  });

  it("tone block tells the LLM NOT to attribute content to specific sources", () => {
    expect(source).toMatch(/do not attribute/i);
  });

  it("tone block does NOT change the function signature (still accepts creatorName)", () => {
    // The signature must remain (profile, creatorName, matchPercentage) for
    // backward-compat with callers. Use [\s\S] to match across newlines.
    expect(source).toMatch(
      /export function formatToneBlockForPrompt\([\s\S]*?profile:\s*ToneProfile,[\s\S]*?([_]?creatorName):\s*string,[\s\S]*?matchPercentage:\s*number[\s\S]*?\)/,
    );
  });
});

describe("BUG-I4 fix: ToolContext interface is defined in aiTools.ts (internal)", () => {
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

describe("Privacy fix: searchKb does NOT return creator or tone_locked_creator", () => {
  const source = readSource("artifacts/api-server/src/lib/aiTools.ts");

  it("searchKb signature accepts context?: ToolContext as the 3rd param", () => {
    expect(source).toMatch(/async\s+function\s+searchKb[\s\S]*?context\?\s*:\s*ToolContext/);
  });

  it("searchKb does NOT return `creator` field in results", () => {
    // Privacy: creator name is NOT surfaced to the LLM.
    // Check the executable code (strip comments) to avoid false positives
    // from comment lines mentioning "creator".
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/creator:\s*r\.creator\?\.name/);
  });

  it("searchKb does NOT return `tone_locked_creator` field", () => {
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/tone_locked_creator:/);
  });
});

describe("BUG-I4 fix: routes/ai.ts passes tone context into tools closure (internal)", () => {
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
    // v6.2 Part 9 update: the execute wrapper now accepts a 4th `options`
    // param (for onProgress). The regex is loosened to match either the
    // old 3-param form or the new 4-param form — both call executeTool
    // with the context object as the 4th positional arg.
    expect(source).toMatch(
      /execute:\s*\(name,\s*args,\s*uid(?:,\s*options)?\)\s*=>\s*executeTool\(\s*name,\s*args,\s*uid,\s*\{/,
    );
  });
});

describe("Privacy fix: tool description does NOT mention creator or tone_locked_creator", () => {
  const source = readSource("artifacts/api-server/src/lib/aiTools.ts");

  it("tool description does NOT mention tone_locked_creator", () => {
    // Strip comments before checking — comments in aiTools.ts mention
    // tone_locked_creator for historical context (BUG-I4 fix).
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(codeOnly).not.toMatch(/tone_locked_creator/);
  });

  it("tool description does NOT tell the LLM to cite creators", () => {
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(codeOnly).not.toMatch(/cite the creator/i);
  });

  it("tool description tells the LLM NOT to attribute to specific sources", () => {
    expect(source).toMatch(/without attributing/i);
  });
});

describe("BUG-I4 fix: gemini.ts + groq.ts do NOT need changes (closure approach)", () => {
  const geminiSource = readSource("artifacts/api-server/src/lib/gemini.ts");
  const groqSource = readSource("artifacts/api-server/src/lib/groq.ts");

  it("gemini.ts calls tools.execute with the signature (name, args, userId, options?)", () => {
    // v6.2 Part 9 update: gemini.ts now passes an options object as the
    // 4th arg (for onProgress). The regex is loosened to match either
    // the old 3-arg call or the new 4-arg call. The first 3 args
    // (toolName, toolArgs, userId ?? null) are unchanged.
    expect(geminiSource).toMatch(
      /tools\.execute\(\s*toolName,\s*toolArgs,\s*userId\s*\?\?\s*null/,
    );
  });

  it("groq.ts calls tools.execute with the signature (name, args, userId, options?)", () => {
    // v6.2 Part 9 update: same as gemini.ts — 4th arg is the options object.
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
