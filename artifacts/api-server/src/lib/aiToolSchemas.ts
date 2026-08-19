/**
 * aiToolSchemas.ts — Zod schemas + typed tool-name registry for the AI tool layer.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 *
 * Before this file:
 *
 *   1. Tool names were raw strings throughout the backend. `executeTool`
 *      had `name: string` + a `switch (name)`. A typo in any consumer
 *      (route handler, rate limiter, cache key) was silently missed.
 *      `USER_SCOPED_TOOLS` and `CATALOG_TOOLS` were `Set<string>` —
 *      adding a new tool to the switch without adding it to either set
 *      was a runtime-only failure (the rate-limit tier was wrong).
 *
 *   2. Tool-call ARGS (LLM-generated, untrusted) were validated with
 *      ad-hoc `typeof args.query === "string"` checks scattered through
 *      each tool implementation. The LLM could pass `max_price: "500"`
 *      (string instead of number) and the code silently coerced it via
 *      `String(args.query ?? "")`. There was no single place to see
 *      "what args does each tool accept?"
 *
 *   3. Tool RETURN shapes were documented in JSDoc comments but not
 *      enforced. The frontend had its own Zod schemas (mirroring these
 *      comments) — if the backend drifted (a column renamed, a field
 *      added/removed), the frontend's safeParse caught it at runtime
 *      but the backend had no idea it was emitting malformed data.
 *
 * This file fixes all three by providing:
 *
 *   A. `TOOL_NAMES` + `ToolName` — typed registry, same as the frontend's
 *      `toolNames.ts`. Both files MUST stay in sync (cross-referenced
 *      in their respective comments).
 *
 *   B. Input arg schemas — one Zod schema per tool, validated in
 *      `executeTool` BEFORE dispatching. Failed validation returns a
 *      friendly error to the LLM (it can retry with corrected args).
 *
 *   C. Output result schemas — mirror the frontend's `schemas.ts`.
 *      Validated in `executeTool` BEFORE returning (defense in depth —
 *      catches a tool implementation that emits the wrong shape before
 *      it crosses the SSE boundary).
 *
 * ─── Industry context ─────────────────────────────────────────────────────
 *
 * This is the standard Vercel AI SDK + Inference + Zod pattern for tool
 * definitions (also used by LangChain.js StructuredTool, Anthropic's
 * tool-use `input_schema`, OpenAI's `strict: true` function-calling).
 *
 * The principle: tool args + results cross a trust boundary at the
 * `executeTool` edge. Validate them there. The LLM is not adversarial
 * but it is unreliable — it can hallucinate arg types, send extra fields,
 * or omit required ones. Zod catches these deterministically.
 *
 * ─── Frontend mirror ────────────────────────────────────────────────────────
 *
 * Cross-reference: artifacts/tree-friend/src/components/ai/tool-ui/
 *   - toolNames.ts — same TOOL_NAMES + ToolName type (kept in sync manually
 *     — if a future refactor extracts these to a shared workspace package,
 *     this comment will be updated).
 *   - schemas.ts — same output schemas (OrderResult, OrdersResult, etc.).
 *
 * The frontend's schemas are the CONSUMER-side mirror — they validate the
 * SSE wire data before rendering. The backend's schemas here are the
 * PRODUCER-side validators — they ensure the data is well-formed BEFORE
 * it's serialized. Together they form a closed loop: malformed data can't
 * leave the backend AND can't reach the React render phase.
 *
 * If you change a tool's return shape:
 *   1. Update the output schema in this file.
 *   2. Update the implementation in aiTools.ts to emit the new shape.
 *   3. Update the frontend's schemas.ts to match.
 *   4. Run `pnpm typecheck` in both packages — type errors guide you to
 *      any consumer (cards, parsers) that referenced the old shape.
 */
import { z } from "zod";
import { logger } from "./logger";

// ─── Fix #2 (backend): Typed tool-name registry ────────────────────────────

/**
 * Every tool name the backend's `executeTool` switch can dispatch.
 *
 * `as const` is essential — without it, TS widens the element type to
 * `string` and `ToolName` becomes `string` (useless). `as const` keeps
 * each element as its literal string type, so `typeof TOOL_NAMES[number]`
 * is the union of those literals.
 *
 * KEEP IN SYNC with: artifacts/tree-friend/src/components/ai/tool-ui/toolNames.ts
 * (the frontend mirror). When you add/remove/rename a tool here, do the
 * same there — both files reference each other in comments.
 *
 * Order matches the order in `aiTools.ts`'s `executeTool` switch + the
 * `AI_TOOL_DECLARATIONS` array — keep them aligned for easy diffing.
 */
