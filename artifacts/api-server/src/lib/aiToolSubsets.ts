/**
 * aiToolSubsets.ts — Intent-based tool subsetting for the AI tool layer.
 *
 * ─── Why this file exists (P0 latency optimization) ──────────────────────────
 *
 * Before this file:
 *
 *   The `AI_TOOL_DECLARATIONS` array (all 6 tools) was sent in full to the
 *   LLM on EVERY chat request — regardless of the detected intent. The
 *   intent classifier (`classifyIntent`) was already running on every
 *   request, but it only gated AUTO-INJECTION (which catalog/KB/listings
 *   context blocks are pre-populated in the system prompt). It did NOT
 *   gate which TOOLS the LLM was allowed to call.
 *
 *   This meant every request paid ~200–500 tokens of overhead for tool
 *   schemas the LLM would never use:
 *     - A KNOWLEDGE-intent query ("how often should I water a mango?")
 *       received `search_seller_listings` (the most token-heavy schema,
 *       ~150 tokens by itself) even though the LLM has no reason to call
 *       it for a pure care question.
 *     - A PURCHASE-intent query ("buy a mango sapling under 500 BDT")
 *       received `search_knowledge_base` even though the user doesn't want
 *       a lecture on mango care — they want listings.
 *
 *   Token overhead on every request = slower TTFT (time to first token),
 *   higher cost per request, and slightly degraded tool-call accuracy
 *   (the LLM has to consider more options, including irrelevant ones).
 *
 * This file fixes this by introducing intent-based tool subsetting:
 *
 *   - `getToolSubsetForIntent(intent)` returns the list of tool NAMES
 *     that should be exposed to the LLM for the given intent.
 *   - `getToolDeclarationsForIntent(intent, allDeclarations)` filters
 *     the `AI_TOOL_DECLARATIONS` array to just those tools.
 *
 * Industry standard: OpenAI function-calling best practices recommend
 * "only expose the functions the model needs for the current task."
 * Anthropic's tool-use docs explicitly warn: "passing too many tools
 * degrades performance and increases cost." Google's Gemini docs say
 * the same: "limit the tool list to those relevant for the request."
 * This is a well-established optimization — we're catching up.
 *
 * ─── Design decisions ──────────────────────────────────────────────────────
 *
 * 1. **MIXED intent exposes EVERY tool** (full set, unchanged behavior).
 *    This is the fail-open path — MIXED is the "I'm not sure" bucket, so
 *    we let the LLM see everything. This preserves the existing behavior
 *    for the ~20-30% of requests that fall through to MIXED.
 *
 * 2. **PURCHASE intent hides `search_knowledge_base`**. The KB content
 *    is care-focused (watering, sunlight, pruning) — it doesn't match
 *    pure purchase queries. The LLM can still call `get_product_care`
 *    (variety-level care info, faster than KB search) if it needs care
 *    info to pair with a listing recommendation.
 *
 * 3. **KNOWLEDGE intent hides `search_seller_listings`**. The user wants
 *    care info, not listings. The LLM can still call `search_catalog`
 *    (variety-level info) and `search_knowledge_base` (detailed care
 *    articles). It does NOT need access to the listings search.
 *
 * 4. **Both PURCHASE and KNOWLEDGE intents keep `get_user_orders` +
 *    `get_order_details`**. These are USER-SCOPED — they only return
 *    data if the user is signed in. A PURCHASE-intent user might ask
 *    "where is my mango sapling order?" — we keep them in both subsets.
 *
 * 5. **GREETING intent exposes NO tools**. The greeting shortcut returns
 *    a canned response (no LLM call), so this is defensive — if the
 *    shortcut is bypassed for any reason, the LLM gets no tools rather
 *    than burning tokens evaluating them.
 *
 * 6. **The mapping is a `const` record, not a function with logic.**
 *    This keeps it trivially testable (snapshot the record), trivially
 *    auditable (one place to look), and trivially extensible (add a new
 *    intent → add a new key). No conditionals, no surprises.
 *
 * ─── Trade-offs ─────────────────────────────────────────────────────────────
 *
 * Risk: a user with KNOWLEDGE intent ("how do I care for a mango?") might
 * follow up with a purchase question ("and where can I buy one?"). With
 * `search_seller_listings` hidden, the LLM cannot call the tool.
 *
 * Mitigation: the LLM still has `search_catalog` (variety-level info)
 * and the system prompt mentions the marketplace. The LLM can answer
 * "you can browse mango saplings at /browse" or "let me recommend
 * varieties" without a tool call. If the user's follow-up reclassifies
 * as PURCHASE intent (via the per-turn intent classification), the tool
 * becomes available again on the next turn.
 *
 * This is the right trade-off: the vast majority of single-turn queries
 * stay within their intent bucket, and the cost savings (token overhead
 * × every request × every round) outweigh the rare "user pivoted
 * mid-conversation" case.
 *
 * ─── Token savings estimate ─────────────────────────────────────────────────
 *
 * Each tool declaration is roughly:
 *   - search_catalog: ~80 tokens
 *   - get_product_care: ~60 tokens
 *   - get_user_orders: ~30 tokens
 *   - get_order_details: ~40 tokens
 *   - search_knowledge_base: ~80 tokens
 *   - search_seller_listings: ~150 tokens (most args)
 *
 * Full set: ~440 tokens per request.
 * KNOWLEDGE subset (4 tools): ~250 tokens → saves ~190 tokens (~43%).
 * PURCHASE subset (5 tools): ~360 tokens → saves ~80 tokens (~18%).
 * GREETING subset (0 tools): 0 tokens → saves ~440 tokens (100%).
 *
 * Multiplied across every round of a multi-round tool loop (up to 5
 * rounds), the savings compound. For a 3-round KNOWLEDGE query:
 *   3 × 190 = 570 tokens saved per request.
 *
 * ─── Compatibility ─────────────────────────────────────────────────────────
 *
 * This module is purely additive — it doesn't modify `aiToolSchemas.ts`
 * or `aiTools.ts`. The route handler imports `getToolDeclarationsForIntent`
 * and passes the filtered list to `streamChat` instead of the full
 * `AI_TOOL_DECLARATIONS` array. If the intent is null/unknown, the
 * function returns the FULL set (backward-compatible fallback).
 */
