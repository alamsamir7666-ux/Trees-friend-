/**
 * Tests for Bug #9 + Bug #10 fixes: cost tracking + token count.
 *
 * Bug #9 — Cost Tracking Returns $0 for Groq:
 *   - All models were marked tier "free" with $0 pricing.
 *   - Groq streaming didn't return usage (no stream_options.include_usage).
 *   - Result: cost_usd was always 0, even for paid-tier Groq usage.
 *
 * Bug #10 — Cost Tracker Uses Wrong Token Count:
 *   - The route fell back from totalTokenCount to candidatesTokenCount
 *     (completion tokens) when total was missing — storing the COMPLETION
 *     count as the total. The stored token_count was ~30% of the true total.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/costTracking.test.ts
 */
import { describe, it, expect } from "vitest";

// Ensure the AI_SESSION_SECRET is set (required by sessionToken.ts which is
// transitively imported). setupEnv.ts handles this for the rest of the suite.
process.env.AI_SESSION_SECRET ??=
  "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";

import { calculateCost, getModelPricing, getAllPricing } from "../src/lib/costTracker";

describe("Bug #9 fix: costTracker has real per-model pricing", () => {
  it("Groq llama-3.3-70b-versatile has non-zero pricing", () => {
    const pricing = getModelPricing("llama-3.3-70b-versatile");
    expect(pricing).not.toBeNull();
    expect(pricing!.prompt).toBeGreaterThan(0);
    expect(pricing!.completion).toBeGreaterThan(0);
    expect(pricing!.tier).toBe("paid");
  });

  it("Groq llama-3.1-8b-instant has non-zero pricing", () => {
    const pricing = getModelPricing("llama-3.1-8b-instant");
    expect(pricing).not.toBeNull();
    expect(pricing!.prompt).toBeGreaterThan(0);
    expect(pricing!.completion).toBeGreaterThan(0);
    expect(pricing!.tier).toBe("paid");
  });

  it("Gemini models are still marked free tier ($0)", () => {
    // Gemini's Google AI Studio free tier is genuinely $0. We don't
    // inflate these — the admin sees $0 spent on Gemini, which is correct.
    const geminiModels = [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-pro",
      "gemini-3.0-flash",
      "gemini-3.5-flash",
      "gemini-3.6-flash",
    ];
    for (const model of geminiModels) {
      const pricing = getModelPricing(model);
      expect(pricing).not.toBeNull();
      expect(pricing!.prompt).toBe(0);
      expect(pricing!.completion).toBe(0);
      expect(pricing!.tier).toBe("free");
    }
  });

  it("default pricing for unknown models is $0 (not inflated)", () => {
    // Bug #9 fix: the old default was { prompt: 0.5, completion: 1.5, tier: "paid" }
    // which inflated costs for new models. The new default is $0 (free tier
    // assumption) so unknown models don't produce misleading cost numbers.
    const cost = calculateCost("unknown-new-model-2027", {
      promptTokens: 1000,
      completionTokens: 500,
    });
    expect(cost.costUsd).toBe(0);
    expect(cost.tier).toBe("free");
  });

  it("getAllPricing returns the full pricing table", () => {
    const all = getAllPricing();
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(9); // 7 Gemini + 2 Groq
    expect(all["llama-3.3-70b-versatile"]).toBeDefined();
    expect(all["gemini-2.5-flash"]).toBeDefined();
  });
});

describe("Bug #9 fix: calculateCost computes non-zero cost for Groq", () => {
  it("calculates non-zero cost for llama-3.3-70b-versatile", () => {
    const cost = calculateCost("llama-3.3-70b-versatile", {
      promptTokens: 1000,
      completionTokens: 500,
    });
    // prompt: 1000/1M * $0.59 = $0.00059
    // completion: 500/1M * $0.79 = $0.000395
    // total: $0.000985
    expect(cost.promptCostUsd).toBeCloseTo(0.00059, 6);
    expect(cost.completionCostUsd).toBeCloseTo(0.000395, 6);
    expect(cost.costUsd).toBeCloseTo(0.000985, 6);
    expect(cost.tier).toBe("paid");
    expect(cost.promptTokens).toBe(1000);
    expect(cost.completionTokens).toBe(500);
  });

  it("calculates non-zero cost for llama-3.1-8b-instant", () => {
    const cost = calculateCost("llama-3.1-8b-instant", {
      promptTokens: 1000,
      completionTokens: 500,
    });
    // prompt: 1000/1M * $0.05 = $0.00005
    // completion: 500/1M * $0.08 = $0.00004
    // total: $0.00009
    expect(cost.promptCostUsd).toBeCloseTo(0.00005, 6);
    expect(cost.completionCostUsd).toBeCloseTo(0.00004, 6);
    expect(cost.costUsd).toBeCloseTo(0.00009, 6);
    expect(cost.tier).toBe("paid");
  });

  it("returns $0 for Gemini free tier (correct — Gemini is genuinely free)", () => {
    const cost = calculateCost("gemini-2.5-flash", {
      promptTokens: 1000,
      completionTokens: 500,
    });
    expect(cost.costUsd).toBe(0);
    expect(cost.tier).toBe("free");
    // Token counts are still tracked even when cost is $0.
    expect(cost.promptTokens).toBe(1000);
    expect(cost.completionTokens).toBe(500);
  });

  it("derives prompt/completion from total when individual values are missing", () => {
    // This is the costTracker's internal fallback: if only totalTokens is
    // provided, split 80/20 prompt/completion.
    const cost = calculateCost("llama-3.3-70b-versatile", {
      totalTokens: 1000,
    });
    expect(cost.promptTokens).toBe(800); // 80% of 1000
    expect(cost.completionTokens).toBe(200); // 20% of 1000
    expect(cost.costUsd).toBeGreaterThan(0);
  });
});