export const TOOL_NAMES = [
  "search_catalog",
  "get_product_care",
  "get_user_orders",
  "get_order_details",
  "search_knowledge_base",
  "search_seller_listings",
] as const;

/**
 * The string-literal union of all backend tool names.
 *
 * Use this anywhere a tool name is stored, passed, or looked up —
 * instead of `string`. The compiler will reject typos and out-of-sync
 * references at build time.
 *
 * Mirror: artifacts/tree-friend/src/components/ai/tool-ui/toolNames.ts
 */
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Type guard: narrows an unknown string (typically from the LLM's
 * functionCall response) to `ToolName`.
 *
 * The LLM can hallucinate tool names (or send a future tool not yet in
 * TOOL_NAMES). This guard safely returns `false` so the caller can log
 * + return a friendly "unknown tool" error instead of crashing.
 */
export function isToolName(s: string): s is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(s);
}

// ─── Fix #1 (backend, input): Per-tool Zod schemas for LLM-generated args ─

/**
 * Input args for `search_catalog`.
 *
 * Mirrors the JSON schema declared in `AI_TOOL_DECLARATIONS` (aiTools.ts ~line 197).
 * The LLM generates these args from the user's natural-language query — they
 * are untrusted (the model can hallucinate types, omit required fields, or
 * send extra junk).
 *
 * `passthrough()` keeps unknown fields (the LLM occasionally emits extra
 * metadata — we don't want to fail validation on that, we just ignore it).
 */
export const searchCatalogArgsSchema = z
  .object({
    query: z.string().min(1),
    max_price: z.number().optional(),
    sunlight: z.enum(["full_sun", "partial_shade", "full_shade"]).optional(),
  })
  .passthrough();

/**
 * Input args for `get_product_care`. Mirrors AI_TOOL_DECLARATIONS ~line 226.
 */
export const getProductCareArgsSchema = z
  .object({
    product_slug: z.string().min(1),
  })
  .passthrough();

/**
 * Input args for `get_user_orders`. The function takes no args — the schema
 * accepts an empty object (the LLM may send `{}` or omit args entirely).
 *
 * `passthrough()` is intentionally permissive: if the LLM hallucinates
 * args (e.g. `{ limit: 10 }`), we ignore them rather than fail. The tool
 * doesn't accept a limit — it always returns the 5 most recent orders.
 */
export const getUserOrdersArgsSchema = z.object({}).passthrough();

/**
 * Input args for `get_order_details`. Mirrors AI_TOOL_DECLARATIONS ~line 255.
 */
export const getOrderDetailsArgsSchema = z
  .object({
    order_number: z.number().int().positive(),
  })
  .passthrough();

/**
 * Input args for `search_knowledge_base`. Mirrors AI_TOOL_DECLARATIONS ~line 283.
 */
export const searchKbArgsSchema = z
  .object({
    query: z.string().min(1),
    category_slug: z.string().optional(),
    product_slug: z.string().optional(),
    max_results: z.number().int().min(1).max(10).optional(),
  })
  .passthrough();

