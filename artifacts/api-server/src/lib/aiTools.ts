/**
 * Function-calling tools for the TreeBot assistant (v2.5).
 *
 * Gemini's function-calling API lets the AI decide WHEN to query the
 * database based on the user's intent — much more accurate than Naive RAG
 * (which dumps context into the prompt regardless of whether it's needed).
 *
 * How it works:
 *   1. We declare a list of available functions (with parameter schemas).
 *   2. Gemini receives the user's message + the tool declarations.
 *   3. If Gemini needs DB info, it responds with a `functionCall` instead
 *      of text — asking us to execute e.g. `search_catalog({ query: "mango" })`.
 *   4. We execute the function locally and send the result back to Gemini.
 *   5. Gemini generates the final text response using the function result.
 *
 * This multi-round loop runs inside streamGeminiChat (see gemini.ts).
 *
 * Tools exposed:
 *   - search_catalog(query, max_price?, sunlight?)
 *     Fuzzy product search with optional price/sunlight filters.
 *   - get_product_care(product_slug)
 *     Returns detailed care info (watering, sunlight, soil, etc.) for a
 *     specific product identified by its slug.
 *   - get_user_orders()
 *     Returns the signed-in user's 5 most recent orders. Anonymous users
 *     get a "not available" response that the AI can phrase politely.
 *   - get_order_details(order_number)
 *     Returns detailed status for a specific order. Only works for the
 *     signed-in user's own orders (privacy: can't query other users).
 *
 * Security:
 *   - get_user_orders and get_order_details check the userId — they only
 *     return data belonging to that user. An anonymous user cannot query
 *     orders at all.
 *   - search_catalog and get_product_care are public (same data as the
 *     public product pages).
 */
import { Type } from "@google/genai";
import type { FunctionDeclaration } from "@google/genai";
import { pool } from "@workspace/db";
import { checkToolRateLimit } from "./toolRateLimiter";
import { logger } from "./logger";
// v6.2 Part 12 (Backend Gap Fix #1 + #2): import the typed tool-name
// registry + Zod validators. validateToolArgs runs at the top of
// executeTool (catches hallucinated arg types/missing required fields
// from the LLM). validateToolResult runs at the bottom (catches
// implementation drift before it crosses the SSE boundary).
import { isToolName, type ToolName, validateToolArgs, validateToolResult } from "./aiToolSchemas";
// BUG-I1 fix: import the unified retrieval config so the search_knowledge_base
// tool uses the SAME minScore + content truncation as the auto-inject path
// (getTopKbEntriesForPrompt in kbSearch.ts). Previously the tool used a
// hardcoded minScore: 0.3 + returned full content (no truncation), causing
// the LLM to see two different views of the KB for the same query.
import { searchKnowledgeBase, UNIFIED_MIN_SCORE, UNIFIED_CONTENT_TRUNCATE_CHARS } from "./kbSearch";
// v6.1: seller-listing search. Searches ACTUAL purchasable listings (not
// just the variety catalog). Returns specific seller listings with seller
// name, location, variants, price, stock, rating. Used for purchase-intent
// queries ("I want to buy a mango sapling"). The new dual-citation format
// `[[listing:<id>|<display>]]` deep-links to SellerListingDetailPage.
import { searchSellerListings } from "./sellerListingSearch";

// ─── Tool declarations (sent to Gemini) ──────────────────────────────────────

/**
 * BUG-I4 fix: per-request tool execution context.
 *
 * The route handler builds this object from `kbContext.toneCreator` and
 * passes it into `executeTool` via a closure (so gemini.ts/groq.ts don't
 * need to know about tone — they just call `tools.execute(name, args,
 * userId)` and the closure adds the context).
 *
 * Tools that return KB entries (e.g. `search_knowledge_base`) read
 * `toneLockedCreatorName` from the context and surface it as
 * `tone_locked_creator` in the response envelope. The LLM uses this to
 * detect creator mismatches: when `results[].creator !== tone_locked_creator`,
 * it uses neutral tone for those citations (per the rule added to
 * `formatToneBlockForPrompt` in kbToneProfiles.ts).
 *
 * Null when no tone is active (no auto-injected KB entries, or the top
 * creator has no tone profile).
 *
 * v6.1 extension: `userCity` + `userDistrict` — the buyer's default
 * shipping address, used by the new `search_seller_listings` tool (Part 2
 * of this PR series) to sort results by distance. Sourced from the
 * `addresses` table (is_default = true) via the chat route's
 * `loadBuyerLocation` helper.
 *
 * Privacy: this is the user's own address — only their own city/district
 * is shared with the tool, not their street or phone. Anonymous users have
 * these fields as null — the search_seller_listings tool then sorts by
 * rating + price only (no distance sort).
 */
export interface ToolContext {
  /** The creator whose tone profile is locked into the system prompt's
   * {{tone}} block. Null when no tone is active. */
  toneLockedCreatorId?: number | null;
  toneLockedCreatorName?: string | null;
  /**
   * v6.1: The buyer's city (e.g. "Dhaka"). Null for anonymous users or
   * signed-in users with no default address. Used by search_seller_listings
   * for distance-aware sorting.
   */
  userCity?: string | null;
  /**
   * v6.1: The buyer's district (e.g. "Dhaka"). More granular than city —
   * Bangladesh has 64 districts. Used for distance calc against the
   * seller's district (sellersTable.district).
   */
  userDistrict?: string | null;
}

/**
 * Tools exposed to the AI provider (Gemini/Groq).
 *
 * `execute` is called by the streaming loop when the LLM emits a
 * `functionCall`. The result is sent back to the LLM as a
 * `functionResponse` so it can incorporate the data into its next
 * response.
 *
 * BUG-I4 fix: `execute` now accepts an optional `context?: ToolContext`
 * as the 4th parameter. Existing callers that don't pass it still work
 * (the context is undefined → `tone_locked_creator` is null in the
 * response envelope, and the LLM treats that as "no tone active").
 */
export interface ChatTools {
  declarations: FunctionDeclaration[];
  execute: (
    name: string,
    args: Record<string, unknown>,
    userId: string | null,
    context?: ToolContext,
  ) => Promise<unknown>;
}

