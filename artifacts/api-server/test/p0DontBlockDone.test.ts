/**
 * P0 #4 fix: don't block `done` on Constitutional AI + structured followups fallback.
 *
 * Verifies the post-stream flow has been optimized to send `done` faster:
 *   1. Constitutional AI is GATED on user-scoped tools / input PII / account
 *      keywords — skipped for catalog/KB queries (the bulk of traffic).
 *   2. Followups fallback + PII redaction run IN PARALLEL via Promise.allSettled.
 *   3. Tone match log is fire-and-forget (no `await`).
 *   4. PII redaction (fast, ~1ms regex) ALWAYS runs on the output.
 *   5. Cache writes + cost recording remain fire-and-forget.
 *
 * Coverage:
 *   - `shouldRunConstitutionalAI()` helper exists + has the right gates.
 *   - `checkOutputSafety()` accepts the new `runConstitutionalAI` parameter.
 *   - The route handler calls `shouldRunConstitutionalAI()` + passes the result
 *     to `checkOutputSafety()`.
 *   - The route handler uses `Promise.allSettled` to parallelize followups +
 *     safety check.
 *   - Tone log is non-blocking.
 *   - Backward compatibility: existing safety features (PII redaction,
 *     response_replaced event, output_pii_redacted log) still work.
 *
 * Uses source-shape inspection + behavioral tests (same pattern as
 * `systemPromptRebuild.test.ts`, `kbRetrievalUnification.test.ts`).
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/p0DontBlockDone.test.ts
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Ensure the AI_SESSION_SECRET is set (required transitively by sessionToken.ts).
process.env.AI_SESSION_SECRET ??= "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";

import { shouldRunConstitutionalAI } from "../src/lib/outputSafety";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

// ─── Behavioral tests: shouldRunConstitutionalAI() ──────────────────────────

describe("P0 #4: shouldRunConstitutionalAI() gating logic", () => {
  const USER_SCOPED_TOOLS = new Set(["get_user_orders", "get_order_details"]);

  // Save + restore env vars so each test gets a clean slate.
  const originalGateEnv = process.env.OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY;
  const originalEnabledEnv = process.env.OUTPUT_CONSTITUTIONAL_AI_ENABLED;

  afterEach(() => {
    if (originalGateEnv === undefined) {
      delete process.env.OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY;
    } else {
      process.env.OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY = originalGateEnv;
    }
    if (originalEnabledEnv === undefined) {
      delete process.env.OUTPUT_CONSTITUTIONAL_AI_ENABLED;
    } else {
      process.env.OUTPUT_CONSTITUTIONAL_AI_ENABLED = originalEnabledEnv;
    }
  });

  it("returns FALSE for a pure catalog query (no user-scoped tools, no PII, no account keywords)", () => {
    process.env.OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY = "true";
    const shouldRun = shouldRunConstitutionalAI(
      ["search_catalog"], // catalog-only tool
      USER_SCOPED_TOOLS,
      false, // no PII in input
      false, // not a private query
    );
    expect(shouldRun).toBe(false);
  });

  it("returns FALSE for a KB-only query (search_knowledge_base)", () => {
    process.env.OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY = "true";
    const shouldRun = shouldRunConstitutionalAI(
      ["search_knowledge_base"],
      USER_SCOPED_TOOLS,
      false,
      false,
    );
    expect(shouldRun).toBe(false);
  });

  it("returns FALSE for a seller-listings query (search_seller_listings)", () => {
    process.env.OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY = "true";
    const shouldRun = shouldRunConstitutionalAI(
      ["search_seller_listings"],
      USER_SCOPED_TOOLS,
      false,
      false,
    );
    expect(shouldRun).toBe(false);
  });

  it("returns FALSE when no tools were called (general chat)", () => {
    process.env.OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY = "true";
    const shouldRun = shouldRunConstitutionalAI([], USER_SCOPED_TOOLS, false, false);
    expect(shouldRun).toBe(false);
  });

  it("returns TRUE when a user-scoped tool was called (get_user_orders)", () => {
    process.env.OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY = "true";
    const shouldRun = shouldRunConstitutionalAI(
      ["get_user_orders"],
      USER_SCOPED_TOOLS,
      false,
      false,
    );
    expect(shouldRun).toBe(true);
  });

  it("returns TRUE when a user-scoped tool was called (get_order_details)", () => {
    process.env.OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY = "true";
    const shouldRun = shouldRunConstitutionalAI(
      ["get_order_details"],
      USER_SCOPED_TOOLS,
      false,
      false,
    );
    expect(shouldRun).toBe(true);
  });

  it("returns TRUE when a user-scoped tool was called alongside catalog tools", () => {
    process.env.OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY = "true";
    const shouldRun = shouldRunConstitutionalAI(
      ["search_catalog", "get_user_orders"],
      USER_SCOPED_TOOLS,
      false,
      false,
    );
    expect(shouldRun).toBe(true);
  });

  it("returns TRUE when the user's INPUT had PII redacted (LLM might echo it back)", () => {
    process.env.OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY = "true";
    const shouldRun = shouldRunConstitutionalAI(
      ["search_catalog"], // catalog-only tool
      USER_SCOPED_TOOLS,
      true, // INPUT had PII redacted
      false,
    );
    expect(shouldRun).toBe(true);
  });

  it("returns TRUE when the query matched account keywords (isPrivateQuery=true)", () => {
    process.env.OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY = "true";
    const shouldRun = shouldRunConstitutionalAI(
      [], // no tools called
      USER_SCOPED_TOOLS,
      false, // no PII in input
      true, // query matched account keywords ("my order", etc.)
    );
    expect(shouldRun).toBe(true);
  });

  it("respects OUTPUT_CONSTITUTIONAL_AI_ENABLED (global kill switch) — verified via source-shape", () => {
    // CONSTITUTIONAL_AI_ENABLED is read at MODULE LOAD TIME (line ~64 of
    // outputSafety.ts), so setting the env var in a test AFTER the module is
    // imported doesn't affect the already-loaded constant. We verify the
    // behavior via source-shape inspection instead.
    const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");
    // The helper must check CONSTITUTIONAL_AI_ENABLED FIRST + return false if
    // it's off (the global kill switch wins).
    const helperIdx = source.indexOf("export function shouldRunConstitutionalAI");
    const helperBlock = source.slice(helperIdx);
    // The first guard in the helper body must be the CONSTITUTIONAL_AI_ENABLED check.
    expect(helperBlock).toMatch(/if\s*\(\s*!CONSTITUTIONAL_AI_ENABLED\s*\)\s*return\s+false/);
  });

  it("returns TRUE for everything when gating is disabled (OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY=false)", () => {
    process.env.OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY = "false";
    // Back-compat mode: gating is off, so the check runs on every response.
    const shouldRun = shouldRunConstitutionalAI(
      ["search_catalog"], // catalog-only — would normally skip
      USER_SCOPED_TOOLS,
      false,
      false,
    );
    expect(shouldRun).toBe(true);
  });
});

// ─── Source-shape tests: outputSafety.ts module structure ───────────────────

describe("P0 #4: outputSafety.ts exports the shouldRunConstitutionalAI helper", () => {
  const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");

  it("exports shouldRunConstitutionalAI", () => {
    expect(source).toMatch(/export\s+function\s+shouldRunConstitutionalAI/);
  });

  it("the helper accepts (toolCalls, userScopedTools, hadInputPii, isPrivateQuery)", () => {
    expect(source).toMatch(/shouldRunConstitutionalAI\s*\(\s*toolCalls:\s*readonly\s+string\[\]/);
    expect(source).toMatch(/userScopedTools:\s*ReadonlySet<string>/);
    expect(source).toMatch(/hadInputPii:\s*boolean/);
    expect(source).toMatch(/isPrivateQuery:\s*boolean/);
  });

  it("the helper respects OUTPUT_CONSTITUTIONAL_AI_ENABLED (global kill switch)", () => {
    expect(source).toMatch(/CONSTITUTIONAL_AI_ENABLED/);
  });

  it("the helper respects OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY (gating opt-out)", () => {
    expect(source).toMatch(/OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY/);
  });

  it("the helper documents the 3 gates (user-scoped tools, input PII, account keywords)", () => {
    expect(source).toMatch(/user-scoped tool/i);
    expect(source).toMatch(/input had PII/i);
    expect(source).toMatch(/account keyword/i);
  });
});

// ─── Source-shape tests: checkOutputSafety accepts runConstitutionalAI ──────

describe("P0 #4: checkOutputSafety accepts a runConstitutionalAI parameter", () => {
  const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");

  it("checkOutputSafety has a 3rd `runConstitutionalAI: boolean = true` parameter", () => {
    expect(source).toMatch(/runConstitutionalAI:\s*boolean\s*=\s*true/);
  });

  it("the JSDoc documents the P0 #4 fix + latency savings", () => {
    expect(source).toMatch(/P0 #4 fix/);
    expect(source).toMatch(/200ms.+3s/i);
  });

  it("PII redaction is gated on runPiiRedaction (P2 #12)", () => {
    // P0 #4: PII redaction ALWAYS runs (when runConstitutionalAI=false, the PII
    // redaction still runs — only the LLM-based Constitutional AI check is skipped).
    // P2 #12: PII redaction is NOW ALSO gated on `runPiiRedaction` (separate
    // parameter). When both PII_REDACTION_ENABLED=true AND runPiiRedaction=true,
    // the PII redaction runs. When runPiiRedaction=false, it's skipped.
    expect(source).toMatch(/if\s*\(\s*PII_REDACTION_ENABLED\s*&&\s*runPiiRedaction\s*\)/);
  });

  it("Constitutional AI check is gated on runConstitutionalAI", () => {
    // The Constitutional AI block must check BOTH CONSTITUTIONAL_AI_ENABLED
    // AND runConstitutionalAI.
    expect(source).toMatch(/if\s*\(\s*CONSTITUTIONAL_AI_ENABLED\s*&&\s*runConstitutionalAI\s*\)/);
  });

  it("logs when Constitutional AI is skipped (for observability)", () => {
    expect(source).toMatch(/Constitutional AI check SKIPPED/i);
    expect(source).toMatch(/P0 #4 gating/i);
  });
});

// ─── Source-shape tests: routes/ai.ts wires the gating + parallelization ──

describe("P0 #4: routes/ai.ts wires shouldRunConstitutionalAI + parallel batch", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("imports shouldRunConstitutionalAI from outputSafety", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*shouldRunConstitutionalAI[^}]*\}\s*from\s*["']\.\.\/lib\/outputSafety["']/,
    );
  });

  it("computes runConstitutionalAI via shouldRunConstitutionalAI()", () => {
    expect(source).toMatch(/const\s+runConstitutionalAI\s*=\s*shouldRunConstitutionalAI/);
  });

  it("passes toolCalls, USER_SCOPED_TOOLS, piiResult.hadPii, isPrivateQuery to shouldRunConstitutionalAI", () => {
    expect(source).toMatch(
      /shouldRunConstitutionalAI\([\s\S]*?toolCalls[\s\S]*?USER_SCOPED_TOOLS[\s\S]*?piiResult\.hadPii[\s\S]*?isPrivateQuery/,
    );
  });

  it("passes runConstitutionalAI to checkOutputSafety()", () => {
    expect(source).toMatch(
      /checkOutputSafety\(\s*safeMessage,\s*fullResponse[\s\S]*?runConstitutionalAI/,
    );
  });

  it("uses Promise.allSettled to run followups + safety check in parallel", () => {
    expect(source).toMatch(/Promise\.allSettled\(\s*\[/);
    // The Promise.allSettled array must include both branches.
    const match = source.match(
      /Promise\.allSettled\(\s*\[[\s\S]*?generateFollowupsStructured[\s\S]*?checkOutputSafety[\s\S]*?\]\s*\)/,
    );
    expect(match).not.toBeNull();
  });

  it("logs when Constitutional AI is skipped (for observability)", () => {
    expect(source).toMatch(/Constitutional AI check SKIPPED/i);
    expect(source).toMatch(/P0 #4/);
  });

  it("the JSDoc documents the parallelization rationale (max vs sum)", () => {
    expect(source).toMatch(/max\(followupsMs,\s*safetyMs\)/i);
    expect(source).toMatch(/sequential/i);
  });

  it("sends followups_loading event BEFORE the parallel batch (immediate UI feedback)", () => {
    // The `followups_loading` event must be sent BEFORE the Promise.allSettled.
    const followupsLoadingIdx = source.indexOf('type: "followups_loading"');
    const parallelBatchIdx = source.indexOf(
      "const [followupsSettled, safetySettled] = await Promise.allSettled",
    );
    expect(followupsLoadingIdx).toBeGreaterThan(-1);
    expect(parallelBatchIdx).toBeGreaterThan(-1);
    expect(followupsLoadingIdx).toBeLessThan(parallelBatchIdx);
  });
});

// ─── Source-shape tests: tone log is fire-and-forget ──────────────────────

describe("P0 #4: tone match log is fire-and-forget (non-blocking)", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("the tone match logAiEvent call is NOT awaited", () => {
    // Find the tone_match logAiEvent call. It should NOT be prefixed with `await`.
    // We look for the call without `await` immediately before `logAiEvent`.
    const toneLogIdx = source.indexOf('"tone_match"');
    expect(toneLogIdx).toBeGreaterThan(-1);
    // Walk backwards from the tone_match call to find the call site.
    const callSite = source.lastIndexOf("logAiEvent(", toneLogIdx);
    expect(callSite).toBeGreaterThan(-1);
    // Check the 10 chars before `logAiEvent(` — should NOT contain `await`.
    const prefix = source.slice(Math.max(0, callSite - 10), callSite);
    expect(prefix).not.toMatch(/await\s+$/);
  });

  it("the tone match logAiEvent call still has .catch(() => {}) (best-effort)", () => {
    // Find the tone_match logAiEvent + check the surrounding code has .catch.
    // The call spans multiple lines: logAiEvent(...).catch(() => {});
    // We look for the call + the .catch on the same logical block.
    const toneLogIdx = source.indexOf('"tone_match"');
    expect(toneLogIdx).toBeGreaterThan(-1);
    // Look ahead from the tone_match call to find the .catch — it should be
    // within ~500 chars (the call + .catch is short).
    const callBlock = source.slice(toneLogIdx, toneLogIdx + 500);
    expect(callBlock).toMatch(/\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
  });
});

// ─── Backward compatibility: existing safety features still work ────────────

describe("P0 #4: backward compatibility — existing safety features preserved", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("still sends response_replaced SSE event when output is modified", () => {
    expect(source).toContain('type: "response_replaced"');
  });

  it("still sends followups_loading + followups_delta SSE events", () => {
    expect(source).toContain('type: "followups_loading"');
    expect(source).toContain('type: "followups_delta"');
  });

  it("still logs output_pii_redacted event when PII is found in output", () => {
    expect(source).toContain("output_pii_redacted");
  });

  it("still logs output_unsafe_blocked event when Constitutional AI flags response", () => {
    expect(source).toContain("output_unsafe_blocked");
  });

  it("still persists the assistant message before sending done", () => {
    // The persistMessage call must come BEFORE the `done` event.
    const persistIdx = source.indexOf('persistMessage(session.id, "assistant"');
    const doneIdx = source.indexOf('type: "done"');
    expect(persistIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeLessThan(doneIdx);
  });

  it("still writes to both caches (exact-match + semantic) after safety check", () => {
    expect(source).toMatch(/setCachedResponse\(/);
    expect(source).toMatch(/setSemanticCachedResponse\(/);
  });

  it("still records cost (fire-and-forget)", () => {
    expect(source).toMatch(/recordCost\(/);
  });
});

// ─── Source-shape tests: env var documentation ──────────────────────────────

describe("P0 #4: env var documentation in outputSafety.ts", () => {
  const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");

  it("documents OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY env var", () => {
    expect(source).toMatch(/OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY/);
    expect(source).toMatch(/default.*true|true.*default/i);
  });

  it("documents that the gate defaults to enabled (true)", () => {
    // The default should be "true" — gating is on by default.
    expect(source).toMatch(
      /process\.env\.OUTPUT_CONSTITUTIONAL_AI_GATE_USER_SCOPED_ONLY\s*\?\?\s*["']true["']/,
    );
  });

  it("documents the opt-out behavior (set to false for back-compat)", () => {
    expect(source).toMatch(/paranoid|back-compat|pre-P0/i);
  });
});

// ─── Behavioral tests: checkOutputSafety with runConstitutionalAI=false ────

describe("P0 #4: checkOutputSafety respects the runConstitutionalAI parameter", () => {
  // We can't easily test the full checkOutputSafety function without mocking
  // the LLM call (checkConstitutionalAI calls Groq/Gemini). Instead, we verify
  // the source code gates the LLM call correctly.
  const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");

  it("the LLM call (checkConstitutionalAI) is inside the `if (CONSTITUTIONAL_AI_ENABLED && runConstitutionalAI)` block", () => {
    // Find the line that calls checkConstitutionalAI.
    const llmCallIdx = source.indexOf("await checkConstitutionalAI(");
    expect(llmCallIdx).toBeGreaterThan(-1);
    // Walk backwards to find the nearest `if (` — it must include both
    // CONSTITUTIONAL_AI_ENABLED AND runConstitutionalAI.
    const beforeLlmCall = source.slice(0, llmCallIdx);
    const lastIfIdx = beforeLlmCall.lastIndexOf("if (");
    expect(lastIfIdx).toBeGreaterThan(-1);
    const ifBlock = source.slice(lastIfIdx, llmCallIdx);
    expect(ifBlock).toMatch(/CONSTITUTIONAL_AI_ENABLED/);
    expect(ifBlock).toMatch(/runConstitutionalAI/);
  });

  it("PII redaction is NOT inside the runConstitutionalAI gate (always runs)", () => {
    // Find the PII redaction block. It should be in its own `if (PII_REDACTION_ENABLED)`
    // block, NOT inside the runConstitutionalAI condition.
    const piiIdx = source.indexOf("await redactPii(sanitizedResponse)");
    expect(piiIdx).toBeGreaterThan(-1);
    // Walk backwards to find the nearest `if (`.
    const beforePii = source.slice(0, piiIdx);
    const lastIfIdx = beforePii.lastIndexOf("if (");
    const ifBlock = source.slice(lastIfIdx, piiIdx);
    // The PII redaction if-block must check PII_REDACTION_ENABLED, NOT
    // runConstitutionalAI.
    expect(ifBlock).toMatch(/PII_REDACTION_ENABLED/);
    expect(ifBlock).not.toMatch(/runConstitutionalAI/);
  });
});
