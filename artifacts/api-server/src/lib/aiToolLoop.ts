/**
 * Shared helpers for the multi-round tool-calling loop used by both
 * Gemini (lib/gemini.ts) and Groq (lib/groq.ts).
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 *
 * Both providers run the same conceptual loop:
 *
 *   1. Call the LLM with the conversation + tool declarations.
 *   2. The LLM responds with EITHER text (final answer) OR one or more
 *      `functionCall` parts asking us to execute a tool.
 *   3. If tool calls were made, execute them, append the results to the
 *      conversation, and loop back to step 1.
 *   4. If text was returned, stream it to the client and stop.
 *
 * Two industry-standard concerns live here so they are NOT duplicated
 * (and NOT drift apart) between the two providers:
 *
 *   A. **Max rounds** — configurable, with a sensible default.
 *   B. **Stuck detection** — if the model calls the SAME tool with the
 *      SAME args in two consecutive rounds, it's stuck in a loop. Abort
 *      early with a friendly error instead of burning the whole budget.
 *   C. **Graceful degradation** — when we hit the max-rounds limit, we
 *      don't throw. Instead we let the caller make ONE more "forced
 *      final" call with `tools: undefined` so the user gets SOMETHING
 *      useful (a best-effort answer) instead of a hard error.
 *
 * ─── Industry references ─────────────────────────────────────────────────────
 *
 * - Vercel AI SDK: `maxToolRoundtrips` option (default 5, configurable).
 * - OpenAI Assistants API: implicit max ~25 tool calls per response.
 * - Anthropic Claude: `max_tokens` + tool-use loop with explicit stop reasons.
 *
 * Our default of 10 is intentionally between Vercel (5 — too low for
 * multi-step research queries like "compare 3 products + check my order
 * for the right care instructions") and OpenAI (25 — too generous for a
 * free-tier budget).
 */
import { logger } from "./logger";
// v6.2 Part 12 (Backend Gap Fix #2): import ToolName so ToolStreamEvent,
// ToolCallSignature, and signatureOf() carry typed tool names instead of
// bare strings. A typo or unknown name is now a compile-time error.
import type { ToolName } from "./aiToolSchemas";

// ─── Max rounds configuration ───────────────────────────────────────────────

/**
 * Default maximum number of tool-calling rounds before we stop the loop.
 *
 * Configurable via the `AI_MAX_TOOL_ROUNDS` env var. Must be an integer
 * between 1 and 25 (inclusive). Values outside this range are clamped
 * and a warning is logged.
 *
 * Why 5?
 *   - v6.1 Part 6 (latency optimization): reduced from 10 to 5. Most
 *     legitimate queries need 1-3 rounds. With the auto-inject paths
 *     (KB context + seller-listing context pre-populated via intent
 *     routing), the LLM often needs ZERO tool calls — the context is
 *     already in the prompt. 5 rounds is enough for the rare multi-tool
 *     flow (e.g. get_order → get_product_care) while preventing
 *     runaway loops from burning 30+ seconds.
 *   - The stuck-loop detector (detectStuckLoop) still fires at round 6+
 *     if the model repeats the same tool call with the same args.
 *   - Operators who need more headroom can set AI_MAX_TOOL_ROUNDS=10
 *     (or up to 25) via env var.
 */
export const DEFAULT_MAX_TOOL_ROUNDS = 5;

/**
 * Hard upper bound on AI_MAX_TOOL_ROUNDS. Even if the operator sets
 * AI_MAX_TOOL_ROUNDS=999, we clamp to this to prevent runaway loops
 * from creating unbounded API spend.
 */
export const HARD_MAX_TOOL_ROUNDS_CAP = 25;

/**
 * Soft warning threshold. If a request exceeds this many rounds, we
 * log a warning so operators can investigate (the model may be stuck
 * in a non-identical loop that the stuck-detector doesn't catch).
 *
 * Set to 6 — one above the typical "complex but legitimate" ceiling.
 */
export const TOOL_ROUNDS_WARN_THRESHOLD = 6;

/**
 * Resolves the effective max-tool-rounds for this process.
 *
 * Resolution order:
 *   1. `AI_MAX_TOOL_ROUNDS` env var (parsed as integer)
 *   2. `DEFAULT_MAX_TOOL_ROUNDS` (10)
 *
 * Clamped to [1, HARD_MAX_TOOL_ROUNDS_CAP]. Out-of-range values log a
 * warning and use the clamped value (we don't throw — a misconfigured
 * env var shouldn't take the chatbot offline).
 *
 * The value is read fresh on every call (not cached at module load) so
 * operators can change it without restarting the process.
 */