/**
 * BUG-I4 fix: the tool declarations type used by gemini.ts/groq.ts.
 *
 * gemini.ts and groq.ts import this inline type (they don't import
 * `ChatTools` from aiRouter.ts because that would create a circular
 * dependency). Their `execute` signature accepts the same optional
 * `context` parameter.
 */
export type ToolExecutor = {
  declarations: FunctionDeclaration[];
  execute: ChatTools["execute"];
};

/**
 * Tools that return USER-SCOPED data (orders, account info).
 *
 * ─── Bug #4 fix: cache policy ─────────────────────────────────────────────────
 *
 * When ANY of these tools is called during a request, the response must
 * NEVER be cached — neither exact-match nor semantic. The data is specific
 * to the authenticated user (or their anonymous session) and caching it
 * would leak it to other users who ask a similar question.
 *
 * The route checks `toolCallsCalled ∩ USER_SCOPED_TOOLS` — if non-empty,
 * both cache writes are skipped AND the existing `isPrivateQuery` flag is
 * set to true (so the cache READ is also skipped, in case a previous
 * non-tool response was cached for the same message).
 *
 * The catalog tools (search_catalog, get_product_care) return PUBLIC data
 * that changes slowly (the product catalog). These CAN be cached — but
 * with a shorter TTL (5 min instead of 1 hour) because prices and
 * availability can change when sellers update their listings.
 */
export const USER_SCOPED_TOOLS: ReadonlySet<string> = new Set([
  "get_user_orders",
  "get_order_details",
]);

/**
 * Tools that return PUBLIC but TIME-SENSITIVE catalog data.
 *
 * Responses that called these tools CAN be cached (the data is public,
 * no privacy issue), but with a SHORT TTL (default 5 min, configurable
 * via AI_TOOL_CACHE_TTL_SECONDS). The short TTL balances freshness
 * (sellers update prices / availability) vs cost (avoid re-calling the
 * AI + the catalog search for every similar question).
 *
 * If the TTL is 0, tool-call responses are NOT cached at all (treated
 * the same as user-scoped tools). This is the safest setting — admins
 * who want maximum freshness can set AI_TOOL_CACHE_TTL_SECONDS=0.
 */
export const CATALOG_TOOLS: ReadonlySet<string> = new Set([
  "search_catalog",
  "get_product_care",
  // Phase 3: KB tool is catalog-like (public data, cacheable with short TTL).
  // KB entries are public content (vetted by admins) that changes slowly.
  // The 5-min TTL (default) is appropriate — if an admin edits an entry,
  // the cache expires within 5 min + the next query picks up the change.
  "search_knowledge_base",
  // v6.1: seller-listing search tool is also catalog-like (public data —
  // listings, variants, sellers are all visible on the public marketplace).
  // The 5-min TTL is appropriate because sellers can update prices/stock
  // at any time; we don't want to show stale prices for too long.
  "search_seller_listings",
]);

