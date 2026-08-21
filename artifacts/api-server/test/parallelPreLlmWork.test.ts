/**
 * P0 #1 fix: parallelized pre-LLM-call work tests.
 *
 * Verifies that `routes/ai.ts` runs the pre-LLM-call work in parallel via
 * `Promise.all` / `Promise.allSettled` instead of sequentially.
 *
 * Three parallel batches:
 *   - PII redaction + circuit check (Promise.all)
 *   - Topic classifier + prompt-injection detector (Promise.allSettled)
 *   - Session/memory/history + context-building (Promise.allSettled for two batches)
 *
 * Plus:
 *   - Pure greeting shortcut now runs BEFORE the LLM gates (saves LLM cost).
 *   - Failure handling: each batch uses fail-open defaults on rejection.
 *
 * Uses source-shape inspection (same pattern as `systemPromptRebuild.test.ts`).
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/parallelPreLlmWork.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

// ─── P0 #1: PII redaction + circuit check run in parallel ─────────────────

describe("P0 #1: PII redaction + circuit check run in parallel", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("uses Promise.all to run redactPii + isCircuitOpen concurrently", () => {
    // The Promise.all array must include both redactPii(message) and isCircuitOpen().
    expect(source).toMatch(/Promise\.all\(\s*\[/);
    expect(source).toMatch(/redactPii\(message\)/);
    expect(source).toMatch(/isCircuitOpen\(\)/);
    // Verify they're in the SAME Promise.all (no sequential awaits between them).
    const promiseAllMatch = source.match(
      /Promise\.all\(\s*\[[\s\S]*?redactPii\(message\)[\s\S]*?isCircuitOpen\(\)[\s\S]*?\]\)/,
    );
    expect(promiseAllMatch).not.toBeNull();
  });

  it("destructures the Promise.all result as [piiResult, circuitOpen]", () => {
    expect(source).toMatch(/\[\s*piiResult\s*,\s*circuitOpen\s*\]\s*=\s*await\s*Promise\.all/);
  });

  it("uses piiResult.redacted for safeMessage (was previously inline)", () => {
    expect(source).toMatch(/piiResult\.redacted/);
    expect(source).toMatch(/const\s+safeMessage\s*=\s*piiResult\.redacted/);
  });

  it("logs pii_redacted event only when piiResult.hadPii is true (gated)", () => {
    expect(source).toMatch(/if\s*\(\s*piiResult\.hadPii\s*\)/);
  });
});

// ─── P0 #1: Topic classifier + prompt-injection detector run in parallel ─

describe("P0 #1: topic classifier + prompt-injection detector run in parallel", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("uses Promise.allSettled to run classifyTopic + detectPromptInjection concurrently", () => {
    // We use allSettled (not all) so a rejection in one classifier doesn't
    // cancel the other. The fail-open defaults handle rejections gracefully.
    expect(source).toMatch(/Promise\.allSettled\(\s*\[/);
    // The Promise.allSettled array must include both classifyTopic(safeMessage)
    // and detectPromptInjection(safeMessage).
    const promiseAllSettledMatch = source.match(
      /Promise\.allSettled\(\s*\[[\s\S]*?(classifyTopic\(safeMessage\)|detectPromptInjection\(safeMessage\))[\s\S]*?(classifyTopic\(safeMessage\)|detectPromptInjection\(safeMessage\))[\s\S]*?\]\s*\)/,
    );
    expect(promiseAllSettledMatch).not.toBeNull();
  });

  it("uses Promise.resolve(null) for classifyTopic when needsTopicCheck is false", () => {
    // When the intent is PURCHASE/KNOWLEDGE (skipTopicClassifier), we don't
    // call classifyTopic at all — we resolve null in its place.
    expect(source).toMatch(
      /needsTopicCheck\s*\?\s*classifyTopic\(safeMessage\)\s*:\s*Promise\.resolve\(null\)/,
    );
  });

  it("destructures the Promise.allSettled result as [topicSettled, injectionSettled]", () => {
    expect(source).toMatch(
      /\[\s*topicSettled\s*,\s*injectionSettled\s*\]\s*=\s*await\s*Promise\.allSettled/,
    );
  });

  it("extracts topicCheck value from topicSettled (or null on rejection)", () => {
    expect(source).toMatch(/topicSettled\.status\s*===\s*["']fulfilled["']/);
    expect(source).toMatch(/topicSettled\.value/);
  });

  it("extracts injectionCheck value or builds fail-open default on rejection", () => {
    expect(source).toMatch(/injectionSettled\.status\s*===\s*["']fulfilled["']/);
    // Fail-open default has detected: false + provider: "failed-open".
    expect(source).toMatch(/detected:\s*false/);
    expect(source).toMatch(/provider:\s*["']failed-open["']/);
  });

  it("logs classifier rejections (fail-open observability)", () => {
    expect(source).toMatch(/classifyTopic rejected \(fail-open/);
    expect(source).toMatch(/detectPromptInjection rejected \(fail-open/);
  });

  it("checks injectionCheck.detected BEFORE topicCheck.isOnTopic (security priority)", () => {
    // The injection check must be evaluated BEFORE the topic check —
    // security takes priority over content policy.
    const injectionIdx = source.indexOf("injectionCheck.detected");
    const topicIdx = source.indexOf("topicCheck && !topicCheck.isOnTopic");
    expect(injectionIdx).toBeGreaterThan(-1);
    expect(topicIdx).toBeGreaterThan(-1);
    expect(injectionIdx).toBeLessThan(topicIdx);
  });
});

// ─── P0 #1: Pure greeting shortcut runs BEFORE LLM gates ────────────────────

describe("P0 #1: pure greeting shortcut runs BEFORE the LLM gates", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("declares isGreeting from isPureGreeting(safeMessage)", () => {
    expect(source).toMatch(/const\s+isGreeting\s*=\s*isPureGreeting\(safeMessage\)/);
  });

  it("declares hasBotanicalKw from hasBotanicalKeyword(safeMessage)", () => {
    expect(source).toMatch(/const\s+hasBotanicalKw\s*=\s*hasBotanicalKeyword\(safeMessage\)/);
  });

  it("the greeting shortcut (if isGreeting) runs BEFORE the Promise.allSettled for LLM gates", () => {
    const greetingIdx = source.indexOf("if (isGreeting) {");
    const parallelLlmGatesIdx = source.indexOf(
      "const [topicSettled, injectionSettled] = await Promise.allSettled",
    );
    expect(greetingIdx).toBeGreaterThan(-1);
    expect(parallelLlmGatesIdx).toBeGreaterThan(-1);
    // The greeting shortcut must come BEFORE the parallel LLM gates.
    expect(greetingIdx).toBeLessThan(parallelLlmGatesIdx);
  });
});

// ─── P0 #1: Session/memory/history + context-building run in parallel ─────

describe("P0 #1: session/memory/history + context-building run in parallel", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("declares batchAPromise (async IIFE for session/memory/history chain)", () => {
    expect(source).toMatch(/const\s+batchAPromise\s*=\s*\(async\s*\(\)/);
  });

  it("batchAPromise calls loadSessionMemory + persistMessage + fetchHistoryForGemini", () => {
    // The BATCH A chain runs these sequentially within the IIFE.
    expect(source).toMatch(/batchAPromise[\s\S]*?loadSessionMemory\(session\.id\)/);
    expect(source).toMatch(/batchAPromise[\s\S]*?persistMessage\(session\.id,\s*["']user["']/);
    expect(source).toMatch(/batchAPromise[\s\S]*?fetchHistoryForGemini\(/);
  });

  it("batchAPromise kicks off maybeSummarize fire-and-forget", () => {
    expect(source).toMatch(
      /batchAPromise[\s\S]*?maybeSummarize\(session\.id,\s*existingMemory\)\.catch/,
    );
  });

  it("batchAPromise returns { memory, geminiHistory }", () => {
    expect(source).toMatch(/return\s*\{\s*memory:\s*existingMemory,\s*geminiHistory\s*\}/);
  });

  it("declares batchBPromise (Promise.all for context-building)", () => {
    // The declaration may have a type annotation `: Promise<BatchBResult>`
    // between the variable name and the `=`. The regex tolerates this.
    expect(source).toMatch(
      /const\s+batchBPromise\s*(?::\s*Promise<[^>]+>)?\s*=\s*Promise\.all\(\s*\[/,
    );
  });

  it("batchBPromise includes getActivePrompt", () => {
    expect(source).toMatch(/batchBPromise[\s\S]*?getActivePrompt\(\)/);
  });

  it("batchBPromise includes buildCatalogContext", () => {
    expect(source).toMatch(/batchBPromise[\s\S]*?buildCatalogContext\(/);
  });

  it("batchBPromise includes getTopKbEntriesForPrompt with skipRerank=true (P0 #3)", () => {
    // For the non-skipped path (KNOWLEDGE/GREETING intent), the call must
    // pass `true` as the third arg (skipRerank: P0 #3).
    expect(source).toMatch(
      /getTopKbEntriesForPrompt\(\s*safeMessage,\s*undefined,\s*true\s*\/\*\s*skipRerank:\s*P0 #3\s*\*\/\)/,
    );
  });

  it("batchBPromise includes searchSellerListings for PURCHASE/MIXED intent", () => {
    expect(source).toMatch(/batchBPromise[\s\S]*?searchSellerListings\(\s*\{/);
  });

  it("batchBPromise has its own catch for fail-open on rejection", () => {
    expect(source).toMatch(/batchBPromise[\s\S]*?\.catch\(\s*\(err\)/);
  });

  it("uses Promise.allSettled to await batchAPromise + batchBPromise in parallel", () => {
    expect(source).toMatch(
      /\[\s*batchASettled\s*,\s*batchBSettled\s*\]\s*=\s*await\s*Promise\.allSettled/,
    );
    // batchBPromise has a type annotation `: Promise<BatchBResult>` between
    // the name and `=`. We use a regex search instead of indexOf to find
    // the declaration site (tolerates the type annotation).
    const batchAIdx = source.search(/const\s+batchAPromise\s*=/);
    const batchBIdx = source.search(/const\s+batchBPromise\s*(?::\s*Promise<[^>]+>)?\s*=/);
    const joinIdx = source.indexOf(
      "const [batchASettled, batchBSettled] = await Promise.allSettled",
    );
    expect(batchAIdx).toBeGreaterThan(-1);
    expect(batchBIdx).toBeGreaterThan(-1);
    expect(joinIdx).toBeGreaterThan(batchAIdx);
    expect(joinIdx).toBeGreaterThan(batchBIdx);
  });

  it("handles batchASettled rejection (returns 500)", () => {
    expect(source).toMatch(/batchASettled\.status\s*===\s*["']rejected["']/);
    expect(source).toMatch(/Failed to load conversation history/);
  });

  it("handles batchBSettled rejection defensively (falls back to empty context)", () => {
    expect(source).toMatch(/batchBSettled\.status\s*===\s*["']rejected["']/);
    expect(source).toMatch(/unexpectedly rejected \(defensive fallback/);
  });

  it("extracts memory + geminiHistory from batchASettled.value", () => {
    expect(source).toMatch(
      /const\s+\{\s*memory\s*,\s*geminiHistory\s*\}\s*=\s*batchASettled\.value/,
    );
  });

  it("extracts promptVersionInfo + catalogContext + kbContext + listingSearchResult from batchB", () => {
    expect(source).toMatch(
      /\[\s*promptVersionInfo\s*,\s*catalogContext\s*,\s*batchBKbContext\s*,\s*listingSearchResult\s*\]/,
    );
  });

  it("declares kbContext as `let` (reassigned in Gap #4 fallback)", () => {
    expect(source).toMatch(/let\s+kbContext\s*=\s*batchBKbContext/);
  });
});

// ─── P0 #1: documentation + JSDoc ───────────────────────────────────────────

describe("P0 #1: JSDoc documents the parallel batches + latency rationale", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("documents PII + circuit check parallel Promise.all", () => {
    expect(source).toMatch(/PII redaction\s*\+\s*cost circuit breaker\s*\(PARALLEL\)/i);
    expect(source).toMatch(/P0 #1 fix/);
  });

  it("documents the topic + injection parallel Promise.allSettled", () => {
    expect(source).toMatch(/Topic gate\s*\+\s*prompt-injection detection\s*\(PARALLEL\)/i);
  });

  it("documents the session/memory/history + context-building parallel batches", () => {
    expect(source).toMatch(/PARALLEL context building/i);
    expect(source).toMatch(/BATCH A/);
    expect(source).toMatch(/BATCH B/);
  });

  it("documents the latency savings estimate", () => {
    // The JSDoc should mention the sequential cost vs the parallel cost.
    expect(source).toMatch(/sequential/i);
    expect(source).toMatch(/max\(batchA,\s*batchB\)/);
  });

  it("documents the OpenAI moderation API parallel-classifier pattern (industry standard)", () => {
    expect(source).toMatch(/OpenAI's moderation API/);
  });

  it("documents the fail-open defaults for classifier rejections", () => {
    expect(source).toMatch(/fail-open/i);
    // The phrase "better than blocking all" appears in the JSDoc — the full
    // phrase "better than blocking all chat traffic during a classifier
    // outage" may span newlines, so we use the shorter prefix.
    expect(source).toMatch(/better than blocking all/i);
  });
});

// ─── P0 #1: backward compatibility — existing behavior preserved ──────────

describe("P0 #1: backward compatibility — early-return paths preserved", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("still returns throttled response when circuit is open", () => {
    expect(source).toMatch(/cost circuit OPEN — throttling request/);
    expect(source).toMatch(/throttled:\s*true/);
  });

  it("still returns canned greeting response for pure greetings", () => {
    expect(source).toMatch(/GREETING_INTRO_MESSAGE/);
    expect(source).toMatch(/greeting:\s*true/);
  });

  it("still returns refusal for off-topic messages", () => {
    expect(source).toMatch(/off-topic message refused/);
    expect(source).toMatch(/offTopic:\s*true/);
  });

  it("still returns refusal for prompt-injection attacks", () => {
    expect(source).toMatch(/prompt-injection DETECTED/);
    expect(source).toMatch(/prompt_injection_blocked/);
  });

  it("still calls findOrCreateSession for all rejection paths", () => {
    // All 4 early-return paths (throttled, greeting, off-topic, injection)
    // must still call findOrCreateSession to persist the user's message.
    const matches = source.match(
      /findOrCreateSession\(resolved\.sid,\s*safeMessage,\s*resolved\.uid\)/g,
    );
    expect(matches).not.toBeNull();
    // At least 4 call sites (throttled + greeting + off-topic + injection + main).
    expect(matches!.length).toBeGreaterThanOrEqual(4);
  });

  it("still persists the user message before streaming (BATCH A includes persistMessage)", () => {
    expect(source).toMatch(/persistMessage\(session\.id,\s*["']user["'],\s*safeMessage/);
  });

  it("still kicks off maybeSummarize fire-and-forget (non-blocking)", () => {
    expect(source).toMatch(/maybeSummarize\(session\.id,\s*existingMemory\)\.catch/);
    expect(source).toMatch(/fire-and-forget/);
  });

  it("still calls fetchHistoryForGemini with the loaded memory.cutoffId", () => {
    expect(source).toMatch(/fetchHistoryForGemini\(\s*session\.id,\s*existingMemory\.cutoffId/);
  });
});

// ─── P0 #1: GAP #4 fallback (MIXED + 0 listings) still works ──────────────

describe("P0 #1: Gap #4 fallback (MIXED + 0 listings) preserved in the new flow", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("still calls getTopKbEntriesForPrompt as the fallback for MIXED + 0 listings", () => {
    expect(source).toMatch(/MIXED \+ 0 listings → falling back to KB auto-inject/);
    expect(source).toMatch(/fallbackKbContext\s*=\s*await\s+getTopKbEntriesForPrompt/);
  });

  it("the fallback call passes skipRerank=true (P0 #3 — keep the fallback fast)", () => {
    expect(source).toMatch(/skipRerank:\s*P0 #3 — keep the fallback fast/);
  });

  it("reassigns kbContext + knowledgeBlock after the fallback", () => {
    expect(source).toMatch(/kbContext\s*=\s*fallbackKbContext/);
    expect(source).toMatch(
      /knowledgeBlock\s*=\s*formatKbContextForPrompt\(fallbackKbContext\.entries\)/,
    );
  });

  it("re-computes tone matching after the fallback (if applicable)", () => {
    expect(source).toMatch(/fallbackKbContext\.toneCreator\?\.hasToneProfile/);
    expect(source).toMatch(/MIXED fallback tone matching activated/);
  });
});
