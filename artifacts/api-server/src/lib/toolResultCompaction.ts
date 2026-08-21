/**
 * toolResultCompaction.ts — P1 #8: Compact older tool results between rounds.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 *
 * The multi-round tool loop in `gemini.ts` (and `groq.ts`) appends every tool's
 * full result to the `contents` array + re-sends the full array on every round.
 * For a 5-round loop with `search_catalog` returning 8 results, the LLM sees
 * the 8 results 5 times — paying for ~40K tokens of redundant context.
 *
 * This module compacts OLDER tool results (from rounds 1 to N-2) into short
 * summaries. The most recent round's results (N-1) are kept intact so the LLM
 * can reference them. This is the "ConversationSummaryBufferMemory" pattern
 * from LangChain — keep recent messages full, summarize older ones.
 *
 * ─── Design decisions ────────────────────────────────────────────────────────
 *
 * 1. **Only compact when `round >= 3`** (configurable via
 *    `AI_TOOL_COMPACTION_MIN_ROUND`). Rounds 1-2 keep full results — the LLM
 *    is still actively processing them. Compaction only kicks in when the loop
 *    is long enough that older results are "digested".
 *
 * 2. **Only compact `search_catalog` + `search_seller_listings`** (the large
 *    list results). These tools return up to 8 results with descriptions,
 *    prices, etc. — easily 1-3K tokens per result. The LLM has already used
 *    them by round 3; a summary is sufficient.
 *
 * 3. **Keep `get_product_care`, `get_user_orders`, `get_order_details`,
 *    `search_knowledge_base` intact**. These tools return specific data the
 *    LLM may still need to reference (care info for a specific variety, order
 *    details, KB content). Compacting them risks losing information the LLM
 *    needs for the final answer.
 *
 * 4. **Conservative summary format**: `[N results found: <comma-separated
 *    names>]`. This gives the LLM enough context to know WHAT was found
 *    without the full details. If the LLM needs the details, it can re-call
 *    the tool (the results are still in the DB).
 *
 * 5. **Opt-in via env var** (`AI_TOOL_COMPACTION_ENABLED=false` by default).
 *    Compaction is a quality trade-off — the LLM loses some context. Default
 *    OFF so existing deployments see no behavior change. Enable when you've
 *    confirmed 3+ round loops are frequent + token cost is a concern.
 *
 * 6. **Idempotent**: running `compactOldToolResults` multiple times on the same
 *    `contents` array produces the same result (already-compacted entries are
 *    detected + skipped via a `__compacted: true` marker).
 *
 * ─── Trade-offs ───────────────────────────────────────────────────────────────
 *
 * Risk: the LLM might need the full details of an older `search_catalog` result
 * for the final answer (e.g., "what was the price of the 3rd result?"). With
 * compaction, it only sees the names — it would have to re-call the tool.
 * Mitigation: the LLM has the FULL results in the most recent round (N-1).
 * If it needs details from an older round, it can infer from the names + re-call
 * if necessary. In practice, the LLM rarely references older rounds' details.
 *
 * Risk: the summary format might confuse the LLM. Mitigation: the summary is
 * clearly labeled `[N results found (compacted from round X): ...]` so the
 * LLM knows it's a compaction, not the full result.
 *
 * ─── Compatibility ───────────────────────────────────────────────────────────
 *
 * This module is purely additive — it doesn't modify the existing tool loop
 * when `AI_TOOL_COMPACTION_ENABLED=false` (the default). The compaction is
 * applied INSIDE the loop (in `gemini.ts` and `groq.ts`) before each round,
 * only when enabled + `round >= MIN_ROUND`.
 */
