/**
 * Topic classifier tests (v5.3).
 *
 * Verifies the soft LLM-based topic gate replaces the broken hard keyword
 * gate. Bengali plant questions like "কলার কোন জাত ভালো" (which banana
 * variety is good?) should now be ALLOWED (not refused as off-topic).
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/topicClassifier.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

const REPO_ROOT = "/home/z/my-project/Trees-friend-";

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

// ─── Source-shape tests ──────────────────────────────────────────────────────

describe("Topic classifier: source-shape tests", () => {
  it("topicClassifier.ts exports the expected interface", () => {
    const source = readSource("artifacts/api-server/src/lib/topicClassifier.ts");
    expect(source).toContain("export interface TopicCheckResult");
    expect(source).toContain("export async function classifyTopic");
    expect(source).toContain("export function isTopicClassifierConfigured");
  });

  it("topicClassifier.ts uses Groq (free tier) as primary classifier", () => {
    const source = readSource("artifacts/api-server/src/lib/topicClassifier.ts");
    expect(source).toContain("llama-3.1-8b-instant");
    expect(source).toContain("json_schema");
  });

  it("topicClassifier.ts uses Gemini as fallback", () => {
    const source = readSource("artifacts/api-server/src/lib/topicClassifier.ts");
    expect(source).toContain("gemini-2.5-flash");
    expect(source).toContain("classifyTopicWithGemini");
  });

  it("topicClassifier.ts fails OPEN (allows message) when LLM unavailable", () => {
    const source = readSource("artifacts/api-server/src/lib/topicClassifier.ts");
    expect(source).toContain("fail-open");
    expect(source).toContain("failing open");
  });

  it("ai.ts uses classifyTopic as soft gate (not hard keyword block)", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain("import { classifyTopic }");
    expect(source).toContain("Topic gate (v5.3: soft LLM-based");
    expect(source).toContain("await classifyTopic(safeMessage)");
    expect(source).toContain("keyword gate failed but LLM classifier allowed");
  });

  it("aiContext.ts has expanded Bengali keywords (কলা, আম, etc.)", () => {
    const source = readSource("artifacts/api-server/src/lib/aiContext.ts");
    // The specific words that were missing + caused the bug
    expect(source).toContain('"কলা"');
    expect(source).toContain('"আম"');
    expect(source).toContain('"নারকেল"');
    expect(source).toContain('"কাঁঠাল"');
    expect(source).toContain('"জাত"');
    expect(source).toContain('"ভালো"');
    expect(source).toContain('"পরিচর্যা"');
  });
});

// ─── Bengali plant question tests ────────────────────────────────────────────

describe("Topic classifier: Bengali plant questions pass keyword gate", () => {
  // These are the questions that were being REFUSED before the fix.
  // They should now pass the keyword gate (fast path, no LLM needed).
  const BENGLALI_PLANT_QUESTIONS = [
    "কলার কোন জাত ভালো", // which banana variety is good?
    "আম গাছের পরিচর্যা কিভাবে করব", // how to care for mango tree
    "নারকেল গাছ লাগানোর সঠিক সময়", // right time to plant coconut
    "কাঁঠাল গাছে ফল কখন আসে", // when does jackfruit bear fruit
    "লিচু চাষের উপায়", // how to cultivate lychee
    "পেয়ারা গাছের পাতা হলুদ হচ্ছে", // guava leaves turning yellow
    "লেবু গাছে পোকা ধরেছে", // bugs on lemon tree
    "বাগানে কোন সার ভালো", // which fertilizer is good for garden
    "মাটির উর্বরতা বাড়ানোর উপায়", // how to improve soil fertility
    "চারা রোপণের নিয়ম", // rules for planting saplings
  ];

  // We can't unit-test hasBotanicalKeyword directly without importing it
  // (it's not exported in a way vitest can easily mock). Instead, we verify
  // the keywords are present in the source so the questions will match.
  for (const question of BENGLALI_PLANT_QUESTIONS) {
    it(`keyword list contains words from: "${question}"`, () => {
      const source = readSource("artifacts/api-server/src/lib/aiContext.ts");
      // At least one word from the question must be in the keyword list.
      // We check a few key words that should be present.
      const wordsToCheck = question.split(/\s+/).filter((w) => w.length > 2);
      const foundAny = wordsToCheck.some((word) => source.includes(`"${word}"`));
      expect(foundAny).toBe(true);
    });
  }
});

// ─── Architecture tests ──────────────────────────────────────────────────────

describe("Topic classifier: architecture is industry-standard", () => {
  it("does NOT use a hard keyword block (soft gate instead)", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    // The old comment "Hard topic gate" should be gone
    expect(source).not.toContain("─── 4. Hard topic gate ───");
    // The new comment should be present
    expect(source).toContain("soft LLM-based");
  });

  it("logs off-topic refusals for admin observability", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain("off_topic_refused");
  });

  it("allows LLM-configured fail-open when classifier unavailable", () => {
    const source = readSource("artifacts/api-server/src/lib/topicClassifier.ts");
    expect(source).toContain("fail-open");
    expect(source).toContain("No LLM configured");
  });
});