export function getMaxToolRounds(): number {
  const raw = process.env.AI_MAX_TOOL_ROUNDS;
  if (raw === undefined || raw === null || raw.trim() === "") {
    return DEFAULT_MAX_TOOL_ROUNDS;
  }
  // Use Number() (not parseInt) so non-integer strings like "3.5" are
  // rejected entirely rather than silently truncated to 3. An operator
  // who writes AI_MAX_TOOL_ROUNDS=3.5 probably made a typo and would
  // prefer the default over a silently-wrong value.
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    logger.warn({ raw }, "aiToolLoop: AI_MAX_TOOL_ROUNDS is not a valid integer, using default");
    return DEFAULT_MAX_TOOL_ROUNDS;
  }
  if (parsed < 1) {
    logger.warn({ raw, parsed, clampedTo: 1 }, "aiToolLoop: AI_MAX_TOOL_ROUNDS < 1, clamping to 1");
    return 1;
  }
  if (parsed > HARD_MAX_TOOL_ROUNDS_CAP) {
    logger.warn(
      { raw, parsed, clampedTo: HARD_MAX_TOOL_ROUNDS_CAP },
      `aiToolLoop: AI_MAX_TOOL_ROUNDS > ${HARD_MAX_TOOL_ROUNDS_CAP}, clamping (runaway-loop protection)`,
    );
    return HARD_MAX_TOOL_ROUNDS_CAP;
  }
  return parsed;
}

// ─── Tool-call progress events (v3.7, v5.1) ────────────────────────────────

/**
 * v3.7: Discriminated union for tool-call lifecycle events that stream
 * to the client DURING the multi-round tool loop.
 *
 * v5.1: added `tool_call_delta` — fires as tool-call args accumulate
 * during streaming (Groq/OpenAI-style). The UI can render
 * "Searching for: mang..." → "mango..." as args arrive.
 *
 * NOTE: Gemini's SDK delivers `functionCall` parts COMPLETE (not as
 * deltas), so `tool_call_delta` is only fired by Groq. The route handles
 * this gracefully — if no deltas arrive, the UI just shows the tool name
 * immediately when `tool_call` fires (same as v3.7 behavior).
 *
 * `args` is included in `tool_call` for server-side logging but
 * the route handler does NOT forward it to the client (could contain
 * sensitive data like order IDs or email addresses). Only `name` is
 * sent over SSE. The `tool_call_delta` event sends only the `argsDelta`
 * string (partial JSON), which the frontend accumulates — this is safe
 * because it's the model's generated text, not user input.
 */
export type ToolStreamEvent =
  | { type: "tool_call"; name: ToolName; args: unknown }
  | { type: "tool_result"; name: ToolName; ok: true; durationMs: number; result?: unknown }
  | {
      type: "tool_result";
      name: ToolName;
      ok: false;
      error: string;
      durationMs: number;
    }
  // v5.1: streaming tool-call args delta. Fires as the model generates
  // tool-call arguments token-by-token (Groq/OpenAI only). The frontend
  // accumulates `argsDelta` strings into the full args JSON, rendering
  // partial args as they arrive.
  | {
      type: "tool_call_delta";
      toolCallId: string;
      name?: string; // present on the first delta (when the tool name is known)
      argsDelta: string; // partial JSON string to append
    }
  // v6.2 Part 9 (Gap 17 fix — Phase B): optional progress event emitted by
  // long-running tools during execution. SQL-based tools (search_catalog,
  // get_user_orders, etc.) complete in <100ms + DON'T emit this — the
  // existing tool_call → tool_result flow stays. Future slow tools (e.g.
  // a YouTube transcript fetch that takes 5s, or a multi-step pipeline)
  // can emit tool_progress to give the user live feedback.
  //
  // Industry standard: Vercel AI SDK's `streamUI` tool progress, Claude's
  // "Thinking..." + "Searching..." status updates. The frontend renders
  // `progress` text under the spinner in ToolCallChips so the user sees
  // what the tool is doing RIGHT NOW (not just "Loading…").
  //
  // Backward compatible: existing tools don't emit this, so the frontend
  // falls back to the static "Loading…" label. No migration needed.
  | {
      type: "tool_progress";
      name: ToolName;
      progress: string;
    };

/**
 * Callback fired by the provider when a tool is about to be executed
 * (`tool_call`) or has just finished (`tool_result`). The route handler
 * attaches a callback that writes SSE events to the HTTP response.
 */
export type OnToolEvent = (event: ToolStreamEvent) => void;

// ─── Stuck detection ─────────────────────────────────────────────────────────

/**
 * A normalized signature for a single tool invocation, used to detect
 * when the model is stuck calling the same tool with the same args in
 * a loop.
 *
 * We JSON-stringify the args with sorted keys so `{a:1,b:2}` and
 * `{b:2,a:1}` produce the same signature (the model occasionally
 * re-emits args in a different key order — that's not a real "stuck"
 * case, just a quirk).
 */