/**
 * Input args for `search_seller_listings`. Mirrors AI_TOOL_DECLARATIONS ~line 341.
 *
 * v6.2 Part 16 (industry-standard premium-intent support):
 *   - Added `sort_by` enum. The LLM picks the value based on the user's
 *     stated preference (e.g. "i dont care about price" → maturity_desc,
 *     "best quality" → rating_desc, "most expensive" → price_desc).
 *   - The choice is the model's, NOT a keyword classifier — the model has
 *     the full conversation context + handles paraphrases/languages natively.
 *   - The tool description in aiTools.ts explains when to use each value.
 *   - The chosen value is echoed back in the tool RESULT envelope (see
 *     listingSearchResultSchema below) so the frontend can render the
 *     matching FactCallout without re-classifying the user's intent.
 *
 * v6.2 Part 17 (v1.8.0 — deterministic filtering args):
 *   - Added 5 new filter args so the LLM can do DETERMINISTIC filtering
 *     instead of relying on the v1.7.0 post-call checks (which depend
 *     on the LLM correctly reading fields + only citing matches).
 *   - `max_height` (number): filter by variants[].height ≤ value. Parsed
 *     via parseHeightToMaxValue() — "4-6 ft" → 6, "1-3 ft" → 3, etc.
 *   - `bloom_season` (string): filter by products.bloom_season containing
 *     the value (case-insensitive ILIKE). Use "winter", "summer", "Dec",
 *     "Jan", etc.
 *   - `min_rating` (number, 0-5): filter by seller rating ≥ value.
 *   - `max_delivery_days` (number, positive int): filter by
 *     sl.delivery_time_days ≤ value. NULL delivery_time_days is excluded
 *     (conservative — if the seller didn't commit, we can't promise).
 *   - `distinct_products` (boolean): dedupe by productName — return only
 *     the highest-ranked listing per variety. Used when user wants
 *     "different varieties" without padding with duplicates.
 *   - These filters are applied IN ADDITION to the existing args (query,
 *     max_price, form, sort_by, limit) — they compose.
 */
export const searchSellerListingsArgsSchema = z
  .object({
    query: z.string().min(1),
    max_price: z.number().optional(),
    form: z.string().optional(),
    limit: z.number().int().min(1).max(8).optional(),
    care_summary: z.boolean().optional(),
    sort_by: z
      .enum([
        "price_asc", // default — cheapest first
        "price_desc", // most expensive first — "premium", "top-end"
        "maturity_desc", // largest height variant first — "i dont care about price", "most mature", "largest"
        "rating_desc", // highest seller rating first — "best quality", "top rated", "highest rated"
      ])
      .optional(),
    // v1.8.0 deterministic filters
    max_height: z.number().positive().optional(),
    bloom_season: z.string().min(1).optional(),
    min_rating: z.number().min(0).max(5).optional(),
    max_delivery_days: z.number().int().positive().optional(),
    distinct_products: z.boolean().optional(),
  })
  .passthrough();

/**
 * Registry: tool name → input args schema.
 *
 * Used by `validateToolArgs` (below) to validate LLM-generated args before
 * dispatching to the tool implementation. The implementation receives a
 * typed, validated `args` object — no more `typeof args.query === "string"`
 * checks scattered through the code.
 *
 * Typed as `Record<ToolName, ZodType>` (required, not Partial) — every tool
 * MUST have an input schema. A new tool added to `TOOL_NAMES` without a
 * schema entry here fails typecheck.
 */
export const TOOL_INPUT_SCHEMAS: Record<ToolName, z.ZodTypeAny> = {
  search_catalog: searchCatalogArgsSchema,
  get_product_care: getProductCareArgsSchema,
  get_user_orders: getUserOrdersArgsSchema,
  get_order_details: getOrderDetailsArgsSchema,
  search_knowledge_base: searchKbArgsSchema,
  search_seller_listings: searchSellerListingsArgsSchema,
};

// ─── Fix #1 (backend, output): Per-tool Zod schemas for tool results ──────
//
// These mirror the frontend's schemas (artifacts/tree-friend/src/components/
// ai/tool-ui/schemas.ts). When the backend emits a result, it's validated
// against these BEFORE returning. A malformed result is logged + replaced
// with a friendly error — the LLM never sees broken data.
//
// Why `.passthrough()`: the backend may add new fields (forward-compat) —
// extra fields don't fail validation. Required fields are strict.
//
// KEEP IN SYNC with the frontend's schemas.ts. The frontend's are the
// consumer-side mirror (validate at the React render edge); these are the
// producer-side validators (validate before SSE serialization).

const orderItemSchema = z
  .object({
    name: z.string(),
    qty: z.number(),
    price: z.number(),
  })
  .passthrough();

const orderDataSchema = z
  .object({
    order_number: z.number(),
    tracking_id: z.string(),
    status: z.string(),
    payment_status: z.string(),
    payment_method: z.string(),
    total: z.union([z.string(), z.number()]),
    placed_at: z.string(),
    confirmed_at: z.string().nullable(),
    shipped_at: z.string().nullable(),
    delivered_at: z.string().nullable(),
    cancelled_at: z.string().nullable(),
    items: z.array(orderItemSchema),
    location: z.string().nullable(),
  })
  .passthrough();

