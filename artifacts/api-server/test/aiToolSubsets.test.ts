/**
 * P0 #2 fix: intent-based tool subsetting tests.
 *
 * Verifies that `aiToolSubsets.ts` correctly filters the tool declarations
 * based on the detected intent (PURCHASE/KNOWLEDGE/MIXED/GREETING).
 *
 * Coverage:
 *   - The `TOOL_SUBSETS` record has all 4 intents.
 *   - PURCHASE hides search_knowledge_base (care articles not relevant).
 *   - KNOWLEDGE hides search_seller_listings (user doesn't want to buy).
 *   - MIXED exposes all tools (fail-open for ambiguous intent).
 *   - GREETING exposes NO tools (no LLM call expected).
 *   - `getToolSubsetForIntent(null)` returns the full set (back-compat).
 *   - `getToolDeclarationsForIntent` filters AI_TOOL_DECLARATIONS correctly.
 *   - `getToolCountForIntent` returns the right counts.
 *   - `getHiddenToolsForIntent` returns the right hidden tool names.
 *   - The route handler (`routes/ai.ts`) wires the subsetting into streamChat.
 *
 * Uses source-shape inspection + behavioral tests (same pattern as
 * `systemPromptRebuild.test.ts`, `kbRetrievalUnification.test.ts`).
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/aiToolSubsets.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Ensure the AI_SESSION_SECRET is set (required transitively by sessionToken.ts).
process.env.AI_SESSION_SECRET ??= "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";

import {
  TOOL_SUBSETS,
  getToolSubsetForIntent,
  getToolDeclarationsForIntent,
  getToolCountForIntent,
  getHiddenToolsForIntent,
} from "../src/lib/aiToolSubsets";
import { AI_TOOL_DECLARATIONS } from "../src/lib/aiTools";
import { TOOL_NAMES, type ToolName } from "../src/lib/aiToolSchemas";
import type { Intent } from "../src/lib/intentClassifier";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

// ─── Behavioral tests: TOOL_SUBSETS record ──────────────────────────────────

describe("P0 #2: TOOL_SUBSETS record has all 4 intents", () => {
  it("defines keys for PURCHASE, KNOWLEDGE, MIXED, GREETING", () => {
    expect(TOOL_SUBSETS.PURCHASE).toBeDefined();
    expect(TOOL_SUBSETS.KNOWLEDGE).toBeDefined();
    expect(TOOL_SUBSETS.MIXED).toBeDefined();
    expect(TOOL_SUBSETS.GREETING).toBeDefined();
  });

  it("every value is an array of valid ToolName literals", () => {
    for (const intent of ["PURCHASE", "KNOWLEDGE", "MIXED", "GREETING"] as Intent[]) {
      const subset = TOOL_SUBSETS[intent];
      for (const name of subset) {
        expect(TOOL_NAMES).toContain(name);
      }
    }
  });
});

describe("P0 #2: PURCHASE subset hides search_knowledge_base", () => {
  it("PURCHASE subset does NOT contain search_knowledge_base", () => {
    expect(TOOL_SUBSETS.PURCHASE).not.toContain("search_knowledge_base");
  });

  it("PURCHASE subset contains search_seller_listings (primary purchase tool)", () => {
    expect(TOOL_SUBSETS.PURCHASE).toContain("search_seller_listings");
  });

  it("PURCHASE subset contains search_catalog + get_product_care (variety info)", () => {
    expect(TOOL_SUBSETS.PURCHASE).toContain("search_catalog");
    expect(TOOL_SUBSETS.PURCHASE).toContain("get_product_care");
  });

  it("PURCHASE subset keeps user-scoped tools (order tracking)", () => {
    expect(TOOL_SUBSETS.PURCHASE).toContain("get_user_orders");
    expect(TOOL_SUBSETS.PURCHASE).toContain("get_order_details");
  });

  it("PURCHASE subset has exactly 5 tools", () => {
    expect(TOOL_SUBSETS.PURCHASE.length).toBe(5);
  });
});

describe("P0 #2: KNOWLEDGE subset hides search_seller_listings", () => {
  it("KNOWLEDGE subset does NOT contain search_seller_listings", () => {
    expect(TOOL_SUBSETS.KNOWLEDGE).not.toContain("search_seller_listings");
  });

  it("KNOWLEDGE subset contains search_knowledge_base (primary knowledge tool)", () => {
    expect(TOOL_SUBSETS.KNOWLEDGE).toContain("search_knowledge_base");
  });

  it("KNOWLEDGE subset contains search_catalog + get_product_care (variety info)", () => {
    expect(TOOL_SUBSETS.KNOWLEDGE).toContain("search_catalog");
    expect(TOOL_SUBSETS.KNOWLEDGE).toContain("get_product_care");
  });

  it("KNOWLEDGE subset keeps user-scoped tools (order tracking)", () => {
    expect(TOOL_SUBSETS.KNOWLEDGE).toContain("get_user_orders");
    expect(TOOL_SUBSETS.KNOWLEDGE).toContain("get_order_details");
  });

  it("KNOWLEDGE subset has exactly 5 tools", () => {
    expect(TOOL_SUBSETS.KNOWLEDGE.length).toBe(5);
  });
});

describe("P0 #2: MIXED subset exposes ALL tools (fail-open for ambiguous intent)", () => {
  it("MIXED subset contains every tool in TOOL_NAMES", () => {
    for (const name of TOOL_NAMES) {
      expect(TOOL_SUBSETS.MIXED).toContain(name);
    }
  });

  it("MIXED subset has the same length as TOOL_NAMES (6)", () => {
    expect(TOOL_SUBSETS.MIXED.length).toBe(TOOL_NAMES.length);
  });
});

describe("P0 #2: GREETING subset exposes NO tools", () => {
  it("GREETING subset is empty", () => {
    expect(TOOL_SUBSETS.GREETING).toEqual([]);
  });

  it("GREETING subset has 0 tools", () => {
    expect(TOOL_SUBSETS.GREETING.length).toBe(0);
  });
});

// ─── Behavioral tests: getToolSubsetForIntent (null fallback) ──────────────

describe("P0 #2: getToolSubsetForIntent(null) returns the full set (back-compat)", () => {
  it("returns all 6 tools when intent is null", () => {
    const subset = getToolSubsetForIntent(null);
    expect(subset.length).toBe(TOOL_NAMES.length);
    for (const name of TOOL_NAMES) {
      expect(subset).toContain(name);
    }
  });

  it("returns all 6 tools when intent is undefined", () => {
    const subset = getToolSubsetForIntent(undefined);
    expect(subset.length).toBe(TOOL_NAMES.length);
  });
});

// ─── Behavioral tests: getToolDeclarationsForIntent ────────────────────────

describe("P0 #2: getToolDeclarationsForIntent filters declarations correctly", () => {
  it("returns all 6 declarations for MIXED intent", () => {
    const decls = getToolDeclarationsForIntent("MIXED", AI_TOOL_DECLARATIONS);
    expect(decls.length).toBe(AI_TOOL_DECLARATIONS.length);
  });

  it("returns 5 declarations for PURCHASE (hides search_knowledge_base)", () => {
    const decls = getToolDeclarationsForIntent("PURCHASE", AI_TOOL_DECLARATIONS);
    expect(decls.length).toBe(5);
    const names = decls.map((d) => d.name);
    expect(names).not.toContain("search_knowledge_base");
    expect(names).toContain("search_seller_listings");
  });

  it("returns 5 declarations for KNOWLEDGE (hides search_seller_listings)", () => {
    const decls = getToolDeclarationsForIntent("KNOWLEDGE", AI_TOOL_DECLARATIONS);
    expect(decls.length).toBe(5);
    const names = decls.map((d) => d.name);
    expect(names).not.toContain("search_seller_listings");
    expect(names).toContain("search_knowledge_base");
  });

  it("returns 0 declarations for GREETING", () => {
    const decls = getToolDeclarationsForIntent("GREETING", AI_TOOL_DECLARATIONS);
    expect(decls.length).toBe(0);
  });

  it("returns all 6 declarations for null (back-compat)", () => {
    const decls = getToolDeclarationsForIntent(null, AI_TOOL_DECLARATIONS);
    expect(decls.length).toBe(AI_TOOL_DECLARATIONS.length);
  });

  it("preserves the original declaration order from allDeclarations", () => {
    // The filter must preserve the original order of AI_TOOL_DECLARATIONS.
    // We verify by checking the names match the original order, filtered.
    const decls = getToolDeclarationsForIntent("PURCHASE", AI_TOOL_DECLARATIONS);
    const originalNames = AI_TOOL_DECLARATIONS.map((d) => d.name);
    const subsetNames = decls.map((d) => d.name);
    // The subset names must be a subsequence of the original (in same order).
    let origIdx = 0;
    for (const name of subsetNames) {
      const foundIdx = originalNames.indexOf(name, origIdx);
      expect(foundIdx).toBeGreaterThanOrEqual(0);
      origIdx = foundIdx + 1;
    }
  });
});

// ─── Behavioral tests: getToolCountForIntent ───────────────────────────────

describe("P0 #2: getToolCountForIntent returns the right counts", () => {
  it("PURCHASE → 5", () => {
    expect(getToolCountForIntent("PURCHASE")).toBe(5);
  });

  it("KNOWLEDGE → 5", () => {
    expect(getToolCountForIntent("KNOWLEDGE")).toBe(5);
  });

  it("MIXED → 6", () => {
    expect(getToolCountForIntent("MIXED")).toBe(6);
  });

  it("GREETING → 0", () => {
    expect(getToolCountForIntent("GREETING")).toBe(0);
  });

  it("null → 6 (back-compat)", () => {
    expect(getToolCountForIntent(null)).toBe(6);
  });
});

// ─── Behavioral tests: getHiddenToolsForIntent ───────────────────────────

describe("P0 #2: getHiddenToolsForIntent returns the right hidden tools", () => {
  it("PURCHASE hides search_knowledge_base", () => {
    const hidden = getHiddenToolsForIntent("PURCHASE");
    expect(hidden).toContain("search_knowledge_base");
    expect(hidden.length).toBe(1);
  });

  it("KNOWLEDGE hides search_seller_listings", () => {
    const hidden = getHiddenToolsForIntent("KNOWLEDGE");
    expect(hidden).toContain("search_seller_listings");
    expect(hidden.length).toBe(1);
  });

  it("MIXED hides nothing", () => {
    const hidden = getHiddenToolsForIntent("MIXED");
    expect(hidden).toEqual([]);
  });

  it("GREETING hides all 6 tools", () => {
    const hidden = getHiddenToolsForIntent("GREETING");
    expect(hidden.length).toBe(TOOL_NAMES.length);
    for (const name of TOOL_NAMES) {
      expect(hidden).toContain(name as ToolName);
    }
  });

  it("null hides nothing (back-compat)", () => {
    const hidden = getHiddenToolsForIntent(null);
    expect(hidden).toEqual([]);
  });
});

// ─── Source-shape tests: routes/ai.ts wires the subsetting into streamChat ─

describe("P0 #2: routes/ai.ts wires intent-based tool subsetting into streamChat", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("imports getToolDeclarationsForIntent from aiToolSubsets", () => {
    expect(source).toMatch(
      /import\s*\{[\s\S]*?getToolDeclarationsForIntent[\s\S]*?\}\s*from\s*["']\.\.\/lib\/aiToolSubsets["']/,
    );
  });

  it("imports getHiddenToolsForIntent from aiToolSubsets", () => {
    expect(source).toMatch(
      /import\s*\{[\s\S]*?getHiddenToolsForIntent[\s\S]*?\}\s*from\s*["']\.\.\/lib\/aiToolSubsets["']/,
    );
  });

  it("computes visibleToolDeclarations via getToolDeclarationsForIntent", () => {
    expect(source).toMatch(/getToolDeclarationsForIntent\s*\(/);
    expect(source).toMatch(/visibleToolDeclarations\s*=/);
  });

  it("passes visibleToolDeclarations to streamChat (not AI_TOOL_DECLARATIONS)", () => {
    // The `declarations:` field in the ChatTools object must reference
    // `visibleToolDeclarations`, NOT `AI_TOOL_DECLARATIONS` directly.
    // We look for the line that assigns the declarations field.
    expect(source).toMatch(/declarations:\s*visibleToolDeclarations/);
  });

  it("logs the hidden tool names when subsetting is applied (observability)", () => {
    // The route logs `hiddenToolNames` at debug level for observability.
    expect(source).toMatch(/hiddenToolNames/);
    expect(source).toMatch(/intent-based tool subsetting applied/);
  });

  it("still imports AI_TOOL_DECLARATIONS (passed as the source array to filter)", () => {
    expect(source).toMatch(/AI_TOOL_DECLARATIONS/);
  });
});

// ─── Source-shape tests: aiToolSubsets.ts module structure ──────────────────

describe("P0 #2: aiToolSubsets.ts module structure", () => {
  const source = readSource("artifacts/api-server/src/lib/aiToolSubsets.ts");

  it("exports TOOL_SUBSETS as a Readonly record", () => {
    expect(source).toMatch(/export\s+const\s+TOOL_SUBSETS\s*:\s*Readonly/);
  });

  it("exports getToolSubsetForIntent", () => {
    expect(source).toMatch(/export\s+function\s+getToolSubsetForIntent/);
  });

  it("exports getToolDeclarationsForIntent", () => {
    expect(source).toMatch(/export\s+function\s+getToolDeclarationsForIntent/);
  });

  it("exports getToolCountForIntent", () => {
    expect(source).toMatch(/export\s+function\s+getToolCountForIntent/);
  });

  it("exports getHiddenToolsForIntent", () => {
    expect(source).toMatch(/export\s+function\s+getHiddenToolsForIntent/);
  });

  it("imports Intent type from intentClassifier", () => {
    expect(source).toMatch(
      /import\s+type\s*\{\s*Intent\s*\}\s*from\s*["']\.\/intentClassifier["']/,
    );
  });

  it("imports ToolName type from aiToolSchemas", () => {
    expect(source).toMatch(/import\s+type\s*\{\s*ToolName\s*\}\s*from\s*["']\.\/aiToolSchemas["']/);
  });

  it("imports FunctionDeclaration from @google/genai", () => {
    // The import can be either `import type { FunctionDeclaration } from "@google/genai"`
    // or `import { type FunctionDeclaration } from "@google/genai"`. We accept both.
    expect(source).toMatch(/from\s*["']@google\/genai["']/);
    expect(source).toMatch(/FunctionDeclaration/);
  });

  it("documents the token savings estimate in JSDoc", () => {
    expect(source).toMatch(/token savings/i);
    expect(source).toMatch(/~190 tokens|~80 tokens|~440 tokens/);
  });

  it("documents the industry standard rationale (OpenAI, Anthropic, Google)", () => {
    expect(source).toMatch(/OpenAI/i);
    expect(source).toMatch(/Anthropic/i);
    expect(source).toMatch(/Google/i);
  });
});

// ─── Source-shape tests: backward compatibility ────────────────────────────

describe("P0 #2: backward compatibility — aiTools.ts AI_TOOL_DECLARATIONS unchanged", () => {
  const source = readSource("artifacts/api-server/src/lib/aiTools.ts");

  it("AI_TOOL_DECLARATIONS still exports all 6 tools (unchanged)", () => {
    expect(source).toMatch(/AI_TOOL_DECLARATIONS\s*:\s*FunctionDeclaration\[\]/);
    // The 6 tool names should still be defined as function declarations.
    for (const name of TOOL_NAMES) {
      expect(source).toContain(`name: "${name}"`);
    }
  });

  it("USER_SCOPED_TOOLS + CATALOG_TOOLS sets are unchanged", () => {
    expect(source).toMatch(/USER_SCOPED_TOOLS\s*:\s*ReadonlySet<string>/);
    expect(source).toMatch(/CATALOG_TOOLS\s*:\s*ReadonlySet<string>/);
  });
});