export interface ToolCallSignature {
  /**
   * v6.2 Part 12 (Backend Gap Fix #2): typed as `ToolName` (string-literal
   * union) instead of `string`. The signature is built from a tool call's
   * name + args — and the name always comes from `executeTool`, which now
   * narrows to `ToolName` via `isToolName` before dispatch.
   */
  name: ToolName;
  /** Stable JSON serialization of args (sorted keys). */
  argsKey: string;
}

/**
 * Builds a stable signature for a tool call. Two calls with the same
 * name + same args (in any key order) produce the same signature.
 *
 * Used by `isStuckAfterRound` to detect loops.
 *
 * v6.2 Part 12: parameter typed as `ToolName`. Callers (gemini.ts,
 * groq.ts) receive the name from `executeTool`'s callback, which now
 * carries a typed `ToolName`. The narrowing happens at the SSE edge
 * in routes/ai.ts.
 */
export function signatureOf(name: ToolName, args: unknown): ToolCallSignature {
  let argsKey: string;
  try {
    // Normalize null/undefined/non-object args to a stable empty form.
    const safeArgs: object = args !== null && typeof args === "object" ? (args as object) : {};
    // JSON.stringify with a replacer-array of sorted keys → stable output
    // regardless of the key order the model used.
    argsKey = JSON.stringify(
      safeArgs,
      Object.keys(safeArgs).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  } catch {
    // Args weren't a plain object (rare — some tools accept arrays or
    // primitives). Fall back to a best-effort stringification. Stuck
    // detection just won't fire for these — that's fine, the max-rounds
    // cap still protects us.
    argsKey = String(args ?? "");
  }
  return { name, argsKey };
}

/**
 * Detects whether the model is stuck in a loop: calling the SAME tool
 * with the SAME args in two consecutive rounds.
 *
 * Why identical-match instead of fuzzy matching?
 *   - If args are identical, the tool will return the SAME result, so
 *     the model has no new information → it WILL call the same tool
 *     again. There's no recovery path. Abort.
 *   - If args differ (even slightly), the model may be making progress
 *     (e.g. paging through results, refining a search query). Let it
 *     continue up to the max-rounds cap.
 *
 * Only consecutive rounds are compared. If round 1 and round 3 call
 * the same tool with the same args but round 2 was different, that's
 * NOT considered stuck (the model genuinely tried something else in
 * between).
 *
 * @param currentRoundCalls - Signatures of tool calls in the current round.
 * @param previousRoundCalls - Signatures of tool calls in the previous round.
 * @returns The stuck tool name (if detected), or null.
 */
export function detectStuckLoop(
  currentRoundCalls: ToolCallSignature[],
  previousRoundCalls: ToolCallSignature[] | null,
): string | null {
  if (!previousRoundCalls || previousRoundCalls.length === 0) return null;
  if (currentRoundCalls.length === 0) return null;

  // Quick path: if the round-level signature differs, no loop.
  // (Different number of calls, or different ordering → not stuck.)
  if (currentRoundCalls.length !== previousRoundCalls.length) return null;

  // Compare as sets — order within a round may vary.
  const prevSet = new Set(previousRoundCalls.map((s) => `${s.name}::${s.argsKey}`));
  for (const sig of currentRoundCalls) {
    if (prevSet.has(`${sig.name}::${sig.argsKey}`)) {
      // At least one call is identical to a call in the previous round.
      // With equal-length rounds, that's strong evidence of a loop.
      return sig.name;
    }
  }
  return null;
}

// ─── Round-budget state machine ──────────────────────────────────────────────

/**
 * Stateful tracker for the multi-round tool loop. Encapsulates:
 *   - the round counter,
 *   - the per-round signature history (for stuck detection),
 *   - the soft-warning threshold,
 *   - the graceful-degradation "force-final" override.
 *
 * Both gemini.ts and groq.ts use this so they share identical loop-
 * control semantics. The providers only differ in HOW they call the
 * LLM and HOW they parse tool calls from the response — the loop
 * structure (when to stop, when to warn, when to force-final) is shared.
 */
export class ToolRoundBudget {
  private readonly maxRounds: number;
  private round = 0;
  private lastRoundSignatures: ToolCallSignature[] | null = null;
  private warnedAboutHighRoundCount = false;
  private forceFinalEmitted = false;
  /**
   * v3.7 fix: set when stuck-loop detection fires. The main loop `break`s
   * out before `advance()` reaches `maxRounds`, so without this flag the
   * `shouldForceFinal` getter (which only checks `round >= maxRounds`)
   * would return `false` and the graceful-degradation path would be
   * SKIPPED — causing the safety-net `throw` at the bottom of the loop
   * to fire, giving the user a hard error instead of a best-effort
   * answer. With this flag, `shouldForceFinal` returns `true` as soon
   * as either condition holds (budget exhausted OR stuck loop detected).
   */
  private stuckLoopDetected = false;

  constructor() {
    this.maxRounds = getMaxToolRounds();
  }

  /** Current 0-indexed round number. */
  get currentRound(): number {
    return this.round;
  }

  /** True if there are more rounds available before hitting the cap. */
  get hasBudget(): boolean {
    return this.round < this.maxRounds;
  }

  /** True if the operator-set soft threshold has been crossed. */
  get shouldWarnAboutHighRounds(): boolean {
    return !this.warnedAboutHighRoundCount && this.round >= TOOL_ROUNDS_WARN_THRESHOLD;
  }

  /**
   * Advance to the next round. Returns false if we've exhausted the
   * budget (caller should trigger graceful degradation).
   */
  advance(): boolean {
    this.round += 1;
    return this.round < this.maxRounds;
  }

  /**
   * Records the signatures of tool calls made in the round that just
   * completed, so the NEXT round can compare against them for stuck
   * detection.
   */
  recordRound(signatures: ToolCallSignature[]): void {
    this.lastRoundSignatures = signatures;
  }

  /**
   * Returns the stuck tool name if the just-recorded round's calls are
   * identical to the previous round's calls. Returns null otherwise.
   */
  detectStuck(currentSignatures: ToolCallSignature[]): string | null {
    return detectStuckLoop(currentSignatures, this.lastRoundSignatures);
  }

  /** Marks the soft-warning as emitted (so we only log it once per request). */
  markWarned(): void {
    this.warnedAboutHighRoundCount = true;
  }

  /**
   * One-shot flag for the "force final" call. When the budget is
   * exhausted OR a stuck loop was detected, the caller should make ONE
   * more LLM call with tools disabled (forcing a text response) so the
   * user gets SOMETHING. This flag prevents infinite force-final retries.
   *
   * v3.7 fix: previously this only checked `round >= maxRounds`, which
   * meant stuck-loop detection (which `break`s out BEFORE `advance()`
   * reaches `maxRounds`) would NOT trigger the force-final path — the
   * code fell through to the safety-net `throw`, giving users a hard
   * error. Now we also trigger on `stuckLoopDetected`.
   */
  get shouldForceFinal(): boolean {
    return !this.forceFinalEmitted && (this.round >= this.maxRounds || this.stuckLoopDetected);
  }

  /** Marks the force-final call as emitted. */
  markForceFinalEmitted(): void {
    this.forceFinalEmitted = true;
  }

  /**
   * v3.7: Marks that stuck-loop detection fired. Call this BEFORE `break`ing
   * out of the main loop when `detectStuck` returns a non-null tool name.
   * This ensures `shouldForceFinal` returns `true` so the graceful-
   * degradation path runs (instead of the safety-net `throw`).
   */
  markStuck(): void {
    this.stuckLoopDetected = true;
  }

  /** v3.7: True if stuck-loop detection fired (for logging). */
  get hadStuckLoop(): boolean {
    return this.stuckLoopDetected;
  }

  /** The configured max rounds (for logging / error messages). */
  get maxRoundsValue(): number {
    return this.maxRounds;
  }
}

// ─── Friendly error factory ──────────────────────────────────────────────────

/**
 * Builds a user-facing error message for the "hit max rounds" case.
 *
 * The message intentionally doesn't mention internal details (rounds,
 * tool names) — it just tells the user their question was too complex
 * for a single response and suggests rephrasing.
 *
 * This is the LAST-RESORT error: it's only thrown if the graceful-
 * degradation "force final" call ALSO fails. In practice, the force-
 * final call almost always succeeds, so users should never see this.
 */
export function buildMaxRoundsErrorMessage(_maxRounds: number): string {
  return (
    "I'm working through several steps to answer that, but I've hit my " +
    "internal limit for this question. Could you try breaking it into " +
    "smaller parts? For example, ask about one product at a time, or " +
    "check your order separately from care instructions."
  );
}

/**
 * Builds the system-prompt suffix that nudges the model to produce a
 * final text answer when we've detected it's stuck in a tool-calling
 * loop. Used in the "force final" call.
 */
export function buildForceFinalPromptSuffix(): string {
  return (
    "\n\n[SYSTEM] You have called tools several times without producing a " +
    "final answer. Stop calling tools now. Using ONLY the information " +
    "already gathered from previous tool calls, write your best-effort " +
    "response to the user. If you genuinely don't have enough information, " +
    "say so clearly and suggest what the user could try next."
  );
}
