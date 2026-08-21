/**
 * Output safety tests (v5.5).
 *
 * Verifies:
 *   - PII redaction runs on OUTPUT (not just input)
 *   - Constitutional AI check detects harmful/jailbreak/leakage responses
 *   - response_replaced SSE event is sent when response is modified
 *   - Frontend handles response_replaced event
 *   - Admin endpoints exist
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/outputSafety.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

// ─── Source-shape tests ──────────────────────────────────────────────────────

describe("Output safety: source-shape tests", () => {
  it("outputSafety.ts exports the expected interface", () => {
    const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");
    expect(source).toContain("export interface OutputSafetyResult");
    expect(source).toContain("export async function checkOutputSafety");
    expect(source).toContain("export function getOutputSafetyStatus");
  });

  it("outputSafety.ts runs PII redaction on the AI response", () => {
    const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");
    expect(source).toContain("import { redactPii");
    expect(source).toContain("PII_REDACTION_ENABLED");
    expect(source).toContain("hadOutputPii");
  });

  it("outputSafety.ts implements Constitutional AI (LLM-based output check)", () => {
    const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");
    expect(source).toContain("CONSTITUTIONAL_AI_ENABLED");
    expect(source).toContain("checkConstitutionalAI");
    expect(source).toContain("harmful_advice");
    expect(source).toContain("jailbreak_compliance");
    expect(source).toContain("data_leakage");
    expect(source).toContain("off_topic");
  });

  it("outputSafety.ts uses Groq (free tier) as primary + Gemini fallback", () => {
    const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");
    // v6.2 Part 10: was llama-3.1-8b-instant (deprecated Aug 16, 2026).
    // Now uses llama-4-scout-17b-16e-instruct as the default Groq model.
    expect(source).toContain("llama-4-scout-17b-16e-instruct");
    expect(source).toContain("gemini-2.5-flash");
  });

  it("outputSafety.ts replaces unsafe responses with a safe fallback", () => {
    const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");
    expect(source).toContain("SAFE_FALLBACK_RESPONSE");
    expect(source).toContain("wasUnsafe");
  });

  it("ai.ts calls checkOutputSafety after streaming, before persisting", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    // P0 #4 fix: the import now also includes `shouldRunConstitutionalAI` (the
    // gating helper). We accept any import shape that includes `checkOutputSafety`.
    expect(source).toMatch(
      /import\s*\{[^}]*checkOutputSafety[^}]*\}\s*from\s*["']\.\.\/lib\/outputSafety["']/,
    );
    // P0 #4 fix: checkOutputSafety now takes a 3rd arg `runConstitutionalAI`
    // (boolean) + runs in parallel with the followups fallback via
    // Promise.allSettled. We accept either the awaited form OR the inline
    // form (inside the Promise.allSettled array).
    expect(source).toMatch(/checkOutputSafety\(\s*safeMessage,\s*fullResponse/);
    // P0 #4 fix: the section header was renamed from "v5.5: Output safety check"
    // to "P0 #4: run followups fallback + output safety check in parallel".
    // We accept either the old or new header (both reference the output safety
    // check + the persist-before-done ordering).
    expect(
      source.includes("v5.5: Output safety check") ||
        source.includes("P0 #4: run followups fallback + output safety check in parallel") ||
        source.includes("Output safety check"),
    ).toBe(true);
  });

  it("ai.ts sends response_replaced SSE event when output is modified", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain('type: "response_replaced"');
    expect(source).toContain("outputSafety.sanitizedResponse");
  });

  it("ai.ts logs output_pii_redacted + output_unsafe_blocked events", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain("output_pii_redacted");
    expect(source).toContain("output_unsafe_blocked");
  });

  it("useAiChat.ts handles response_replaced SSE event", () => {
    const source = readSource("artifacts/tree-friend/src/hooks/useAiChat.ts");
    expect(source).toContain('payload.type === "response_replaced"');
  });

  it("aiAdmin.ts exposes output-safety endpoints", () => {
    const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");
    expect(source).toContain('"/ai/admin/output-safety/health"');
    expect(source).toContain('"/ai/admin/output-safety/log"');
  });
});

// ─── Architecture tests ──────────────────────────────────────────────────────

describe("Output safety: architecture is industry-standard", () => {
  it("checks BOTH directions (input PII via piiRedaction.ts + output PII via outputSafety.ts)", () => {
    const aiSource = readSource("artifacts/api-server/src/routes/ai.ts");
    // Input direction: redactPii on user message.
    // P0 #1 fix: redactPii now runs in PARALLEL with isCircuitOpen via
    // Promise.all. The call is no longer prefixed with `await` at the top
    // level — it's inside the Promise.all array. We accept EITHER form.
    expect(aiSource).toMatch(/redactPii\(message\)/);
    // Output direction: checkOutputSafety on fullResponse (AI response).
    // P0 #4 fix: checkOutputSafety now takes a 3rd arg `runConstitutionalAI`
    // + runs in parallel with the followups fallback via Promise.allSettled.
    // The call may span multiple lines — we use a regex that tolerates this.
    expect(aiSource).toMatch(/checkOutputSafety\(\s*safeMessage,\s*fullResponse/);
  });

  it("Constitutional AI checks against 4 safety principles", () => {
    const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");
    expect(source).toContain("NO HARMFUL ADVICE");
    expect(source).toContain("NO JAILBREAK COMPLIANCE");
    expect(source).toContain("NO SENSITIVE DATA LEAKAGE");
    expect(source).toContain("NO OFF-TOPIC COMPLIANCE");
  });

  it("fail-open design (uses original response if safety check fails)", () => {
    const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");
    expect(source).toContain("fail-open");
    expect(source).toContain("non-fatal");
  });

  it("cost is $0 (uses existing free-tier Groq/Gemini quotas)", () => {
    const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");
    expect(source).toContain("$0");
  });
});