export const AI_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "search_catalog",
    description:
      "Search the TreeFriend product catalog for trees/plants matching a query. " +
      "Returns up to 8 results with name, slug, price range, sunlight needs, and a short description. " +
      "Use this when the user is looking for specific plants, asking what's available, or wants recommendations. " +
      "Optional filters: max_price (in BDT), sunlight requirement.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description:
            "Search keywords — plant name, scientific name, or description keywords. " +
            'e.g. "mango", "indoor", "shade loving", "Mangifera indica"',
        },
        max_price: {
          type: Type.NUMBER,
          description: "Optional maximum price in BDT (Bangladeshi Taka). e.g. 500",
        },
        sunlight: {
          type: Type.STRING,
          description: "Optional sunlight requirement filter.",
          enum: ["full_sun", "partial_shade", "full_shade"],
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_product_care",
    description:
      "Get detailed care information for a specific product, identified by its slug. " +
      "Returns sunlight, watering, soil type, mature height, climate zone, growth rate, " +
      "bloom season, key benefits, best for (indoor/balcony/garden), and care tips. " +
      "Use this AFTER search_catalog when the user asks about a specific product's care.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        product_slug: {
          type: Type.STRING,
          description: 'The product\'s slug (URL identifier). e.g. "alphonso-mango"',
        },
      },
      required: ["product_slug"],
    },
  },
  {
    name: "get_user_orders",
    description:
      "Get the signed-in user's 5 most recent orders with status, items, and dates. " +
      "Use this when the user asks 'where is my order', 'what did I buy', 'my orders', etc. " +
      "Only works for signed-in users — anonymous users get a 'not signed in' response.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "get_order_details",
    description:
      "Get detailed status for a specific order, identified by its order number. " +
      "Returns tracking ID, current status, payment status, items, delivery address (city/district only), " +
      "and per-status timestamps (confirmed, shipped, delivered). " +
      "Only works for the signed-in user's OWN orders.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        order_number: {
          type: Type.NUMBER,
          description: "The order number shown to the user (e.g. 1001, 1002). NOT the tracking ID.",
        },
      },
      required: ["order_number"],
    },
  },
  // ─── Phase 3: Knowledge Base search tool ────────────────────────────────────
  // The 5th tool. Searches the curated KB (vetted plant care content from
  // YouTube channels, blogs, manual uploads). The AI should use this as
  // its PRIMARY source for botanical questions — the content is more
  // accurate + up-to-date than the model's training data.
  //
  // The route also auto-injects the top 3 KB entries into the system
  // prompt (if they score above 0.5). The AI calls this tool on-demand
  // for: (a) questions not covered by the injected context, or (b) when
  // the user asks for more detail on a specific sub-topic.
  {
    name: "search_knowledge_base",
    description:
      "Search the TreeFriend Knowledge Base for curated plant care guides, " +
      "care tips, and expert advice. Returns the most " +
      "relevant entries with their content. " +
      "Use this as your PRIMARY source for botanical questions — the content is " +
      "vetted by admins and more accurate than your training data. " +
      "Present KB content as authoritative plant-care advice without attributing " +
      "it to any specific person or source.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description:
            "Search keywords — what the user is asking about. " +
            'e.g. "mango watering summer", "lotus seed planting", "pest control mango"',
        },
        category_slug: {
          type: Type.STRING,
          description:
            'Optional category slug to filter within. e.g. "plant-care", "pests-diseases"',
        },
        product_slug: {
          type: Type.STRING,
          description: "Optional product slug to filter entries linked to a specific product.",
        },
        max_results: {
          type: Type.NUMBER,
          description:
            "Maximum results to return (default 5, max 10). The system " +
            "prompt's auto-injected KB block also returns up to 5 entries — if an " +
            "entry appears in both, treat them as the same source (cite once).",
        },
      },
      required: ["query"],
    },
  },
  // ─── v6.1: Seller-listing search tool ──────────────────────────────────────
  // The 6th tool. Searches ACTUAL purchasable seller listings (not just
  // the variety catalog). Returns specific listings with seller name,
  // location, variants (form, height, price, stock), rating, delivery info.
  //
  // Use this tool when the user has PURCHASE intent — "I want to buy a
  // mango sapling", "where can I get a mango tree", "price of mango",
  // "in stock near Dhaka", etc.
  //
  // The AI should emit the new dual-citation format for each listing it
  // recommends:
  //   [[listing:42|Alphonso Mango — 3ft sapling, 450 BDT]]
  //
  // The frontend's parseMessage.ts + ListingChip.tsx extract these and
  // deep-link to /products/:productId/seller-listings/:listingId (one
  // click to the SellerListingDetailPage where the user can add to cart).
  //
  // For KNOWLEDGE-intent questions ("how to care for a mango tree"), use
  // the existing get_product_care + search_knowledge_base tools instead.
  {
    name: "search_seller_listings",
    description:
      "Search for SPECIFIC seller listings that the user can buy. " +
      "Returns actual purchasable items with seller name, location, variants " +
      "(form, height, price, stock), rating, and delivery info. " +
      "Use this when the user wants to BUY something (purchase intent) — " +
      '"I want to buy a mango sapling", "where can I get a mango tree", ' +
      '"price of mango sapling", "available near me", etc. ' +
      "For each listing you recommend, emit the citation format " +
      "[[listing:<id>|<display>]] — the frontend will deep-link to the listing detail page. " +
      "v6.1 Part 4: pass care_summary=true to ALSO fetch a 1-line KB care " +
      "summary in the same response (saves a separate search_knowledge_base call). " +
      "Use this for MIXED-intent queries where the user wants both care info AND " +
      "buyable listings (e.g. 'buy a mango sapling and how to care for it').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description:
            "Search keywords — plant name, variety, or what the user is looking for. " +
            'e.g. "mango sapling", "Alphonso mango", "indoor plant", "Mangifera indica"',
        },
        max_price: {
          type: Type.NUMBER,
          description:
            "Optional maximum price in BDT (Bangladeshi Taka). " +
            "e.g. 500 for listings under 500 BDT. Filters at the variant level — " +
            "only listings with at least one variant at or below this price are returned.",
        },
        form: {
          type: Type.STRING,
          description:
            "Optional form filter — restrict to listings that have at least " +
            "one variant of this form. Common values: 'sapling', 'seed', " +
            "'grafted', 'potted'. Use this when the user specifically asks for " +
            "a form (e.g. 'sapling' when they say 'mango sapling').",
        },
        limit: {
          type: Type.NUMBER,
          description:
            "Maximum listings to return (default 5, max 8). Each listing includes " +
            "up to 3 cheapest variants. Higher limits = more options but more tokens.",
        },
        care_summary: {
          type: Type.BOOLEAN,
          description:
            "v6.1 Part 4: when true, also fetch a 1-line KB care summary (max ~200 chars) " +
            "from the top knowledge-base entry + include it as 'careSummary' in the response. " +
            "Use this for MIXED-intent queries where the user wants both care info AND buyable listings. " +
            "The chat route auto-passes this for MIXED intent — you usually don't need to set it manually.",
        },
        sort_by: {
          type: Type.STRING,
          description:
            "v6.2 Part 16: ranking strategy for the results. Pick this based on the " +
            "user's STATED PREFERENCE — the model decides, not a keyword classifier. " +
            "Allowed values:\n" +
            "  - 'price_asc'    (default): cheapest first. Use when the user is " +
            "price-conscious ('cheapest', 'under ৳X', 'budget', 'affordable').\n" +
            "  - 'price_desc':   most expensive first. Use when the user said " +
            "'most expensive', 'highest price', 'top-end', 'premium price'.\n" +
            "  - 'maturity_desc': largest height variant first. Use when the user " +
            "signaled price-insensitivity + quality focus ('i dont care about " +
            "price', 'most mature', 'largest', 'biggest', 'oldest', 'best " +
            "quality', 'premium'). This is the canonical 'premium intent' branch.\n" +
            "  - 'rating_desc':  highest seller rating first. Use when the user " +
            "explicitly asked about seller quality ('highest rated', 'top rated',\n" +
            "    'best seller', 'most reviewed').\n" +
            "When in doubt or the user has no stated preference, OMIT this arg " +
            "(defaults to price_asc).\n" +
            "The chosen value is echoed back in the result envelope so the " +
            "frontend can render the matching summary card WITHOUT re-classifying\n" +
            "your intent — your sort_by choice is the single source of truth.",
        },
      },
      required: ["query"],
    },
  },
];

// ─── Tool executor ───────────────────────────────────────────────────────────

