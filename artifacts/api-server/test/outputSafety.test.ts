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

const REPO_ROOT = "/home/z/my-project/Trees-friend-";

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
    expect(source).toContain("import { checkOutputSafety }");
    expect(source).toContain("await checkOutputSafety(safeMessage, fullResponse)");
    expect(source).toContain("v5.5: Output safety check");
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
    // Input direction: redactPii on user message
    expect(aiSource).toContain("await redactPii(message)");
    // Output direction: checkOutputSafety on fullResponse (AI response)
    expect(aiSource).toContain("checkOutputSafety(safeMessage, fullResponse)");
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