export const orderResultSchema = z
  .object({
    // `.nullable().optional()` (not just .nullable()) because executeTool
    // can return early-exit envelopes that don't include `order` at all:
    //   - arg validation failure: { error: "Invalid args: ..." }
    //   - rate limit: { error: "...", rateLimited: true, retryAfterSeconds: 600 }
    //   - execution failure: { error: "Tool execution failed..." }
    // All three paths skip the tool implementation entirely, so `order` is
    // never set. Without `.optional()`, the schema would reject these +
    // replace them with a generic "malformed" error — masking the real,
    // more useful error message the LLM should see.
    order: orderDataSchema.nullable().optional(),
    error: z.string().optional(),
    signed_in: z.boolean().optional(),
    message: z.string().optional(),
    // Rate-limit responses share this envelope (they have `error` + extra fields).
    // Allow the rate-limit fields to pass through unchecked.
    rateLimited: z.boolean().optional(),
    retryAfterSeconds: z.number().optional(),
  })
  .passthrough();

const orderListItemSchema = z
  .object({
    order_number: z.number(),
    tracking_id: z.string(),
    status: z.string(),
    payment_status: z.string(),
    total: z.union([z.string(), z.number()]),
    date: z.string(),
    delivered: z.string().nullable(),
    items: z.array(z.string()),
    location: z.string().nullable(),
  })
  .passthrough();

export const ordersResultSchema = z
  .object({
    // `.optional()` for the same early-exit-envelope reason as orderResultSchema.
    signed_in: z.boolean().optional(),
    // `orders` is required when signed_in=true, but absent in the early-exit
    // envelopes. Make it optional + default to empty array via the validator.
    orders: z.array(orderListItemSchema).optional(),
    message: z.string().optional(),
    error: z.string().optional(),
    rateLimited: z.boolean().optional(),
    retryAfterSeconds: z.number().optional(),
  })
  .passthrough();

const listingVariantSchema = z
  .object({
    variantId: z.number(),
    form: z.string().nullable(),
    rootType: z.string().nullable(),
    potSize: z.string().nullable(),
    age: z.string().nullable(),
    height: z.string().nullable(),
    condition: z.string().nullable(),
    price: z.number(),
    discountPrice: z.number().nullable(),
    availableQuantity: z.number(),
    deliveryCharge: z.number(),
    isPreOrder: z.boolean(),
  })
  .passthrough();

const listingDataSchema = z
  .object({
    listingId: z.number(),
    productId: z.number(),
    productName: z.string(),
    productSlug: z.string(),
    sellerId: z.number(),
    sellerName: z.string(),
    sellerLocation: z.string().nullable(),
    sellerIsVerified: z.boolean(),
    rating: z.number(),
    reviewCount: z.number(),
    deliveryTimeDays: z.number().nullable(),
    warrantyDays: z.number().nullable(),
    paymentMethod: z.string(),
    certification: z.string().nullable(),
    productImage: z.string().nullable().optional(),
    variants: z.array(listingVariantSchema),
    hasInStockVariant: z.boolean(),
    hasPreOrderVariant: z.boolean(),
    minPrice: z.number().nullable(),
  })
  .passthrough();

const careSummarySchema = z
  .object({
    content: z.string(),
    sourceTitle: z.string().optional().nullable(),
  })
  .passthrough();

export const listingSearchResultSchema = z
  .object({
    // All top-level fields `.optional()` because executeTool can return
    // early-exit envelopes (arg-validation failure, rate limit, execution
    // failure) that don't include any of the success-path fields.
    listings: z.array(listingDataSchema).optional(),
    totalCount: z.number().optional(),
    query: z.string().optional(),
    buyerCity: z.string().nullable().optional(),
    buyerDistrict: z.string().nullable().optional(),
    careSummary: careSummarySchema.nullable().optional(),
    // v6.2 Part 16: echoes back the sortBy value the LLM chose, so the
    // frontend FactCallout can render the matching summary (e.g.
    // maturity_desc → "Most mature: ...") WITHOUT re-classifying the
    // user's intent via brittle keyword matching on the frontend.
    // Undefined when sort_by was not passed (defaults to price_asc on
    // the backend, but we don't synthesize a value here — the frontend
    // treats undefined === price_asc).
    //
    // Field name is camelCase `sortBy` (NOT snake_case `sort_by`) to match
    // (a) the actual return value from searchSellerListings() in
    //     sellerListingSearch.ts, which uses TS-idiomatic camelCase, and
    // (b) every other field in this schema (totalCount, buyerCity, etc.).
    // The INPUT args schema (searchSellerListingsArgsSchema) uses
    // snake_case `sort_by` because that's the LLM-tool-arg convention
    // (OpenAI/Anthropic/Gemini function-calling all use snake_case for
    // args). The OUTPUT schema uses camelCase to match the JS object
    // the search function actually returns.
    sortBy: z.enum(["price_asc", "price_desc", "maturity_desc", "rating_desc"]).optional(),
    error: z.string().optional(),
  })
  .passthrough();