/**
 * Executes a tool call by name. Returns a JSON-serializable result object
 * that gets sent back to Gemini.
 *
 * v5.6: per-tool rate limiting is enforced BEFORE execution. Each tool
 * has its own limit tier:
 *   - SENSITIVE (get_user_orders, get_order_details): 10 calls/hour
 *     — private user data, very tight
 *   - CATALOG (search_catalog, get_product_care, search_knowledge_base):
 *     60 calls/hour — public data, moderate
 *
 * When a tool exceeds its limit, a friendly error is returned (not the
 * actual data) — the AI can relay this to the user.
 *
 * @param name - The function name (matches AI_TOOL_DECLARATIONS[].name)
 * @param args - The arguments object Gemini provided
 * @param userId - The signed-in user's Clerk ID (null for anonymous).
 *                Used by get_user_orders + get_order_details for privacy.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  userId: string | null,
  // BUG-I4 fix: per-request tool context. Carries the tone-locked creator
  // info so search_knowledge_base can surface `tone_locked_creator` in its
  // response envelope. Optional for back-compat with callers that don't
  // pass it (the response will have `tone_locked_creator: null`, which the
  // LLM treats as "no tone active").
  context?: ToolContext,
  // v6.2 Part 9 (Gap 17 fix — Phase B): optional progress callback.
  // Long-running tools (e.g. YouTube transcript fetch) can call this with
  // a human-readable progress string ("Fetching transcript…", "50% done",
  // etc.) to give the user live feedback during execution. The callback
  // is wired through to the SSE pipe by the route handler.
  //
  // Backward compatible: existing tools don't accept this param + don't
  // call it. The fallback "Loading…" label renders in the frontend.
  //
  // v6.2 Part 12: prefixed with `_` because no current tool implementation
  // calls it yet (all 6 tools are SQL-based + complete in <100ms). The
  // parameter is a public API placeholder for future slow tools (YouTube
  // transcript fetch, multi-step pipelines) — the route handler still
  // passes it through. ESLint's `args: "after-used"` rule ignores args
  // after the last used one, but `onProgress` is the LAST param, so we
  // need the `_` prefix to mark it as intentionally unused. When a future
  // tool starts calling it, drop the `_` prefix.
  _onProgress?: (progress: string) => void,
): Promise<unknown> {
  // v6.2 Part 12 (Backend Gap Fix #2): narrow `name` via isToolName before
  // any dispatch. Unknown names (LLM hallucination, future tools) are
  // caught here + return a friendly error. The downstream code can assume
  // `name` is a known ToolName — typed-map lookups can't silently miss.
  if (!isToolName(name)) {
    logger.warn({ name }, "AI tool: unknown function called (not in TOOL_NAMES)");
    return { error: `Unknown function: ${name}` };
  }
  const toolName: ToolName = name;

  // v5.6: per-tool rate limit check (before execution)
  // The IP is not available in this context (executeTool is called from
  // the streaming generator, not an Express middleware). We use userId
  // as the primary key, falling back to "anon" for anonymous users.
  // This is slightly less precise than IP-based limiting (multiple
  // anonymous users behind one NAT share the "anon" key), but it's
  // the best we can do without threading the request IP through the
  // streaming pipeline. The global chat rate limiter (30 req/hour/IP)
  // already provides IP-level protection.
  const identity = userId ?? "anon";
  const rateLimit = await checkToolRateLimit(toolName, userId, identity);
  if (!rateLimit.allowed) {
    logger.warn(
      { name: toolName, tier: rateLimit.tier, limit: rateLimit.limit },
      "AI tool: rate limited — returning friendly error",
    );
    return {
      error:
        `This action (${toolName}) has been called too many times. ` +
        `Please try again in ${Math.ceil(rateLimit.retryAfterSeconds / 60)} minutes. ` +
        `Limit: ${rateLimit.limit} calls per hour.`,
      rateLimited: true,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    };
  }

  try {
    let result: unknown;

    // v6.2 Part 12 (Backend Gap Fix #1, input): per-case arg validation.
    //
    // Each branch calls `validateToolArgs` with a LITERAL tool name (e.g.
    // "search_catalog") — TypeScript infers the specific Zod schema's
    // output type, so the validated args have known field types (no
    // `unknown` everywhere). On failure, a friendly error is returned
    // to the LLM (it can retry with corrected args).
    //
    // This replaces the ad-hoc `typeof args.query === "string"` checks
    // that were scattered through each tool implementation. The
    // implementations now receive a typed, validated args object.
    switch (toolName) {
      case "search_catalog": {
        const v = validateToolArgs("search_catalog", args);
        if (!v.success) {
          logger.info(
            { validationError: v.error, rawArgs: args },
            "AI tool: args failed validation",
          );
          return { error: v.error };
        }
        result = await searchCatalog(v.args);
        break;
      }
      case "get_product_care": {
        const v = validateToolArgs("get_product_care", args);
        if (!v.success) {
          logger.info(
            { validationError: v.error, rawArgs: args },
            "AI tool: args failed validation",
          );
          return { error: v.error };
        }
        result = await getProductCare(v.args);
        break;
      }
      case "get_user_orders": {
        // No args needed — but validate anyway for symmetry (the schema
        // accepts an empty object, which is the common case).
        const v = validateToolArgs("get_user_orders", args);
        if (!v.success) {
          logger.info(
            { validationError: v.error, rawArgs: args },
            "AI tool: args failed validation",
          );
          return { error: v.error };
        }
        result = await getUserOrders(userId);
        break;
      }
      case "get_order_details": {
        const v = validateToolArgs("get_order_details", args);
        if (!v.success) {
          logger.info(
            { validationError: v.error, rawArgs: args },
            "AI tool: args failed validation",
          );
          return { error: v.error };
        }
        result = await getOrderDetails(v.args, userId);
        break;
      }
      case "search_knowledge_base": {
        // BUG-I4 fix: pass the tool context so searchKb can include
        // `tone_locked_creator` in the response envelope.
        const v = validateToolArgs("search_knowledge_base", args);
        if (!v.success) {
          logger.info(
            { validationError: v.error, rawArgs: args },
            "AI tool: args failed validation",
          );
          return { error: v.error };
        }
        result = await searchKb(v.args, userId, context);
        break;
      }
      case "search_seller_listings": {
        // v6.1: pass the buyer's location (from their default address) so
        // the search can sort by distance. Null for anonymous users → no
        // distance sort (just rating + price). See loadBuyerLocation in
        // routes/ai.ts for the privacy rationale.
        // v6.1 Part 4: pass careSummary if the LLM requested it (or if the
        // chat route auto-passes it for MIXED intent — see routes/ai.ts).
        // v6.2 Part 16: pass sort_by if the LLM picked one. Undefined falls
        // through to the legacy price_asc default inside searchSellerListings.
        // The LLM chooses this value based on the user's stated preference
        // (e.g. "i dont care about price" → maturity_desc, "best quality" →
        // rating_desc). The choice is ECHOED BACK in the result envelope
        // (searchSellerListings returns sortBy) so the frontend FactCallout
        // can render the matching summary without re-classifying intent.
        const v = validateToolArgs("search_seller_listings", args);
        if (!v.success) {
          logger.info(
            { validationError: v.error, rawArgs: args },
            "AI tool: args failed validation",
          );
          return { error: v.error };
        }
        // Zod's inferred type for this schema is { query: string; max_price?: number;
        // form?: string; limit?: number; care_summary?: boolean;
        // sort_by?: 'price_asc' | 'price_desc' | 'maturity_desc' | 'rating_desc' }
        // — assignable to SellerListingSearchParams (structurally compatible).
        // The context fields (userCity, userDistrict) come from the request
        // context, not args.
        result = await searchSellerListings({
          query: v.args.query,
          max_price: v.args.max_price,
          form: v.args.form,
          limit: v.args.limit,
          userCity: context?.userCity ?? null,
          userDistrict: context?.userDistrict ?? null,
          careSummary: v.args.care_summary === true,
          sortBy: v.args.sort_by,
        });
        break;
      }
      default:
        // Unreachable — isToolName guard above already returned for
        // unknown names. TypeScript's exhaustiveness check on the union
        // ensures this branch exists only for compile-time safety.
        logger.warn({ name: toolName }, "AI tool: unknown function called (unreachable)");
        return { error: `Unknown function: ${toolName}` };
    }

    // v6.2 Part 12 (Backend Gap Fix #1, output): validate the tool's
    // return value BEFORE returning to the caller (the SSE pipe). Catches
    // implementation drift (a SQL column renamed, a refactor forgetting
    // to update one field) at the source — the frontend never sees
    // malformed data + the React render phase stays clean.
    //
    // On failure: logs the validation error + returns a friendly error
    // envelope. The LLM gets a clear "tool failed" message + can retry
    // or answer without the data.
    return validateToolResult(toolName, result);
  } catch (err) {
    logger.error({ err, name: toolName, args }, "AI tool: execution failed");
    return { error: "Tool execution failed. Try answering without this data." };
  }
}

// ─── Tool implementations ────────────────────────────────────────────────────

interface CatalogResult {
  slug: string;
  name: string;
  scientific_name: string | null;
  description: string | null;
  sunlight: string | null;
  watering: string | null;
  mature_height: string | null;
  product_status: string | null;
  min_price: number | null;
  image: string | null;
}

async function searchCatalog(args: Record<string, unknown>): Promise<{
  results: CatalogResult[];
  count: number;
}> {
  const query = String(args.query ?? "").trim();
  if (!query) return { results: [], count: 0 };

  const maxPrice = typeof args.max_price === "number" ? args.max_price : null;
  const sunlight = typeof args.sunlight === "string" ? args.sunlight : null;

  // Active-listing filter — must match the canonical buyer-facing gate used
  // in routes/sellerListings.ts (visibility = 'public' AND approval_status =
  // 'approved'). The seller_listings table has NO `is_active` column —
  // previous revisions of this SQL referenced `sl.is_active` which caused
  // PostgreSQL error 42703 ("column sl.is_active does not exist") on every
  // search_catalog tool call, breaking the AI assistant's product search.
  //
  // v6.1 fix: the seller_listings table also has NO `deleted_at` column
  // (soft-delete is not implemented at the listing level — listings use
  // visibility = 'hidden' + approval_status = 'rejected' instead). The
  // previous `AND sl.deleted_at IS NULL` clause caused PostgreSQL error
  // 42703 on every search_catalog call, silently breaking AI product
  // search. The outer try/catch in executeTool swallowed the error and
  // returned { error: "Tool execution failed" } to the LLM, which fell
  // back to the variety-level CATALOG CONTEXT injected by
  // buildCatalogContext() — meaning the AI never had access to per-seller
  // pricing for any product, ever.
  //
  // The fix is to drop the `deleted_at` clause. If we ever add soft-delete
  // to seller_listings (a deliberate schema change), re-add it here AND in
  // the products-by-slug route (routes/ai.ts) AND in
  // routes/products.ts:fetchSellerListingCardsFor — all three sites that
  // join seller_listings must stay in sync.
  const ACTIVE_LISTING_FILTER = "sl.visibility = 'public' AND sl.approval_status = 'approved'";

  // The price subquery joins seller_listings → seller_listing_variants to
  // find the lowest variant price per product. Only listings that pass the
  // active-listing filter contribute prices (so the AI never quotes a price
  // from a hidden or rejected listing).
  const priceJoin = `LEFT JOIN (SELECT product_id, MIN(price) AS min_price FROM seller_listings sl JOIN seller_listing_variants slv ON slv.seller_listing_id = sl.id WHERE ${ACTIVE_LISTING_FILTER} GROUP BY product_id) AS prices ON prices.product_id = p.id`;

  // v3.10: Industry-standard hybrid search — tsvector (stemming) PRIMARY,
  // trigram (typo tolerance) FALLBACK, ILIKE (substring) for compound names.
  //
  // Same pattern as aiContext.ts:searchProducts() — see that function for
  // the full rationale. Short version:
  //   - tsvector catches "watering" → "water" (stemming)
  //   - trigram catches "mangoo" → "mango" (typo tolerance)
  //   - ILIKE catches "mango_tree_seedling" (compound/underscored)
  // Combined via OR; ranked by ts_rank_cd (×1000) + CASE + similarity boosts.
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 5);

  if (tokens.length === 0) return { results: [], count: 0 };

  // Build ILIKE conditions. Each token placeholder is reused across the
  // three columns (same substring).
  const params: unknown[] = [];
  const tokenPlaceholders: string[] = [];
  for (const t of tokens) {
    params.push(`%${t}%`);
    tokenPlaceholders.push(`$${params.length}`);
  }
  const ilikeWhere = tokenPlaceholders
    .map((p) => `(p.name ILIKE ${p} OR p.scientific_name ILIKE ${p} OR p.description ILIKE ${p})`)
    .join(" OR ");

  // v3.7: Per-token trigram similarity via GREATEST(). Push each token as
  // a separate param (raw token, NOT %wrapped%).
  const trigramThreshold = Number(process.env.AI_TRIGRAM_THRESHOLD ?? 0.3);
  const trigramParamPlaceholders: string[] = [];
  for (const t of tokens) {
    params.push(t);
    trigramParamPlaceholders.push(`$${params.length}`);
  }
  params.push(trigramThreshold);
  const trigramThresholdParam = `$${params.length}`;

  const greatestSim = (col: string): string =>
    `GREATEST(${trigramParamPlaceholders.map((p) => `similarity(${col}, ${p})`).join(", ")})`;

  const trigramWhere = `(${greatestSim("p.name")} > ${trigramThresholdParam}
     OR ${greatestSim("COALESCE(p.scientific_name, '')")} > ${trigramThresholdParam}
     OR ${greatestSim("COALESCE(p.description, '')")} > ${trigramThresholdParam})`;

  // v3.10: tsvector full-text search (PRIMARY path).
  const tsQuery = tokens.join(" ");
  params.push(tsQuery);
  const tsQueryParam = `$${params.length}`;
  const tsvectorWhere = `(p.search_tsvector @@ websearch_to_tsquery('english', ${tsQueryParam}))`;

  // Combine tsvector + ILIKE + trigram into the final WHERE.
  let where = `(${tsvectorWhere} OR ${ilikeWhere} OR ${trigramWhere})`;

  if (sunlight) {
    params.push(sunlight);
    where += ` AND p.sunlight = $${params.length}`;
  }

  // Always join to prices so we can return min_price in the result (useful
  // for the AI to mention a price range even when the user didn't filter on it).
  // We only filter on it when maxPrice is provided. The priceJoin itself is
  // declared at the top of searchCatalog (it gates on the active-listing filter).

  let priceWhere = "";
  if (maxPrice != null) {
    params.push(maxPrice);
    priceWhere = ` AND (prices.min_price IS NULL OR prices.min_price <= $${params.length})`;
  }

  // v3.10: ts_rank_cd (×1000) dominates; CASE (100/80/60) + similarity
  // boosts (max ~50) act as tie-breakers for non-tsvector matches.
  const firstTokenParam = tokenPlaceholders[0];
  const scoreExpr = `(
    ts_rank_cd(p.search_tsvector, websearch_to_tsquery('english', ${tsQueryParam})) * 1000
    + CASE WHEN p.name ILIKE ${firstTokenParam} THEN 100
         WHEN p.scientific_name ILIKE ${firstTokenParam} THEN 80
         WHEN p.description ILIKE ${firstTokenParam} THEN 60
         ELSE 0 END
    + ${greatestSim("p.name")} * 30
    + ${greatestSim("COALESCE(p.scientific_name, '')")} * 15
    + ${greatestSim("COALESCE(p.description, '')")} * 5
  )`;

  try {
    const result = await pool.query<CatalogResult>(
      `SELECT
         p.slug,
         p.name,
         p.scientific_name,
         p.description,
         p.sunlight,
         p.watering,
         p.mature_height,
         p.product_status,
         prices.min_price,
         (p.images::jsonb->0->>'url') AS image
       FROM products p
       ${priceJoin}
       WHERE p.deleted_at IS NULL AND ${where}${priceWhere}
       ORDER BY ${scoreExpr} DESC, p.created_at DESC
       LIMIT 8`,
      params,
    );

    return {
      results: result.rows.map((r) => ({
        ...r,
        description: r.description ? r.description.slice(0, 150) : null,
      })),
      count: result.rows.length,
    };
  } catch (err) {
    // tsvector column missing OR pg_trgm unavailable — fall back to
    // ILIKE + trigram (drop the tsvector clause). Non-fatal.
    logger.debug(
      { err: (err as any)?.message ?? String(err), query },
      "AI tool search_catalog: tsvector search unavailable, falling back to ILIKE + trigram",
    );

    // Rebuild WHERE without tsvector (keep ILIKE + trigram).
    // Params layout: [ilike params..., trigram params..., trigramThreshold,
    //                  tsQuery, (optional) sunlight, (optional) maxPrice]
    // We need to drop tsQuery (the last-but-optional param before sunlight/maxPrice).
    // Simplest: rebuild params from scratch for the fallback.
    const fbParams: unknown[] = [];
    const fbTokenPlaceholders: string[] = [];
    for (const t of tokens) {
      fbParams.push(`%${t}%`);
      fbTokenPlaceholders.push(`$${fbParams.length}`);
    }
    const fbTrigramParamPlaceholders: string[] = [];
    for (const t of tokens) {
      fbParams.push(t);
      fbTrigramParamPlaceholders.push(`$${fbParams.length}`);
    }
    fbParams.push(trigramThreshold);
    const fbTrigramThresholdParam = `$${fbParams.length}`;

    const fbGreatestSim = (col: string): string =>
      `GREATEST(${fbTrigramParamPlaceholders.map((p) => `similarity(${col}, ${p})`).join(", ")})`;

    const fbTrigramWhere = `(${fbGreatestSim("p.name")} > ${fbTrigramThresholdParam}
       OR ${fbGreatestSim("COALESCE(p.scientific_name, '')")} > ${fbTrigramThresholdParam}
       OR ${fbGreatestSim("COALESCE(p.description, '')")} > ${fbTrigramThresholdParam})`;

    let fbWhere = tokenPlaceholders
      .map((p) => `(p.name ILIKE ${p} OR p.scientific_name ILIKE ${p} OR p.description ILIKE ${p})`)
      .join(" OR ");
    fbWhere = `(${fbWhere} OR ${fbTrigramWhere})`;

    if (sunlight) {
      fbParams.push(sunlight);
      fbWhere += ` AND p.sunlight = $${fbParams.length}`;
    }
    let fbPriceWhere = "";
    if (maxPrice != null) {
      fbParams.push(maxPrice);
      fbPriceWhere = ` AND (prices.min_price IS NULL OR prices.min_price <= $${fbParams.length})`;
    }

    try {
      const result = await pool.query<CatalogResult>(
        `SELECT
           p.slug,
           p.name,
           p.scientific_name,
           p.description,
           p.sunlight,
           p.watering,
           p.mature_height,
           p.product_status,
           prices.min_price,
           (p.images::jsonb->0->>'url') AS image
         FROM products p
         ${priceJoin}
         WHERE p.deleted_at IS NULL AND ${fbWhere}${fbPriceWhere}
         ORDER BY
           CASE WHEN p.name ILIKE ${fbTokenPlaceholders[0]} THEN 100
                WHEN p.scientific_name ILIKE ${fbTokenPlaceholders[0]} THEN 80
                WHEN p.description ILIKE ${fbTokenPlaceholders[0]} THEN 60
                ELSE 0 END,
           p.created_at DESC
         LIMIT 8`,
        fbParams,
      );

      return {
        results: result.rows.map((r) => ({
          ...r,
          description: r.description ? r.description.slice(0, 150) : null,
        })),
        count: result.rows.length,
      };
    } catch {
      // Final fallback: pure ILIKE (no trigram, no tsvector).
      const ilikeParams = fbParams.slice(0, fbTokenPlaceholders.length);
      if (sunlight) {
        ilikeParams.push(sunlight);
      }
      if (maxPrice != null) {
        ilikeParams.push(maxPrice as number);
      }
      let ilikeOnlyWhere = fbTokenPlaceholders
        .map(
          (p) => `(p.name ILIKE ${p} OR p.scientific_name ILIKE ${p} OR p.description ILIKE ${p})`,
        )
        .join(" OR ");
      if (sunlight) {
        ilikeOnlyWhere += ` AND p.sunlight = $${fbTokenPlaceholders.length + 1}`;
      }
      let ilikePriceWhere = "";
      if (maxPrice != null) {
        const idx = fbTokenPlaceholders.length + (sunlight ? 1 : 0) + 1;
        ilikePriceWhere = ` AND (prices.min_price IS NULL OR prices.min_price <= $${idx})`;
      }

      const result = await pool.query<CatalogResult>(
        `SELECT
           p.slug,
           p.name,
           p.scientific_name,
           p.description,
           p.sunlight,
           p.watering,
           p.mature_height,
           p.product_status,
           prices.min_price,
           (p.images::jsonb->0->>'url') AS image
         FROM products p
         ${priceJoin}
         WHERE p.deleted_at IS NULL AND (${ilikeOnlyWhere})${ilikePriceWhere}
         ORDER BY
           CASE WHEN p.name ILIKE ${fbTokenPlaceholders[0]} THEN 0 ELSE 1 END,
           p.created_at DESC
         LIMIT 8`,
        ilikeParams,
      );

      return {
        results: result.rows.map((r) => ({
          ...r,
          description: r.description ? r.description.slice(0, 150) : null,
        })),
        count: result.rows.length,
      };
    }
  }
}

async function getProductCare(args: Record<string, unknown>): Promise<{
  product: unknown | null;
  error?: string;
}> {
  const slug = String(args.product_slug ?? "").trim();
  if (!slug) return { product: null };

  const result = await pool.query(
    `SELECT
       name, slug, scientific_name, description,
       sunlight, watering, soil_type, mature_height, climate_zone,
       growth_rate, bloom_season,
       key_benefits, best_for, care_tips,
       images, product_status
     FROM products
     WHERE slug = $1 AND deleted_at IS NULL`,
    [slug],
  );

  if (result.rows.length === 0) {
    return { product: null, error: "Product not found." };
  }
  return { product: result.rows[0] };
}

async function getUserOrders(userId: string | null): Promise<{
  signed_in: boolean;
  orders: unknown[];
  message?: string;
}> {
  if (!userId) {
    return {
      signed_in: false,
      orders: [],
      message: "User is not signed in. Ask them to sign in to view their orders.",
    };
  }

  // Filter `order_number IS NOT NULL` because the `orders.order_number`
  // column is nullable in the schema (lib/db/src/schema/orders.ts:98) — the
  // SEQUENCE-based assignment is correct in the checkout path
  // (routes/orders.ts:367, 960 both call nextval('order_number_seq')) but
  // legacy rows / rows from other insert paths (test fixtures, manual SQL,
  // a since-fixed bug in an older deployment) can have NULL. Without this
  // filter, validateToolResult on the backend rejects the row (Zod schema
  // requires order_number: z.number()) → the chat tool fails with
  // "Tool returned malformed data" → user sees the misleading error card.
  // Filter is a defensive guard; backfill NULL rows with nextval() in the
  // DB to make the filter a no-op.
  const result = await pool.query(
    `SELECT
       order_number,
       tracking_id,
       order_status,
       payment_status,
       total_amount::text,
       created_at,
       delivered_at,
       items,
       (shipping_address->>'city')::text AS city,
       (shipping_address->>'district')::text AS district
     FROM orders
     WHERE user_id = $1 AND order_number IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 5`,
    [userId],
  );

  return {
    signed_in: true,
    orders: result.rows.map((r) => ({
      order_number: r.order_number,
      tracking_id: r.tracking_id,
      status: r.order_status,
      payment_status: r.payment_status,
      total: r.total_amount,
      date:
        r.created_at instanceof Date
          ? r.created_at.toISOString().slice(0, 10)
          : String(r.created_at).slice(0, 10),
      delivered: r.delivered_at instanceof Date ? r.delivered_at.toISOString().slice(0, 10) : null,
      items: (r.items as { productName: string; quantity: number }[])?.map(
        (i) => `${i.quantity}× ${i.productName}`,
      ),
      location: [r.city, r.district].filter(Boolean).join(", ") || null,
    })),
  };
}

async function getOrderDetails(
  args: Record<string, unknown>,
  userId: string | null,
): Promise<{ order: unknown | null; error?: string; signed_in?: boolean; message?: string }> {
  const orderNumber = Number(args.order_number);
  if (!Number.isFinite(orderNumber)) {
    return { order: null, error: "Invalid order number." };
  }
  if (!userId) {
    return {
      order: null,
      signed_in: false,
      message: "User is not signed in. Ask them to sign in to view order details.",
    };
  }

  const result = await pool.query(
    `SELECT
       order_number,
       tracking_id,
       order_status,
       payment_status,
       total_amount::text,
       payment_method,
       created_at,
       confirmed_at,
       shipped_at,
       delivered_at,
       cancelled_at,
       items,
       (shipping_address->>'city')::text AS city,
       (shipping_address->>'district')::text AS district
     FROM orders
     WHERE user_id = $1 AND order_number = $2`,
    [userId, orderNumber],
  );

  if (result.rows.length === 0) {
    return {
      order: null,
      error: `Order #${orderNumber} not found in your account. Check the order number and try again.`,
    };
  }

  const r = result.rows[0];
  return {
    order: {
      order_number: r.order_number,
      tracking_id: r.tracking_id,
      status: r.order_status,
      payment_status: r.payment_status,
      payment_method: r.payment_method,
      total: r.total_amount,
      placed_at:
        r.created_at instanceof Date
          ? r.created_at.toISOString().slice(0, 10)
          : String(r.created_at).slice(0, 10),
      confirmed_at:
        r.confirmed_at instanceof Date ? r.confirmed_at.toISOString().slice(0, 10) : null,
      shipped_at: r.shipped_at instanceof Date ? r.shipped_at.toISOString().slice(0, 10) : null,
      delivered_at:
        r.delivered_at instanceof Date ? r.delivered_at.toISOString().slice(0, 10) : null,
      cancelled_at:
        r.cancelled_at instanceof Date ? r.cancelled_at.toISOString().slice(0, 10) : null,
      items: (r.items as { productName: string; quantity: number; price: number }[])?.map((i) => ({
        name: i.productName,
        qty: i.quantity,
        price: i.price,
      })),
      location: [r.city, r.district].filter(Boolean).join(", ") || null,
    },
  };
}

// ─── Phase 3: search_knowledge_base tool implementation ──────────────────────

/**
 * Executes the `search_knowledge_base` tool call from the AI.
 *
 * Resolves the optional `category_slug` to a categoryId (single slug, not
 * a path — Phase 3 supports one level; a future enhancement could parse
 * "plant-care/mango" as a path). Then calls `searchKnowledgeBase` with
 * the query + filters.
 *
 * Returns `{ results, count }` where each result has:
 *   - title, content, keywords, category, product, creator, source
 *   - relevance_score (0-1, rounded to 2 decimals)
 *
 * The AI uses this to answer the user's question with KB content + cite
 * the creator. The route logs that the tool was called (kb_search_performed
 * = TRUE on the assistant message).
 *
 * @internal — called by executeTool, not exported.
 */