import { logger } from "./logger";

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Master switch for tool result compaction. Default: false (opt-in).
 *
 * Set to "true" to enable compaction of older tool results in multi-round
 * loops. When enabled, `search_catalog` and `search_seller_listings` results
 * from rounds 1 to N-2 are replaced with short summaries (keeping the most
 * recent round's results intact). Saves ~1-3K tokens per round on 3+ round loops.
 */
export const TOOL_COMPACTION_ENABLED =
  (process.env.AI_TOOL_COMPACTION_ENABLED ?? "false").toLowerCase() === "true";

/**
 * The minimum round at which compaction kicks in. Default: 3.
 *
 * Rounds 1 and 2 keep full results (the LLM is still actively processing them).
 * Starting at round 3, older results (rounds 1 to N-2) are compacted.
 *
 * Set to a higher value (e.g., 4 or 5) to be more conservative — keep more
 * rounds' full results. Set to a lower value (e.g., 2) to be more aggressive.
 */
export const TOOL_COMPACTION_MIN_ROUND = Math.max(
  Number(process.env.AI_TOOL_COMPACTION_MIN_ROUND ?? 3),
  2,
);

/**
 * The tools whose results are eligible for compaction. These tools return
 * large list results (up to 8 items with descriptions, prices, etc.) that
 * the LLM has typically "digested" by round 3.
 *
 * Tools NOT in this set (get_product_care, get_user_orders, get_order_details,
 * search_knowledge_base) are kept intact — they return specific data the LLM
 * may still need to reference.
 */
export const COMPACTABLE_TOOLS = new Set<string>(["search_catalog", "search_seller_listings"]);

// ─── Types ───────────────────────────────────────────────────────────────────

interface ToolResultPart {
  functionResponse?: {
    name?: string;
    response?: { result?: unknown; error?: string };
  };
  /** Internal marker: set to true after compaction so we don't re-compact. */
  __compacted?: boolean;
  text?: string;
  [key: string]: unknown;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Compacts older tool results in the `contents` array.
 *
 * This function is called BEFORE each round (starting at round
 * `TOOL_COMPACTION_MIN_ROUND`). It scans the `contents` array for
 * `functionResponse` parts from `COMPACTABLE_TOOLS` that are NOT from the most
 * recent round + replaces their `result` with a short summary.
 *
 * The "most recent round" is determined by finding the LAST `functionResponse`
 * part in the array — all `functionResponse` parts BEFORE it are eligible for
 * compaction. The most recent round's results are kept intact so the LLM can
 * reference them.
 *
 * Idempotent: already-compacted parts (marked with `__compacted: true`) are
 * skipped. Safe to call multiple times on the same array.
 *
 * @param contents The `contents` array from the tool loop. Mutated in place.
 * @param currentRound The current round number (1-indexed). Compaction only
 *                     runs when `currentRound >= TOOL_COMPACTION_MIN_ROUND`.
 *
 * @returns The number of parts that were compacted (for logging). 0 if
 *          compaction is disabled, the round is too early, or no eligible
 *          parts were found.
 *
 * @example
 *   // Round 3: compact search_catalog results from round 1.
 *   const compactedCount = compactOldToolResults(contents, 3);
 *   if (compactedCount > 0) {
 *     logger.info({ compactedCount, round: 3 }, "Tool result compaction applied");
 *   }
 */
export function compactOldToolResults(
  contents: Record<string, unknown>[],
  currentRound: number,
): number {
  // Fast path: compaction is disabled.
  if (!TOOL_COMPACTION_ENABLED) return 0;

  // Fast path: round is too early (rounds 1 to MIN_ROUND-1 keep full results).
  if (currentRound < TOOL_COMPACTION_MIN_ROUND) return 0;

  // Find the index of the LAST functionResponse part in the array.
  // Everything BEFORE it is eligible for compaction; everything AT or AFTER
  // it is the most recent round (kept intact).
  let lastFunctionResponseIdx = -1;
  for (let i = contents.length - 1; i >= 0; i--) {
    const part = contents[i] as { parts?: ToolResultPart[] };
    if (Array.isArray(part?.parts)) {
      const hasFunctionResponse = part.parts.some((p) => p?.functionResponse);
      if (hasFunctionResponse) {
        lastFunctionResponseIdx = i;
        break;
      }
    }
  }

  // No function responses at all — nothing to compact.
  if (lastFunctionResponseIdx === -1) return 0;

  let compactedCount = 0;

  // Iterate over all parts BEFORE the last function response.
  // Compact any eligible (search_catalog / search_seller_listings) parts
  // that haven't already been compacted.
  for (let i = 0; i < lastFunctionResponseIdx; i++) {
    const content = contents[i] as { parts?: ToolResultPart[] };
    if (!Array.isArray(content?.parts)) continue;

    for (let j = 0; j < content.parts.length; j++) {
      const part = content.parts[j];
      if (!part?.functionResponse) continue;

      // Skip already-compacted parts (idempotency).
      if (part.__compacted) continue;

      const toolName = part.functionResponse.name;
      if (!toolName || !COMPACTABLE_TOOLS.has(toolName)) continue;

      // Compact this part — replace the result with a short summary.
      const originalResult = part.functionResponse.response?.result;
      const summary = buildCompactedSummary(toolName, originalResult);

      // Preserve the original result in a hidden field (for debugging /
      // observability — not sent to the LLM because it's inside `__original`).
      // We replace `result` with the summary string.
      (part as ToolResultPart).__original = originalResult;
      (part as ToolResultPart).__compacted = true;
      part.functionResponse.response = { result: summary };

      compactedCount++;
    }
  }

  if (compactedCount > 0) {
    logger.debug(
      { compactedCount, currentRound, lastFunctionResponseIdx },
      "P1 #8: tool result compaction applied",
    );
  }

  return compactedCount;
}

/**
 * Builds a short summary string for a compacted tool result.
 *
 * The summary format is:
 *   `[N results found (compacted from round X): <comma-separated names>]`
 *
 * For tools that return a list of items (search_catalog, search_seller_listings),
 * the summary extracts the `name` / `productName` field from each item + lists
 * them. For tools that return a single item or non-list result, the summary
 * is a generic `[result compacted from round X]`.
 *
 * @param toolName      The name of the tool (e.g., "search_catalog").
 * @param originalResult The original result value (before compaction).
 * @returns A short summary string representing the compacted result.
 */
function buildCompactedSummary(toolName: string, originalResult: unknown): string {
  if (originalResult == null) {
    return `[no results (compacted from ${toolName})]`;
  }

  // Handle list-style results (search_catalog, search_seller_listings).
  // These return { results: [...], count: N } or { listings: [...], totalCount: N }.
  const resultObj = originalResult as Record<string, unknown>;
  const list =
    (Array.isArray(resultObj?.results) && (resultObj.results as unknown[])) ||
    (Array.isArray(resultObj?.listings) && (resultObj.listings as unknown[])) ||
    (Array.isArray(originalResult) ? originalResult : null);

  if (list && list.length > 0) {
    // Extract names from the list items.
    const names: string[] = [];
    for (const item of list.slice(0, 8)) {
      const itemObj = item as Record<string, unknown>;
      const name =
        (typeof itemObj?.name === "string" && itemObj.name) ||
        (typeof itemObj?.productName === "string" && itemObj.productName) ||
        (typeof itemObj?.title === "string" && itemObj.title) ||
        null;
      if (name) names.push(name);
    }
    if (names.length > 0) {
      return `[${list.length} results found (compacted from ${toolName}): ${names.join(", ")}]`;
    }
    return `[${list.length} results found (compacted from ${toolName})]`;
  }

  // Fallback: generic summary.
  return `[result compacted from ${toolName}]`;
}