describe("Bug #9 fix: Groq sends usage via stream_options.include_usage", () => {
  it("GroqChatRequest interface has stream_options field", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/lib/groq.ts",
      "utf8",
    );
    expect(source).toContain("stream_options?:");
    expect(source).toContain("include_usage?:");
  });

  it("streamGroqCompletion sets stream_options.include_usage = true", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/lib/groq.ts",
      "utf8",
    );
    expect(source).toContain("stream_options: { include_usage: true }");
  });

  it("StreamResult interface has usage field", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/lib/groq.ts",
      "utf8",
    );
    // Find the StreamResult interface body.
    const match = source.match(/interface StreamResult \{[\s\S]*?\}/);
    expect(match).not.toBeNull();
    expect(match![0]).toContain("usage?:");
    expect(match![0]).toContain("prompt_tokens");
    expect(match![0]).toContain("completion_tokens");
    expect(match![0]).toContain("total_tokens");
  });

  it("streamGroqCompletion captures usage from payload", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/lib/groq.ts",
      "utf8",
    );
    expect(source).toContain("if (payload.usage && typeof payload.usage === \"object\")");
    expect(source).toContain("usage = payload.usage");
  });

  it("both return paths include usage in StreamResult", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/lib/groq.ts",
      "utf8",
    );
    // The [DONE] path + the no-[DONE] fallback path.
    const doneReturns = source.match(/return \{ toolCalls, finishReason, usage \};/g);
    expect(doneReturns).not.toBeNull();
    expect(doneReturns!.length).toBe(2);
  });

  it("onMetadata maps Groq usage to Gemini field names", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/lib/groq.ts",
      "utf8",
    );
    // The onMetadata call should map prompt_tokens → promptTokenCount etc.
    expect(source).toContain("promptTokenCount: result.usage.prompt_tokens");
    expect(source).toContain("candidatesTokenCount: result.usage.completion_tokens");
    expect(source).toContain("totalTokenCount: result.usage.total_tokens");
  });

  it("onMetadata no longer hardcodes usage: undefined", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/lib/groq.ts",
      "utf8",
    );
    // The old code had: usage: undefined, // Groq streaming doesn't return usage
    // The new code maps the captured usage. The old comment should be gone.
    expect(source).not.toContain("Groq streaming doesn't return usage");
  });
});

describe("Bug #10 fix: route derives token count correctly", () => {
  it("no longer falls back from totalTokenCount to candidatesTokenCount", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/ai.ts",
      "utf8",
    );
    // The old code: tokenCount = usage.totalTokenCount ?? usage.candidatesTokenCount;
    // This is WRONG because candidatesTokenCount is completion tokens, not total.
    // The new code checks for totalTokenCount first, then sums prompt + completion.
    expect(source).not.toMatch(
      /tokenCount = usage\.totalTokenCount \?\? usage\.candidatesTokenCount/,
    );
  });

  it("uses totalTokenCount when provided", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/ai.ts",
      "utf8",
    );
    expect(source).toContain("if (typeof usage.totalTokenCount === \"number\")");
    expect(source).toContain("tokenCount = usage.totalTokenCount");
  });

  it("sums prompt + completion when total is missing", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/ai.ts",
      "utf8",
    );
    expect(source).toContain(
      "tokenCount = promptTokens + completionTokens",
    );
  });

  it("only falls back to completion as lower bound (rare case)", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/ai.ts",
      "utf8",
    );
    // The fallback-to-completion path is still there, but ONLY when prompt
    // tokens are also missing (rare). It's labeled as a lower bound, not
    // the total.
    expect(source).toContain("Use as lower bound");
  });

  it("has a comment explaining the Bug #10 fix", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/ai.ts",
      "utf8",
    );
    expect(source).toContain("Bug #10 fix");
    expect(source).toContain("candidatesTokenCount");
    expect(source).toContain("the OUTPUT token count, not the total");
  });
});