const productDataSchema = z
  .object({
    name: z.string(),
    slug: z.string(),
    scientific_name: z.string().nullable(),
    description: z.string().nullable(),
    sunlight: z.string().nullable(),
    watering: z.string().nullable(),
    soil_type: z.string().nullable(),
    mature_height: z.string().nullable(),
    climate_zone: z.string().nullable(),
    growth_rate: z.string().nullable(),
    bloom_season: z.string().nullable(),
    key_benefits: z.array(z.string()).nullable(),
    best_for: z.array(z.string()).nullable(),
    care_tips: z.array(z.string()).nullable(),
    images: z.array(z.unknown()).nullable(),
    product_status: z.string().nullable(),
  })
  .passthrough();

export const careResultSchema = z
  .object({
    // `.optional()` for early-exit envelopes (see orderResultSchema comment).
    product: productDataSchema.nullable().optional(),
    error: z.string().optional(),
  })
  .passthrough();

const kbSourceSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    url: z.string().nullable(),
  })
  .passthrough();

const kbEntrySchema = z
  .object({
    title: z.string(),
    content: z.string(),
    keywords: z.array(z.string()),
    category: z.string().nullable(),
    product: z.string().nullable(),
    source: kbSourceSchema.nullable(),
    relevance_score: z.number(),
  })
  .passthrough();

export const kbResultSchema = z
  .object({
    // `.optional()` for early-exit envelopes (see orderResultSchema comment).
    results: z.array(kbEntrySchema).optional(),
    count: z.number().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

const catalogItemSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    scientific_name: z.string().nullable(),
    description: z.string().nullable(),
    sunlight: z.string().nullable(),
    watering: z.string().nullable(),
    mature_height: z.string().nullable(),
    product_status: z.string().nullable(),
    min_price: z.number().nullable(),
    image: z.string().nullable(),
  })
  .passthrough();

export const catalogResultSchema = z
  .object({
    // `.optional()` for early-exit envelopes (see orderResultSchema comment).
    results: z.array(catalogItemSchema).optional(),
    count: z.number().optional(),
    error: z.string().optional(),
  })
  .passthrough();

/**
 * Registry: tool name → output result schema.
 *
 * Used by `validateToolResult` to validate the tool's return value before
 * it crosses the SSE boundary. A malformed result is logged + replaced with
 * a friendly error envelope — the LLM never sees broken data.
 *
 * Typed as `Record<ToolName, ZodType>` (required) — every tool MUST have
 * an output schema. This ensures we don't accidentally emit a tool result
 * with no validation path (which would bypass the safety net entirely).
 */
export const TOOL_OUTPUT_SCHEMAS: Record<ToolName, z.ZodTypeAny> = {
  search_catalog: catalogResultSchema,
  get_product_care: careResultSchema,
  get_user_orders: ordersResultSchema,
  get_order_details: orderResultSchema,
  search_knowledge_base: kbResultSchema,
  search_seller_listings: listingSearchResultSchema,
};

// ─── Boundary helpers ─────────────────────────────────────────────────────
//
// These are the functions `executeTool` calls. They return a discriminated
// union so the caller can branch on success vs failure with full type
// narrowing (no `as` casts needed in the dispatch site).

export type ArgValidationResult<T> = { success: true; args: T } | { success: false; error: string };

