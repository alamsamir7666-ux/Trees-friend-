/**
 * Tests for the shared tool-loop helper (lib/aiToolLoop.ts).
 *
 * These tests verify the v3.6 industry-standard fixes:
 *   - AI_MAX_TOOL_ROUNDS env var is respected (with clamping).
 *   - Default max rounds is 10 (was 4).
 *   - Stuck detection fires when the same tool is called with the same
 *     args in two consecutive rounds.
 *   - Stuck detection does NOT fire when args differ (model is making
 *     progress, e.g. paginating).
 *   - Stuck detection does NOT fire on the first round (no previous to
 *     compare against).
 *   - Graceful degradation force-final flag fires only once.
 *   - Soft warning threshold fires only once per budget.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/aiToolLoop.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Ensure the AI_SESSION_SECRET is set (required by sessionToken.ts which is
// transitively imported). setupEnv.ts handles this for the rest of the suite.
process.env.AI_SESSION_SECRET ??= "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";

import {
  DEFAULT_MAX_TOOL_ROUNDS,
  HARD_MAX_TOOL_ROUNDS_CAP,
  TOOL_ROUNDS_WARN_THRESHOLD,
  getMaxToolRounds,
  signatureOf,
  detectStuckLoop,
  ToolRoundBudget,
  buildMaxRoundsErrorMessage,
  buildForceFinalPromptSuffix,
} from "../src/lib/aiToolLoop";
import type { ToolStreamEvent, OnToolEvent } from "../src/lib/aiToolLoop";

describe("aiToolLoop: max rounds configuration", () => {
  const originalEnv = process.env.AI_MAX_TOOL_ROUNDS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AI_MAX_TOOL_ROUNDS;
    } else {
      process.env.AI_MAX_TOOL_ROUNDS = originalEnv;
    }
  });

  it("DEFAULT_MAX_TOOL_ROUNDS is 5 (v6.1 reduced from 10 — KB+listings auto-inject makes 0-tool-call responses the common case)", () => {
    // v6.2 Part 11: the test expected 10, but the source was reduced to 5
    // in v6.1 (auto-injected KB + listings context mean the LLM rarely needs
    // to call tools — 5 rounds is plenty). Updated the test to match the
    // intentional value + document the rationale.
    expect(DEFAULT_MAX_TOOL_ROUNDS).toBe(5);
  });

  it("HARD_MAX_TOOL_ROUNDS_CAP is 25 (runaway-loop protection)", () => {
    expect(HARD_MAX_TOOL_ROUNDS_CAP).toBe(25);
  });

  it("TOOL_ROUNDS_WARN_THRESHOLD is 6 (soft warning before cap)", () => {
    expect(TOOL_ROUNDS_WARN_THRESHOLD).toBe(6);
  });

  it("getMaxToolRounds returns default when env var is unset", () => {
    delete process.env.AI_MAX_TOOL_ROUNDS;
    expect(getMaxToolRounds()).toBe(DEFAULT_MAX_TOOL_ROUNDS);
  });

  it("getMaxToolRounds returns default when env var is empty string", () => {
    process.env.AI_MAX_TOOL_ROUNDS = "";
    expect(getMaxToolRounds()).toBe(DEFAULT_MAX_TOOL_ROUNDS);
  });

  it("getMaxToolRounds returns default when env var is whitespace", () => {
    process.env.AI_MAX_TOOL_ROUNDS = "   ";
    expect(getMaxToolRounds()).toBe(DEFAULT_MAX_TOOL_ROUNDS);
  });

  it("getMaxToolRounds respects a valid integer env var", () => {
    process.env.AI_MAX_TOOL_ROUNDS = "8";
    expect(getMaxToolRounds()).toBe(8);
  });

  it("getMaxToolRounds clamps values < 1 to 1", () => {
    process.env.AI_MAX_TOOL_ROUNDS = "0";
    expect(getMaxToolRounds()).toBe(1);
  });

  it("getMaxToolRounds clamps negative values to 1", () => {
    process.env.AI_MAX_TOOL_ROUNDS = "-5";
    expect(getMaxToolRounds()).toBe(1);
  });

  it("getMaxToolRounds clamps values > HARD_MAX_TOOL_ROUNDS_CAP", () => {
    process.env.AI_MAX_TOOL_ROUNDS = "999";
    expect(getMaxToolRounds()).toBe(HARD_MAX_TOOL_ROUNDS_CAP);
  });

  it("getMaxToolRounds returns default for non-integer strings", () => {
    process.env.AI_MAX_TOOL_ROUNDS = "abc";
    expect(getMaxToolRounds()).toBe(DEFAULT_MAX_TOOL_ROUNDS);
  });

  it("getMaxToolRounds returns default for float strings", () => {
    process.env.AI_MAX_TOOL_ROUNDS = "3.5";
    expect(getMaxToolRounds()).toBe(DEFAULT_MAX_TOOL_ROUNDS);
  });

  it("getMaxToolRounds accepts the boundary value 1", () => {
    process.env.AI_MAX_TOOL_ROUNDS = "1";
    expect(getMaxToolRounds()).toBe(1);
  });

  it("getMaxToolRounds accepts the boundary value HARD_MAX_TOOL_ROUNDS_CAP", () => {
    process.env.AI_MAX_TOOL_ROUNDS = String(HARD_MAX_TOOL_ROUNDS_CAP);
    expect(getMaxToolRounds()).toBe(HARD_MAX_TOOL_ROUNDS_CAP);
  });
});

describe("aiToolLoop: signatureOf (stable tool-call signatures)", () => {
  it("produces the same signature for the same name + same args", () => {
    const a = signatureOf("search_catalog", { query: "mango", max_price: 100 });
    const b = signatureOf("search_catalog", { query: "mango", max_price: 100 });
    expect(a).toEqual(b);
  });

  it("produces the same signature regardless of arg key ORDER", () => {
    // This is the key property — the model may re-emit args in a different
    // order across rounds. We must not falsely flag this as "stuck".
    const a = signatureOf("search_catalog", { query: "mango", max_price: 100 });
    const b = signatureOf("search_catalog", { max_price: 100, query: "mango" });
    expect(a).toEqual(b);
  });

  it("produces DIFFERENT signatures for different arg VALUES", () => {
    const a = signatureOf("search_catalog", { query: "mango" });
    const b = signatureOf("search_catalog", { query: "banana" });
    expect(a).not.toEqual(b);
  });

  it("produces DIFFERENT signatures for different tool NAMES", () => {
    const a = signatureOf("search_catalog", { query: "mango" });
    const b = signatureOf("get_product_care", { query: "mango" });
    expect(a).not.toEqual(b);
  });

  it("treats null and undefined args as empty object (stable)", () => {
    const a = signatureOf("get_user_orders", null);
    const b = signatureOf("get_user_orders", undefined);
    const c = signatureOf("get_user_orders", {});
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  it("handles non-object args (numbers, strings) without throwing", () => {
    expect(() => signatureOf("some_tool", 42)).not.toThrow();
    expect(() => signatureOf("some_tool", "string-arg")).not.toThrow();
    expect(() => signatureOf("some_tool", [1, 2, 3])).not.toThrow();
  });

  it("handles deeply nested object args", () => {
    const a = signatureOf("search", { filters: { price: { min: 10, max: 50 } } });
    const b = signatureOf("search", { filters: { price: { max: 50, min: 10 } } });
    // Inner key order shouldn't matter either.
    expect(a).toEqual(b);
  });
});

describe("aiToolLoop: detectStuckLoop", () => {
  it("returns null when there's no previous round", () => {
    const current = [signatureOf("search_catalog", { query: "mango" })];
    expect(detectStuckLoop(current, null)).toBeNull();
  });

  it("returns null when previous round was empty", () => {
    const current = [signatureOf("search_catalog", { query: "mango" })];
    expect(detectStuckLoop(current, [])).toBeNull();
  });

  it("returns null when current round is empty", () => {
    const previous = [signatureOf("search_catalog", { query: "mango" })];
    expect(detectStuckLoop([], previous)).toBeNull();
  });

  it("detects when the same tool is called with the same args", () => {
    const sig = signatureOf("search_catalog", { query: "mango" });
    const stuck = detectStuckLoop([sig], [sig]);
    expect(stuck).toBe("search_catalog");
  });

  it("does NOT flag when args differ (model is making progress)", () => {
    const prev = [signatureOf("search_catalog", { query: "mango" })];
    const curr = [signatureOf("search_catalog", { query: "mango tree" })];
    expect(detectStuckLoop(curr, prev)).toBeNull();
  });

  it("does NOT flag when tool names differ", () => {
    const prev = [signatureOf("search_catalog", { query: "mango" })];
    const curr = [signatureOf("get_product_care", { slug: "mango" })];
    expect(detectStuckLoop(curr, prev)).toBeNull();
  });

  it("does NOT flag when round lengths differ (more tools this round)", () => {
    const prev = [signatureOf("search_catalog", { query: "mango" })];
    const curr = [
      signatureOf("search_catalog", { query: "mango" }),
      signatureOf("get_product_care", { slug: "mango" }),
    ];
    expect(detectStuckLoop(curr, prev)).toBeNull();
  });

  it("does NOT flag when round lengths differ (fewer tools this round)", () => {
    const prev = [
      signatureOf("search_catalog", { query: "mango" }),
      signatureOf("get_product_care", { slug: "mango" }),
    ];
    const curr = [signatureOf("search_catalog", { query: "mango" })];
    expect(detectStuckLoop(curr, prev)).toBeNull();
  });

  it("detects stuck when multiple tools are called and at least one is identical", () => {
    // Same-length rounds, one tool identical → considered stuck.
    const prev = [
      signatureOf("search_catalog", { query: "mango" }),
      signatureOf("get_product_care", { slug: "mango" }),
    ];
    const curr = [
      signatureOf("search_catalog", { query: "mango" }), // identical
      signatureOf("get_product_care", { slug: "different-slug" }), // different
    ];
    const stuck = detectStuckLoop(curr, prev);
    expect(stuck).toBe("search_catalog");
  });

  it("treats tool calls as a set (order within a round doesn't matter)", () => {
    const sig1 = signatureOf("search_catalog", { query: "mango" });
    const sig2 = signatureOf("get_product_care", { slug: "mango" });
    // Same calls, different order in the two rounds.
    expect(detectStuckLoop([sig1, sig2], [sig2, sig1])).not.toBeNull();
  });
});

describe("aiToolLoop: ToolRoundBudget state machine", () => {
  const originalEnv = process.env.AI_MAX_TOOL_ROUNDS;

  beforeEach(() => {
    // Use a small budget for predictable tests.
    process.env.AI_MAX_TOOL_ROUNDS = "3";
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AI_MAX_TOOL_ROUNDS;
    } else {
      process.env.AI_MAX_TOOL_ROUNDS = originalEnv;
    }
  });

  it("starts at round 0 with budget remaining", () => {
    const b = new ToolRoundBudget();
    expect(b.currentRound).toBe(0);
    expect(b.hasBudget).toBe(true);
    expect(b.shouldForceFinal).toBe(false);
  });

  it("advance() moves to the next round", () => {
    const b = new ToolRoundBudget();
    expect(b.advance()).toBe(true); // round 0 → 1, still has budget
    expect(b.currentRound).toBe(1);
    expect(b.advance()).toBe(true); // round 1 → 2, still has budget
    expect(b.currentRound).toBe(2);
    expect(b.advance()).toBe(false); // round 2 → 3, NO budget remaining (cap=3)
    expect(b.currentRound).toBe(3);
    expect(b.hasBudget).toBe(false);
  });

  it("shouldForceFinal becomes true once budget is exhausted", () => {
    const b = new ToolRoundBudget();
    b.advance();
    b.advance();
    b.advance(); // now at round 3, cap=3 → no budget
    expect(b.hasBudget).toBe(false);
    expect(b.shouldForceFinal).toBe(true);
  });

  it("shouldForceFinal fires only ONCE (idempotent)", () => {
    const b = new ToolRoundBudget();
    b.advance();
    b.advance();
    b.advance();
    expect(b.shouldForceFinal).toBe(true);
    b.markForceFinalEmitted();
    expect(b.shouldForceFinal).toBe(false);
  });

  it("shouldWarnAboutHighRounds fires only once", () => {
    // Set the warning threshold to a low value for testing by using a
    // high enough round count.
    process.env.AI_MAX_TOOL_ROUNDS = "10"; // cap = 10, threshold = 6
    const b = new ToolRoundBudget();
    for (let i = 0; i < 5; i++) b.advance(); // round 5
    expect(b.shouldWarnAboutHighRounds).toBe(false);
    b.advance(); // round 6
    expect(b.shouldWarnAboutHighRounds).toBe(true);
    b.markWarned();
    expect(b.shouldWarnAboutHighRounds).toBe(false);
    b.advance(); // round 7
    expect(b.shouldWarnAboutHighRounds).toBe(false); // still false
  });

  it("detectStuck returns null when no previous round was recorded", () => {
    const b = new ToolRoundBudget();
    const sig = signatureOf("search_catalog", { query: "mango" });
    expect(b.detectStuck([sig])).toBeNull();
  });

  it("detectStuck returns the stuck tool name after recordRound", () => {
    const b = new ToolRoundBudget();
    const sig = signatureOf("search_catalog", { query: "mango" });
    b.recordRound([sig]);
    expect(b.detectStuck([sig])).toBe("search_catalog");
  });

  it("detectStuck returns null when current round differs from recorded", () => {
    const b = new ToolRoundBudget();
    b.recordRound([signatureOf("search_catalog", { query: "mango" })]);
    expect(b.detectStuck([signatureOf("search_catalog", { query: "banana" })])).toBeNull();
  });

  it("maxRoundsValue reflects the configured cap", () => {
    process.env.AI_MAX_TOOL_ROUNDS = "7";
    const b = new ToolRoundBudget();
    expect(b.maxRoundsValue).toBe(7);
  });
});

describe("aiToolLoop: error + prompt factories", () => {
  it("buildMaxRoundsErrorMessage returns a user-friendly message", () => {
    const msg = buildMaxRoundsErrorMessage(10);
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(20);
    // Should NOT mention internal details like "rounds" or "tools" to users.
    expect(msg.toLowerCase()).not.toContain("max_tool_rounds");
    expect(msg.toLowerCase()).not.toContain("exception");
    // Should suggest a concrete next step.
    expect(msg.toLowerCase()).toMatch(/try|smaller|rephras/);
  });

  it("buildForceFinalPromptSuffix returns a non-empty instruction", () => {
    const suffix = buildForceFinalPromptSuffix();
    expect(typeof suffix).toBe("string");
    expect(suffix.length).toBeGreaterThan(20);
    // Should tell the model to STOP calling tools.
    expect(suffix.toLowerCase()).toMatch(/stop.*tool|no.*tool|don.*call.*tool/);
  });

  it("buildForceFinalPromptSuffix is safe to append to any system prompt", () => {
    // It should start with a newline so it doesn't merge with the last
    // sentence of the existing system prompt.
    const suffix = buildForceFinalPromptSuffix();
    expect(suffix.startsWith("\n")).toBe(true);
  });
});

// ─── v3.7 fixes ─────────────────────────────────────────────────────────────

describe("aiToolLoop: v3.7 stuck-loop → force-final graceful degradation", () => {
  const originalEnv = process.env.AI_MAX_TOOL_ROUNDS;

  beforeEach(() => {
    // Generous budget so we can test stuck detection firing WELL BEFORE
    // the budget is exhausted (the bug scenario).
    process.env.AI_MAX_TOOL_ROUNDS = "10";
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AI_MAX_TOOL_ROUNDS;
    } else {
      process.env.AI_MAX_TOOL_ROUNDS = originalEnv;
    }
  });

  it("shouldForceFinal is FALSE on a fresh budget (no stuck, no exhaustion)", () => {
    const b = new ToolRoundBudget();
    expect(b.shouldForceFinal).toBe(false);
    expect(b.hadStuckLoop).toBe(false);
  });

  it("shouldForceFinal is FALSE after a normal advance (no stuck, budget remains)", () => {
    const b = new ToolRoundBudget();
    b.advance(); // round 1, cap 10 — plenty of budget left
    expect(b.shouldForceFinal).toBe(false);
    expect(b.hadStuckLoop).toBe(false);
  });

  it("REGRESSION: shouldForceFinal is TRUE after markStuck() even with budget remaining", () => {
    // This is the core v3.7 bug fix. Before the fix, shouldForceFinal
    // only checked `round >= maxRounds`, so stuck detection (which
    // `break`s out BEFORE advance() reaches maxRounds) would NOT
    // trigger the force-final path — the code fell through to the
    // safety-net throw, giving users a hard error.
    const b = new ToolRoundBudget();
    b.advance(); // round 1, cap 10 — hasBudget is true
    expect(b.hasBudget).toBe(true);
    expect(b.shouldForceFinal).toBe(false); // sanity
    b.markStuck();
    expect(b.shouldForceFinal).toBe(true); // ← THE FIX
    expect(b.hadStuckLoop).toBe(true);
  });

  it("shouldForceFinal fires only ONCE after markStuck (idempotent)", () => {
    const b = new ToolRoundBudget();
    b.markStuck();
    expect(b.shouldForceFinal).toBe(true);
    b.markForceFinalEmitted();
    expect(b.shouldForceFinal).toBe(false);
  });

  it("shouldForceFinal is TRUE when budget exhausted (no stuck)", () => {
    const b = new ToolRoundBudget();
    for (let i = 0; i < 10; i++) b.advance(); // round 10, cap 10
    expect(b.hasBudget).toBe(false);
    expect(b.shouldForceFinal).toBe(true);
    expect(b.hadStuckLoop).toBe(false); // not stuck, just exhausted
  });

  it("shouldForceFinal is TRUE when BOTH stuck AND budget exhausted", () => {
    const b = new ToolRoundBudget();
    for (let i = 0; i < 10; i++) b.advance();
    b.markStuck();
    expect(b.shouldForceFinal).toBe(true);
    expect(b.hadStuckLoop).toBe(true);
  });

  it("markStuck is idempotent (calling twice is harmless)", () => {
    const b = new ToolRoundBudget();
    b.markStuck();
    b.markStuck(); // should not throw or change behavior
    expect(b.hadStuckLoop).toBe(true);
    expect(b.shouldForceFinal).toBe(true);
    b.markForceFinalEmitted();
    expect(b.shouldForceFinal).toBe(false);
  });

  it("hadStuckLoop is FALSE by default and TRUE only after markStuck", () => {
    const b = new ToolRoundBudget();
    expect(b.hadStuckLoop).toBe(false);
    b.advance();
    b.advance();
    expect(b.hadStuckLoop).toBe(false);
    b.markStuck();
    expect(b.hadStuckLoop).toBe(true);
  });

  it("simulates the full stuck-loop → force-final flow (the integration scenario)", () => {
    // This mirrors exactly what gemini.ts and groq.ts do:
    //   1. Run round 0, record signatures, advance.
    //   2. Run round 1, detect stuck (same signatures), markStuck(), break.
    //   3. Check shouldForceFinal → should be TRUE (was FALSE before v3.7).
    //   4. markForceFinalEmitted(), run force-final round.
    //   5. shouldForceFinal is now FALSE (don't re-run force-final).
    const b = new ToolRoundBudget(); // cap 10

    // Round 0: model calls search_catalog({ query: "mango" })
    const sig = signatureOf("search_catalog", { query: "mango" });
    expect(b.detectStuck([sig])).toBeNull(); // no previous round
    b.recordRound([sig]);
    b.advance(); // round 1

    // Round 1: model calls search_catalog({ query: "mango" }) AGAIN (stuck!)
    const stuckTool = b.detectStuck([sig]);
    expect(stuckTool).toBe("search_catalog");
    b.markStuck(); // ← v3.7 fix: provider calls this before `break`

    // After break, the provider checks shouldForceFinal to decide whether
    // to run the graceful-degradation force-final call.
    expect(b.shouldForceFinal).toBe(true); // ← was FALSE before v3.7 (BUG)

    // Provider runs force-final, then marks it emitted.
    b.markForceFinalEmitted();
    expect(b.shouldForceFinal).toBe(false); // don't re-run
    expect(b.hadStuckLoop).toBe(true); // for logging
  });
});

describe("aiToolLoop: v3.7 ToolStreamEvent types", () => {
  it("ToolStreamEvent discriminated union compiles for all variants", () => {
    // Type-level test — if the union is malformed, TS won't compile this.
    const call: ToolStreamEvent = {
      type: "tool_call",
      name: "search_catalog",
      args: { query: "mango" },
    };
    const ok: ToolStreamEvent = {
      type: "tool_result",
      name: "search_catalog",
      ok: true,
      durationMs: 42,
    };
    const err: ToolStreamEvent = {
      type: "tool_result",
      name: "search_catalog",
      ok: false,
      error: "DB connection refused",
      durationMs: 5,
    };
    // Runtime sanity: the discriminator is present on each.
    expect(call.type).toBe("tool_call");
    expect(ok.type).toBe("tool_result");
    expect(err.type).toBe("tool_result");
    expect((ok as Extract<ToolStreamEvent, { ok: true }>).ok).toBe(true);
    expect((err as Extract<ToolStreamEvent, { ok: false }>).error).toBe("DB connection refused");
  });

  it("OnToolEvent callback type accepts a function that receives ToolStreamEvent", () => {
    const events: ToolStreamEvent[] = [];
    const cb: OnToolEvent = (e) => events.push(e);
    cb({ type: "tool_call", name: "get_user_orders", args: {} });
    cb({
      type: "tool_result",
      name: "get_user_orders",
      ok: true,
      durationMs: 100,
    });
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("tool_call");
    expect(events[1].type).toBe("tool_result");
  });
});