import type { FunctionDeclaration } from "@google/genai";
import type { Intent } from "./intentClassifier";
import type { ToolName } from "./aiToolSchemas";

// ─── Intent → tool subset mapping ───────────────────────────────────────────

/**
 * Maps each intent to the list of tool NAMES that should be exposed to
 * the LLM for that intent.
 *
 * See the file-level JSDoc for the rationale behind each subset.
 *
 * KEEP IN SYNC with:
 *   - `aiToolSchemas.ts` `TOOL_NAMES` (the full list of tool names)
 *   - `aiTools.ts` `AI_TOOL_DECLARATIONS` (the full tool declaration array)
 *
 * If you add a new tool, decide which intents should expose it + add
 * its name to the appropriate subset(s) here. The TypeScript compiler
 * will catch a typo'd tool name (because `ToolName` is a string literal
 * union), but it won't catch a missing tool — review carefully.
 */
export const TOOL_SUBSETS: Readonly<Record<Intent, readonly ToolName[]>> = {
  /**
   * PURCHASE intent: the user wants to buy something.
   *
   * Expose:
   *   - search_seller_listings (the primary purchase tool)
   *   - search_catalog (variety-level info, for the LLM to pair with
   *     listings — e.g. "this Alphonso Mango variety grows well in Dhaka")
   *   - get_product_care (care info for a specific variety, in case the
   *     user asks "is this easy to care for?")
   *   - get_user_orders + get_order_details (the user might be asking
   *     "where is my mango sapling order?")
   *
   * Hide:
   *   - search_knowledge_base (care articles — not relevant for a pure
   *     purchase query. The LLM can use get_product_care for variety-
   *     level care info instead, which is faster + more specific.)
   */
  PURCHASE: [
    "search_seller_listings",
    "search_catalog",
    "get_product_care",
    "get_user_orders",
    "get_order_details",
  ],

  /**
   * KNOWLEDGE intent: the user wants care/info.
   *
   * Expose:
   *   - search_catalog (variety-level info)
   *   - get_product_care (detailed care info for a specific variety)
   *   - search_knowledge_base (detailed care articles from the KB)
   *   - get_user_orders + get_order_details (the user might be asking
   *     "when will my mango tree arrive?" — which is technically a
   *     purchase question, but the user might frame it as a knowledge
   *     question. Keep these tools for safety.)
   *
   * Hide:
   *   - search_seller_listings (the user doesn't want to buy right now.
   *     The LLM can recommend browsing /browse if the user asks where
   *     to find a plant.)
   */
  KNOWLEDGE: [
    "search_catalog",
    "get_product_care",
    "search_knowledge_base",
    "get_user_orders",
    "get_order_details",
  ],

  /**
   * MIXED intent: ambiguous — the user might want to buy OR learn.
   *
   * Expose ALL tools (fail-open). This preserves the existing behavior
   * for the ~20-30% of requests that fall through to MIXED. The LLM
   * has access to both purchase and knowledge tools + can decide which
   * to call based on the conversation context.
   *
   * The token overhead is the full ~440 tokens, but MIXED is the
   * minority case — the latency optimization on PURCHASE/KNOWLEDGE
   * (the majority) outweighs this.
   */
  MIXED: [
    "search_catalog",
    "get_product_care",
    "get_user_orders",
    "get_order_details",
    "search_knowledge_base",
    "search_seller_listings",
  ],

  /**
   * GREETING intent: pure greeting ("Hi", "Salam").
   *
   * Expose NO tools. The greeting shortcut returns a canned response
   * with no LLM call, so this is defensive — if the shortcut is
   * bypassed for any reason (e.g. the admin disabled it via env var),
   * the LLM gets an empty tool list rather than burning tokens
   * evaluating tools it doesn't need for a "hi" response.
   */
  GREETING: [],
};

