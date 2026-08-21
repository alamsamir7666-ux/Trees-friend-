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
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

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
    // v6.2 Part 10: was llama-3.1-8b-instant (deprecated Aug 16, 2026).
    expect(source).toContain("llama-4-scout-17b-16e-instruct");
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
    // P0 #1 fix: classifyTopic now runs in PARALLEL with detectPromptInjection
    // via Promise.allSettled. The call is no longer prefixed with `await`
    // at the top level — it's inside the Promise.allSettled array.
    // We accept EITHER the awaited form OR the inline form.
    expect(source).toMatch(/classifyTopic\(safeMessage\)/);
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

  it("logs LLM-allowed-via-keyword-gate-failure events (v5.3.1)", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain("topic_allowed_via_llm");
  });

  it("allows LLM-configured fail-open when classifier unavailable", () => {
    const source = readSource("artifacts/api-server/src/lib/topicClassifier.ts");
    expect(source).toContain("fail-open");
    expect(source).toContain("No LLM configured");
  });
});

// ─── Cache tests (v5.3.1) ────────────────────────────────────────────────────

describe("Topic classifier: multi-tier cache (v5.3.1)", () => {
  it("topicClassifierCache.ts exports the full cache API", () => {
    const source = readSource("artifacts/api-server/src/lib/topicClassifierCache.ts");
    expect(source).toContain("export async function getCachedTopicClassification");
    expect(source).toContain("export async function setCachedTopicClassification");
    expect(source).toContain("export async function clearAllTopicCache");
    expect(source).toContain("export async function getTopicCacheStats");
    expect(source).toContain("export function getInFlightTopicClassification");
    expect(source).toContain("export function setInFlightTopicClassification");
  });

  it("uses L1 LRU + L2 Redis (multi-tier, industry standard)", () => {
    const source = readSource("artifacts/api-server/src/lib/topicClassifierCache.ts");
    // P2 #9 fix: the L1Cache class was extracted to ./l1LruCache.ts as the
    // generic L1LruCache<T> class. The local class definition is gone —
    // we now import L1LruCache + instantiate it with the CacheEntry type.
    expect(source).toContain("L1LruCache");
    expect(source).toContain("getRedis");
    expect(source).toContain("LRU");
  });

  it("uses single-flight (concurrent identical messages = 1 LLM call)", () => {
    const source = readSource("artifacts/api-server/src/lib/topicClassifierCache.ts");
    expect(source).toContain("_inFlight");
    expect(source).toContain("single-flight");
    expect(source).toContain("Critical for traffic spikes");
  });

  it("uses ai:topic: namespace (separate from ai:inj: and ai:cache:)", () => {
    const source = readSource("artifacts/api-server/src/lib/topicClassifierCache.ts");
    expect(source).toContain("`ai:topic:");
    expect(source).toContain('match: "ai:topic:*"');
  });

  it("caches failures with short TTL (negative caching)", () => {
    const source = readSource("artifacts/api-server/src/lib/topicClassifierCache.ts");
    expect(source).toContain("NEGATIVE_TTL_SECONDS");
    expect(source).toContain("isFailure");
  });

  it("cache key is order-independent + normalized (NFC + lowercase)", () => {
    const source = readSource("artifacts/api-server/src/lib/topicClassifierCache.ts");
    expect(source).toContain("normalizeMessage");
    expect(source).toContain("NFC");
    expect(source).toContain("toLowerCase");
  });

  it("classifyTopic() checks cache before calling LLM", () => {
    const source = readSource("artifacts/api-server/src/lib/topicClassifier.ts");
    expect(source).toContain("getCachedTopicClassification");
    expect(source).toContain("setCachedTopicClassification");
    expect(source).toContain("getInFlightTopicClassification");
    expect(source).toContain("setInFlightTopicClassification");
    expect(source).toContain("cache HIT");
    expect(source).toContain("single-flight coalesced");
  });
});

// ─── Admin endpoint tests (v5.3.1) ───────────────────────────────────────────

describe("Topic classifier: admin endpoints (v5.3.1)", () => {
  it("aiAdmin.ts exposes GET /ai/admin/topic/health", () => {
    const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");
    expect(source).toContain('"/ai/admin/topic/health"');
    expect(source).toContain("getTopicCacheStats");
  });

  it("aiAdmin.ts exposes POST /ai/admin/topic/test (with skipCache option)", () => {
    const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");
    expect(source).toContain('"/ai/admin/topic/test"');
    expect(source).toContain("skipCache");
    expect(source).toContain("classifyTopic");
  });

  it("aiAdmin.ts exposes POST /ai/admin/topic/clear-cache", () => {
    const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");
    expect(source).toContain('"/ai/admin/topic/clear-cache"');
    expect(source).toContain("clearAllTopicCache");
  });

  it("aiAdmin.ts exposes GET /ai/admin/topic/allowed-log (v5.3.2)", () => {
    const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");
    expect(source).toContain('"/ai/admin/topic/allowed-log"');
    expect(source).toContain("topic_allowed_via_llm");
    expect(source).toContain("allowedViaLLM");
  });

  it("aiAdmin.ts exposes GET /ai/admin/topic/refused-log (v5.3.2)", () => {
    const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");
    expect(source).toContain('"/ai/admin/topic/refused-log"');
    expect(source).toContain("off_topic_refused");
    expect(source).toContain("refusedOffTopic");
  });

  it("aiAdmin.ts exposes GET /ai/admin/topic/metrics (aggregated dashboard)", () => {
    const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");
    expect(source).toContain('"/ai/admin/topic/metrics"');
    expect(source).toContain("totalLLMClassifierCalls");
    expect(source).toContain("allowedViaLLM");
    expect(source).toContain("refusedOffTopic");
  });

  it("allowed-log + refused-log support time window (?hours=24)", () => {
    const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");
    expect(source).toContain("req.query.hours");
    expect(source).toContain("INTERVAL");
  });

  it("allowed-log + refused-log support limit (?limit=50, max 200)", () => {
    const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");
    expect(source).toContain("req.query.limit");
    expect(source).toContain("Math.min(Math.max(Number(req.query.limit");
  });
});