/**
 * Validates LLM-generated tool-call args against the tool's input schema.
 *
 * Called at the TOP of `executeTool`, BEFORE dispatching to the tool
 * implementation. On failure: returns a friendly error string the LLM
 * can use to retry. On success: returns the parsed (and typed!) args.
 *
 * The error message is LLM-friendly: it includes the field path + the
 * expected type so the model can correct itself on the next round.
 * Example: `"Invalid args: Expected number, received string at 'order_number'"`.
 *
 * @param name   Tool name (must be a known ToolName — use isToolName first).
 * @param raw    The LLM-generated args (untrusted JSON).
 * @returns      On success, the parsed args typed as `z.infer<typeof schema>`.
 *               The caller should pass this typed value to the tool
 *               implementation — no more `typeof args.query === "string"`
 *               checks scattered through the implementation.
 */
export function validateToolArgs<N extends ToolName>(
  name: N,
  raw: unknown,
): ArgValidationResult<z.infer<(typeof TOOL_INPUT_SCHEMAS)[N]>> {
  const schema = TOOL_INPUT_SCHEMAS[name];
  // Defensive: every ToolName has a schema (Record<ToolName, ...>), so this
  // should never be undefined. But if someone bypasses the type system
  // (e.g. JS caller passing an arbitrary string), we fail gracefully.
  if (!schema) {
    return {
      success: false,
      error: `No input schema registered for tool "${name}"`,
    };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return { success: true, args: parsed.data };
  }
  // Flatten Zod's error to a single LLM-friendly string.
  const firstIssue = parsed.error.issues[0];
  const path = firstIssue.path.length > 0 ? firstIssue.path.join(".") : "(root)";
  const error = `Invalid args: ${firstIssue.message} at '${path}'`;
  return { success: false, error };
}

/**
 * Validates a tool's return value against its output schema.
 *
 * Called at the END of `executeTool`, BEFORE returning to the caller
 * (the SSE pipe in routes/ai.ts). On failure: logs the validation error
 * + returns a friendly error envelope instead of the malformed data.
 * The LLM never sees broken data — it gets a clear "tool failed" message
 * + can retry or answer without the data.
 *
 * Why this matters: tool implementations are written by humans + can
 * drift (a SQL column renamed, a refactor forgetting to update one
 * field). Without this validation, the bad data would silently flow
 * through the SSE pipe and crash the frontend's React render (the
 * frontend's ToolCardErrorBoundary catches it, but it's better to
 * catch it at the source).
 *
 * @param name    Tool name (must be a known ToolName).
 * @param result  The raw return value from the tool implementation.
 * @returns       The validated result on success, or `{ error: ... }` on failure.
 */
export function validateToolResult(name: ToolName, result: unknown): unknown {
  const schema = TOOL_OUTPUT_SCHEMAS[name];
  if (!schema) {
    // Defensive — every ToolName has an output schema.
    return result;
  }
  const parsed = schema.safeParse(result);
  if (parsed.success) {
    return parsed.data;
  }
  // Log the validation failure with full context. This is a backend
  // bug (the implementation emitted the wrong shape) — surface it for
  // debugging but don't crash the chat.
  const firstIssue = parsed.error.issues[0];
  const path = firstIssue.path.length > 0 ? firstIssue.path.join(".") : "(root)";
  logger.error(
    {
      tool: name,
      validationError: `${firstIssue.message} at ${path}`,
      // Don't log the full result — could contain PII (user addresses, etc).
      // Just log the path + message.
      errorPath: path,
    },
    "aiToolSchemas: tool result failed output validation — returning fallback error",
  );
  return {
    error: "Tool returned malformed data. Try answering without this data.",
    _validationFailed: true,
  };
}

// ─── Convenience: tools with rich UI (mirrors frontend) ───────────────────
//
// The route handler uses this to decide whether to include `result` in the
// SSE `tool_result` event. Tools without UI (search_catalog, search_knowledge_base)
// don't send their result data over the wire — the LLM already processed it
// in its text response. Tools with UI (get_order_details, etc.) send the
// structured data so the frontend can render rich cards inline.
//
// Mirror of: artifacts/tree-friend/src/components/ai/tool-ui/toolNames.ts
//           `TOOLS_WITH_UI` export (kept in sync).

export const TOOLS_WITH_UI: ReadonlySet<ToolName> = new Set<ToolName>([
  "get_order_details",
  "get_user_orders",
  "search_seller_listings",
  "get_product_care",
  // search_knowledge_base is rendered separately by KbCitations on the
  // frontend — its result IS sent over the wire so KbCitations can
  // extract source URLs.
  "search_knowledge_base",
]);