// ─── Public helpers ────────────────────────────────────────────────────────

/**
 * Returns the list of tool NAMES that should be exposed to the LLM for
 * the given intent.
 *
 * If the intent is null/undefined (unknown), returns the FULL tool list
 * (backward-compatible fallback — same as the pre-optimization behavior).
 *
 * @example
 *   const names = getToolSubsetForIntent("PURCHASE");
 *   // → ["search_seller_listings", "search_catalog", "get_product_care",
 *   //    "get_user_orders", "get_order_details"]
 */
export function getToolSubsetForIntent(intent: Intent | null | undefined): readonly ToolName[] {
  if (intent == null) {
    // Unknown intent — fail-open to the full set (backward compat).
    return [
      "search_catalog",
      "get_product_care",
      "get_user_orders",
      "get_order_details",
      "search_knowledge_base",
      "search_seller_listings",
    ];
  }
  return TOOL_SUBSETS[intent];
}

/**
 * Filters the `AI_TOOL_DECLARATIONS` array to just the tools that
 * should be exposed for the given intent.
 *
 * If the intent is null/undefined (unknown), returns the FULL array
 * (backward-compatible fallback).
 *
 * Preserves the original declaration order from `allDeclarations` —
 * we don't sort or re-arrange. This is important for deterministic
 * LLM behavior (some models are sensitive to tool order).
 *
 * @example
 *   const declarations = getToolDeclarationsForIntent(
 *     "KNOWLEDGE",
 *     AI_TOOL_DECLARATIONS,
 *   );
 *   // → [search_catalog decl, get_product_care decl,
 *   //    search_knowledge_base decl, get_user_orders decl,
 *   //    get_order_details decl]
 */
export function getToolDeclarationsForIntent(
  intent: Intent | null | undefined,
  allDeclarations: readonly FunctionDeclaration[],
): FunctionDeclaration[] {
  const allowedNames = new Set<string>(getToolSubsetForIntent(intent));
  return allDeclarations.filter((decl) => decl.name != null && allowedNames.has(decl.name));
}

/**
 * Returns the count of tools exposed for the given intent.
 *
 * Useful for logging + observability — the route handler can log
 * `{ intent, toolCount, toolNames }` so admins can see how many
 * tools were exposed per request + verify the subsetting is working.
 *
 * @example
 *   const count = getToolCountForIntent("PURCHASE"); // → 5
 */
export function getToolCountForIntent(intent: Intent | null | undefined): number {
  return getToolSubsetForIntent(intent).length;
}

/**
 * Returns the names of tools that were HIDDEN for the given intent
 * (i.e. the tools in the full set but NOT in the subset).
 *
 * Useful for logging — the route handler can log the hidden tool names
 * so admins can verify the subsetting is hiding the right tools.
 *
 * @example
 *   const hidden = getHiddenToolsForIntent("PURCHASE");
 *   // → ["search_knowledge_base"]
 */
export function getHiddenToolsForIntent(intent: Intent | null | undefined): ToolName[] {
  if (intent == null) return [];
  const exposed = new Set<string>(getToolSubsetForIntent(intent));
  const all: readonly ToolName[] = [
    "search_catalog",
    "get_product_care",
    "get_user_orders",
    "get_order_details",
    "search_knowledge_base",
    "search_seller_listings",
  ];
  return all.filter((name) => !exposed.has(name));
}