async function searchKb(
  args: Record<string, unknown>,
  _userId: string | null,
  // BUG-I4 fix: carries the tone-locked creator info. Privacy: the
  // creator name is NOT surfaced in the response — it's used internally
  // for tone matching only. Kept for backward-compat with callers that
  // pass the context via the executeTool closure.
  _context?: ToolContext,
): Promise<{
  results: {
    title: string;
    content: string;
    keywords: string[];
    category: string | null;
    product: string | null;
    source: { type: string; title: string; url: string | null } | null;
    relevance_score: number;
  }[];
  count: number;
  message?: string;
}> {
  const query = String(args.query ?? "").trim();
  if (!query) {
    return {
      results: [],
      count: 0,
      message: "Query is required.",
    };
  }

  const categorySlug = typeof args.category_slug === "string" ? args.category_slug : null;
  const productSlug = typeof args.product_slug === "string" ? args.product_slug : null;
  const maxResults = Math.min(Number(args.max_results ?? 5) || 5, 10);

  // Resolve category_slug to categoryId.
  // Phase 3 supports a single slug (the last segment of a path like
  // "plant-care/mango" — we take "mango"). A future enhancement could
  // resolve the full path via the materialized path column.
  let categoryId: number | undefined;
  if (categorySlug) {
    const slug = categorySlug.split("/").pop() ?? categorySlug;
    try {
      const result = await pool.query<{ id: number }>(
        "SELECT id FROM ai_kb_categories WHERE slug = $1 AND is_active = TRUE LIMIT 1",
        [slug],
      );
      if (result.rows.length > 0) {
        categoryId = result.rows[0].id;
      }
    } catch (err) {
      logger.warn({ err, slug }, "search_knowledge_base: category lookup failed (ignoring filter)");
    }
  }

  const results = await searchKnowledgeBase({
    query,
    categoryId,
    productSlug: productSlug ?? undefined,
    maxResults,
    // BUG-I1 fix: use the unified minScore (0.3) — same as the auto-inject
    // path (getTopKbEntriesForPrompt). Previously this was a hardcoded
    // `0.3` literal, but the auto-inject path used 0.5, causing the LLM to
    // see two different views of the KB. Now both paths use UNIFIED_MIN_SCORE.
    minScore: UNIFIED_MIN_SCORE,
    // skipRerank defaults to false (same as auto-inject path now).
  });

  return {
    results: results.map((r) => ({
      title: r.entry.title,
      // BUG-I1 fix: truncate content to UNIFIED_CONTENT_TRUNCATE_CHARS (500)
      // to match the auto-inject path. Previously the tool returned FULL
      // content (up to 50K chars per entry), causing token bloat and giving
      // the LLM two different views of the same entry (truncated in the
      // system prompt, full in the tool result).
      content:
        r.entry.content.length > UNIFIED_CONTENT_TRUNCATE_CHARS
          ? r.entry.content.slice(0, UNIFIED_CONTENT_TRUNCATE_CHARS) + "…"
          : r.entry.content,
      keywords: r.entry.keywords,
      category: r.category?.name ?? null,
      product: r.entry.productId ? `product_id:${r.entry.productId}` : null,
      // Privacy: creator name is NOT included in the tool result.
      // The LLM should present KB content as authoritative advice
      // without attributing it to specific creators.
      source: r.source
        ? {
            type: r.source.type,
            title: r.source.title,
            url: r.source.url,
          }
        : null,
      relevance_score: Math.round(r.score * 100) / 100,
    })),
    count: results.length,
  };
}
