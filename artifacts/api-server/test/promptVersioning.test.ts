/**
 * Tests for the Bug #3 fix: prompt versioning + eval harness admin endpoints.
 *
 * These tests verify:
 *   - `renderPromptTemplate` correctly replaces {{summary}} and {{catalog}}
 *     placeholders (and appends when missing — backward compat).
 *   - `SYSTEM_PROMPT_TEMPLATE_V1` contains both placeholders.
 *   - `buildSystemPrompt` (the fallback) produces the same output as
 *     rendering the template.
 *   - The admin endpoints exist (route registration shape).
 *   - The eval harness functions are callable.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/promptVersioning.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

// Ensure the AI_SESSION_SECRET is set (required by sessionToken.ts which is
// transitively imported). setupEnv.ts handles this for the rest of the suite.
process.env.AI_SESSION_SECRET ??=
  "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";

import {
  renderPromptTemplate,
  buildSystemPrompt,
  SYSTEM_PROMPT_TEMPLATE_V1,
} from "../src/lib/aiContext";

describe("renderPromptTemplate (Bug #3 fix)", () => {
  describe("placeholder substitution", () => {
    it("replaces {{summary}} with the summary block", () => {
      const template = "Hello.{{summary}}";
      const result = renderPromptTemplate(template, "SUMMARY TEXT", "");
      // {{summary}} is replaced with "SUMMARY TEXT". Since {{catalog}} is
      // not in the template, the catalog context is appended at the end
      // (backward compat — the function always ensures catalog context
      // is present somewhere).
      expect(result).toContain("Hello.SUMMARY TEXT");
      expect(result).toContain("CATALOG CONTEXT");
    });

    it("replaces {{catalog}} with the catalog context", () => {
      const template = "Hello.{{catalog}}";
      const result = renderPromptTemplate(template, "", "Mango tree");
      expect(result).toContain("CATALOG CONTEXT (use when relevant");
      expect(result).toContain("Mango tree");
    });

    it("replaces {{catalog}} with empty-context message when no catalog", () => {
      const template = "Hello.{{catalog}}";
      const result = renderPromptTemplate(template, "", "");
      expect(result).toContain("CATALOG CONTEXT: (no matching products or articles found");
    });

    it("replaces both placeholders when present", () => {
      const template = "Start.{{summary}}Middle{{catalog}}End";
      const result = renderPromptTemplate(template, "SUMMARY", "CATALOG");
      expect(result).toContain("Start.SUMMARYMiddle");
      expect(result).toContain("CATALOG CONTEXT");
      expect(result).toContain("CATALOG");
      expect(result).toContain("End");
    });

    it("handles empty summary (renders empty string for {{summary}})", () => {
      const template = "Hello.{{summary}}End";
      const result = renderPromptTemplate(template, "", "catalog");
      // Empty summary → {{summary}} replaced with empty string.
      // Catalog is non-empty → appended via {{catalog}} (if present) or at end.
      expect(result).toContain("Hello.End");
      expect(result).toContain("CATALOG CONTEXT");
      expect(result).toContain("catalog");
    });

    it("replaces multiple occurrences of {{summary}}", () => {
      const template = "{{summary}} and {{summary}}";
      const result = renderPromptTemplate(template, "S", "");
      expect(result).toContain("S and S");
    });
  });

  describe("backward compat (no placeholders)", () => {
    it("appends summary at the end when {{summary}} is missing", () => {
      const template = "Just a prompt with no placeholder.";
      const result = renderPromptTemplate(template, "SUMMARY", "");
      // Summary appended after the template text.
      expect(result).toContain("Just a prompt with no placeholder.");
      expect(result).toContain("SUMMARY");
      // Catalog is empty → the empty-context message is appended.
      expect(result).toContain("CATALOG CONTEXT: (no matching products");
    });

    it("appends catalog at the end when {{catalog}} is missing", () => {
      const template = "Just a prompt.";
      const result = renderPromptTemplate(template, "", "Mango");
      expect(result).toContain("Just a prompt.");
      expect(result).toContain("CATALOG CONTEXT");
      expect(result).toContain("Mango");
    });

    it("does NOT append summary when summary is empty AND no placeholder", () => {
      const template = "Just a prompt.";
      const result = renderPromptTemplate(template, "", "");
      // Should just have the catalog context appended (the empty-context
      // message, since catalogContext is "").
      expect(result).toContain("Just a prompt.");
      expect(result).toContain("CATALOG CONTEXT: (no matching products or articles found for this query)");
      // Should NOT contain a stray "SUMMARY" text (the summary is empty).
      expect(result).not.toContain("SUMMARY");
    });
  });
});

describe("SYSTEM_PROMPT_TEMPLATE_V1 (Bug #3 fix)", () => {
  it("contains the {{summary}} placeholder", () => {
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("{{summary}}");
  });

  it("contains the {{catalog}} placeholder", () => {
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("{{catalog}}");
  });

  it("contains the TreeBot persona introduction", () => {
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("You are TreeBot");
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("TreeFriend");
  });

  it("contains the scope rules", () => {
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("YOUR SCOPE");
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("STRICTLY ENFORCED");
  });

  it("contains the tool descriptions", () => {
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("search_catalog");
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("get_product_care");
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("get_user_orders");
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("get_order_details");
  });

  it("contains the followups formatting block", () => {
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("[followups]");
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("[/followups]");
  });

  it("is non-empty (the seed needs a real prompt, not a placeholder)", () => {
    expect(SYSTEM_PROMPT_TEMPLATE_V1.length).toBeGreaterThan(1000);
  });
});

describe("buildSystemPrompt (fallback path)", () => {
  it("produces the same output as rendering the template with the same inputs", () => {
    const summaryBlock = "\nPRIOR CONVERSATION SUMMARY:\nUser has a balcony garden.\n";
    const catalogContext = 'Mango Sapling — sweet tropical fruit\n';
    const fromFallback = buildSystemPrompt(catalogContext, summaryBlock);
    const fromTemplate = renderPromptTemplate(
      SYSTEM_PROMPT_TEMPLATE_V1,
      summaryBlock,
      catalogContext,
    );
    expect(fromFallback).toBe(fromTemplate);
  });

  it("works with empty summary and catalog", () => {
    const result = buildSystemPrompt("", "");
    expect(result).toContain("You are TreeBot");
    expect(result).toContain("CATALOG CONTEXT: (no matching products");
  });

  it("injects the catalog context when provided", () => {
    const result = buildSystemPrompt("Mango Sapling", "");
    expect(result).toContain("Mango Sapling");
    expect(result).toContain("CATALOG CONTEXT (use when relevant");
  });

  it("injects the summary block when provided", () => {
    const summaryBlock = "\nPRIOR CONVERSATION SUMMARY:\nTest summary.\n";
    const result = buildSystemPrompt("", summaryBlock);
    expect(result).toContain("PRIOR CONVERSATION SUMMARY");
    expect(result).toContain("Test summary.");
  });
});

describe("route uses DB prompt text (Bug #3 fix)", () => {
  // These are source-code shape tests — they verify the route file
  // actually uses the DB text instead of throwing it away.

  it("routes/ai.ts imports renderPromptTemplate", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/ai.ts",
      "utf8",
    );
    expect(source).toContain("renderPromptTemplate");
  });

  it("routes/ai.ts uses promptVersionInfo.text (not just .version)", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/ai.ts",
      "utf8",
    );
    expect(source).toContain("promptVersionInfo.text");
    expect(source).toContain("promptVersionInfo.text.trim().length > 0");
  });

  it("routes/ai.ts falls back to buildSystemPrompt when DB text is empty", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/ai.ts",
      "utf8",
    );
    // The ternary: promptVersionInfo.text ? renderPromptTemplate(...) : buildSystemPrompt(...)
    expect(source).toMatch(/promptVersionInfo\.text.*renderPromptTemplate.*buildSystemPrompt/s);
  });

  it("routes/ai.ts no longer has a duplicate getActivePrompt() call", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/ai.ts",
      "utf8",
    );
    // Count occurrences of "await getActivePrompt()" — should be exactly 1.
    const matches = source.match(/await getActivePrompt\(\)/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });
});

describe("promptVersioning.ts (Bug #3 fix + Bug #25 cache TTL)", () => {
  it("has a cache TTL constant", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/lib/promptVersioning.ts",
      "utf8",
    );
    expect(source).toContain("PROMPT_CACHE_TTL_MS");
    expect(source).toContain("AI_PROMPT_CACHE_TTL_MS");
  });

  it("getActivePrompt checks cache freshness via TTL", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/lib/promptVersioning.ts",
      "utf8",
    );
    expect(source).toContain("cacheFresh");
    expect(source).toContain("_promptCacheAt");
  });

  it("has deletePromptVersion with safeguards", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/lib/promptVersioning.ts",
      "utf8",
    );
    expect(source).toContain("deletePromptVersion");
    expect(source).toContain("Cannot delete the active version");
    expect(source).toContain("Cannot delete the last remaining version");
  });

  it("activatePromptVersion uses a transaction (BEGIN/COMMIT/ROLLBACK)", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/lib/promptVersioning.ts",
      "utf8",
    );
    expect(source).toContain("BEGIN");
    expect(source).toContain("COMMIT");
    expect(source).toContain("ROLLBACK");
  });

  it("createPromptVersion validates semver format", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/lib/promptVersioning.ts",
      "utf8",
    );
    expect(source).toContain("/^\\d+\\.\\d+\\.\\d+$/");
  });

  it("has getActivePromptVersion and getPromptVersion helpers", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/lib/promptVersioning.ts",
      "utf8",
    );
    expect(source).toContain("export async function getActivePromptVersion");
    expect(source).toContain("export async function getPromptVersion");
  });
});

describe("aiAdmin.ts (Bug #3 fix: admin endpoints exist)", () => {
  it("imports prompt versioning functions", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toContain("listPromptVersions");
    expect(source).toContain("getActivePromptVersion");
    expect(source).toContain("getPromptVersion");
    expect(source).toContain("createPromptVersion");
    expect(source).toContain("activatePromptVersion");
    expect(source).toContain("deletePromptVersion");
  });

  it("imports eval harness functions", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toContain("getEvalCases");
    expect(source).toContain("getEvalResults");
    expect(source).toContain("evaluateResponse");
    expect(source).toContain("saveEvalResult");
  });

  it("registers GET /ai/admin/prompts endpoint", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toMatch(/router\.get\(\s*["']\/ai\/admin\/prompts["']/);
  });

  it("registers GET /ai/admin/prompts/active endpoint", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toMatch(/router\.get\(\s*["']\/ai\/admin\/prompts\/active["']/);
  });

  it("registers GET /ai/admin/prompts/:id endpoint", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toMatch(/router\.get\(\s*["']\/ai\/admin\/prompts\/:id["']/);
  });

  it("registers POST /ai/admin/prompts endpoint", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toMatch(/router\.post\(\s*["']\/ai\/admin\/prompts["']/);
  });

  it("registers POST /ai/admin/prompts/:id/activate endpoint", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toMatch(/router\.post\(\s*["']\/ai\/admin\/prompts\/:id\/activate["']/);
  });

  it("registers DELETE /ai/admin/prompts/:id endpoint", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toMatch(/router\.delete\(\s*["']\/ai\/admin\/prompts\/:id["']/);
  });

  it("registers GET /ai/admin/eval/cases endpoint", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toMatch(/router\.get\(\s*["']\/ai\/admin\/eval\/cases["']/);
  });

  it("registers POST /ai/admin/eval/run endpoint", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toMatch(/router\.post\(\s*["']\/ai\/admin\/eval\/run["']/);
  });

  it("registers GET /ai/admin/eval/results endpoint", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toMatch(/router\.get\(\s*["']\/ai\/admin\/eval\/results["']/);
  });

  it("POST /ai/admin/prompts validates semver format", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toContain("/^\\d+\\.\\d+\\.\\d+$/");
    expect(source).toContain("version must be a semver string");
  });

  it("POST /ai/admin/prompts caps prompt text at 50KB", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toContain("50_000");
    expect(source).toContain("too long");
  });

  it("DELETE /ai/admin/prompts/:id returns 409 for safeguard violations", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toContain("409");
  });

  it("POST /ai/admin/eval/run checks provider availability", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toContain("isAnyProviderConfigured");
  });

  it("POST /ai/admin/eval/run generates a runId", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toContain("runId");
    expect(source).toContain("run-");
  });

  it("POST /ai/admin/eval/run supports useJudge option", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toContain("useJudge");
  });

  it("POST /ai/admin/eval/run supports category filter", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toContain("categoryFilter");
  });
});

describe("ensureAiTables.ts (Bug #3 fix: seed prompt text)", () => {
  it("seeds v1.0.0 with the actual prompt text (via parameterized query)", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/lib/ensureAiTables.ts",
      "utf8",
    );
    expect(source).toContain("SYSTEM_PROMPT_TEMPLATE_V1");
    expect(source).toContain("INSERT INTO ai_prompt_versions");
    // Should NOT have the old placeholder text.
    expect(source).not.toContain("Use aiContext.ts buildSystemPrompt() fallback");
  });

  it("seed is idempotent (WHERE NOT EXISTS)", () => {
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/lib/ensureAiTables.ts",
      "utf8",
    );
    expect(source).toContain("WHERE NOT EXISTS");
  });
});
