/**
 * schemas.ts — Zod schemas for AI tool-result payloads.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 *
 * Before this file, every tool-UI component received `data: unknown` and
 * cast it to its expected shape with `as`:
 *
 *   const result = data as OrderResult;
 *
 * This compiled fine even if the backend returned `{ completely: "different" }`.
 * The cast was an unchecked assertion — a backend schema drift would silently
 * produce a card that crashed at the first property access (`undefined.items`).
 * The `ToolCardErrorBoundary` caught the crash at render time, but only
 * AFTER React had tried to render the component (the error was reactive,
 * not preventive).
 *
 * This file adds **runtime validation** at the boundary:
 *
 *   1. Each tool that emits UI data has a Zod schema mirroring its backend
 *      return shape (cross-referenced to aiTools.ts).
 *   2. `ToolComponentRenderer` runs `schema.safeParse(data)` BEFORE
 *      rendering the card.
 *   3. On success, the parsed (and typed!) data flows into the card —
 *      the card receives a typed prop, not `unknown`.
 *   4. On failure, the renderer logs the validation error and falls back
 *      to the same error UI it already uses for `ok: false` results.
 *
 * The schemas use `.passthrough()` so unknown extra fields don't fail
 * validation (backward-compat with backend additions — the backend
 * may add a field without breaking older frontends). Required fields
 * are strict; optional fields are `.nullable().optional()` to match
 * the backend's `null | undefined | T` cases.
 *
 * ─── Backend source of truth ────────────────────────────────────────────────
 *
 * Cross-reference: artifacts/api-server/src/lib/aiTools.ts:
 *   - getOrderDetails (line ~895): returns `{ order, error?, signed_in?, message? }`
 *   - getUserOrders (line ~845):    returns `{ signed_in, orders[], message? }`
 *   - searchSellerListings:        returns `SellerListingSearchResult` (lib/sellerListingSearch.ts)
 *   - getProductCare (line ~819):   returns `{ product, error? }`
 *   - searchKb (line ~986):         returns `{ results, count, message? }`
 *
 * Each schema below is annotated with its backend source location. When
 * the backend changes a return shape, update the schema here + the typecheck
 * will catch any card that referenced a removed field.
 *
 * ─── Industry context ───────────────────────────────────────────────────────
 *
 * This is the standard Vercel AI SDK + Inference + Zod pattern for tool
 * results (also used by LangChain.js StructuredTool, Anthropic's tool-use
 * `input_schema`, OpenAI's `strict: true` function-calling). The principle
 * is: **untrusted data crosses a trust boundary at the component edge —
 * validate it there, not inside the component**.
 */
import { z } from "zod";

// ─── get_order_details ──────────────────────────────────────────────────────
// Backend: aiTools.ts getOrderDetails (~line 895)
// Returns the order if found + signed in, else { order: null, error/message }.

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
    total: z.union([z.string(), z.number()]), // total_amount::text → string
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
    order: orderDataSchema.nullable(),
    error: z.string().optional(),
    signed_in: z.boolean().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export type OrderResult = z.infer<typeof orderResultSchema>;
export type OrderData = z.infer<typeof orderDataSchema>;
export type OrderItem = z.infer<typeof orderItemSchema>;

// ─── get_user_orders ─────────────────────────────────────────────────────────
// Backend: aiTools.ts getUserOrders (~line 845)
// Returns { signed_in, orders[], message? }. orders[].items is string[] (already
// pre-formatted as "1× Alphonso Mango" — different shape from get_order_details).

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
    signed_in: z.boolean(),
    orders: z.array(orderListItemSchema),
    message: z.string().optional(),
  })
  .passthrough();

export type OrdersResult = z.infer<typeof ordersResultSchema>;
export type OrderListItem = z.infer<typeof orderListItemSchema>;

// ─── search_seller_listings ─────────────────────────────────────────────────
// Backend: lib/sellerListingSearch.ts SellerListingSearchResult (~line 139).
// Each listing has variants[], hasInStockVariant, hasPreOrderVariant, minPrice.

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
    listings: z.array(listingDataSchema),
    totalCount: z.number(),
    query: z.string(),
    buyerCity: z.string().nullable(),
    buyerDistrict: z.string().nullable(),
    careSummary: careSummarySchema.nullable().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export type ListingSearchResult = z.infer<typeof listingSearchResultSchema>;
export type ListingData = z.infer<typeof listingDataSchema>;
export type ListingVariant = z.infer<typeof listingVariantSchema>;

// ─── get_product_care ───────────────────────────────────────────────────────
// Backend: aiTools.ts getProductCare (~line 819)
// Returns { product, error? }. product.images is unknown[] (could be string[]
// or { url: string }[] — the backend doesn't normalize). We accept both.

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
    // images: backend may return string[] OR { url: string }[] depending on
    // the SQL row shape. We accept any array — the CareGuideCard already
    // normalizes via `typeof image === "string" ? image : image?.url`.
    images: z.array(z.unknown()).nullable(),
    product_status: z.string().nullable(),
  })
  .passthrough();

export const careResultSchema = z
  .object({
    product: productDataSchema.nullable(),
    error: z.string().optional(),
  })
  .passthrough();

export type CareResult = z.infer<typeof careResultSchema>;
export type ProductData = z.infer<typeof productDataSchema>;

// ─── search_knowledge_base ───────────────────────────────────────────────────
// Backend: aiTools.ts searchKb (~line 986)
// Returns { results, count, message? }. Each result has a `source` that
// may be null (internal KB entries without an external reference).

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
    results: z.array(kbEntrySchema),
    count: z.number(),
    message: z.string().optional(),
  })
  .passthrough();

export type KbResult = z.infer<typeof kbResultSchema>;
export type KbEntry = z.infer<typeof kbEntrySchema>;
export type KbSource = z.infer<typeof kbSourceSchema>;

// ─── Schema registry: tool name → Zod schema ───────────────────────────────
//
// Maps each ToolName (with UI) to its Zod schema. Used by
// ToolComponentRenderer to validate `data` before rendering.
//
// Why a separate registry (not embedded in TOOL_UI_MAP):
//   - Schemas are pure data (no JSX), components are React. Mixing them
//     forces the schemas file to import React (or vice versa).
//   - KbCitations uses the KB schema but isn't in TOOL_UI_MAP — keeping
//     schemas separate lets KbCitations import its schema directly.
//   - Easier to unit-test schemas in isolation.
//
// Type: `Record<ToolName, ZodType>` would force a schema for EVERY tool
// (including search_catalog which has no UI). We use Partial<> + a
// `getSchemaForTool` helper that returns undefined for tools without UI
// (the caller skips rendering — same as today's behavior).

import type { ToolName } from "./toolNames";

export const TOOL_SCHEMAS: Partial<Record<ToolName, z.ZodTypeAny>> = {
  get_order_details: orderResultSchema,
  get_user_orders: ordersResultSchema,
  search_seller_listings: listingSearchResultSchema,
  get_product_care: careResultSchema,
  search_knowledge_base: kbResultSchema,
};

/**
 * Returns the Zod schema for a tool, or `undefined` if the tool has no
 * registered UI (and thus no schema). Used by ToolComponentRenderer to
 * decide whether to validate + render.
 *
 * Why a function (not direct map access): centralizes the lookup so the
 * "no schema" case is explicit. Callers handle `undefined` by skipping
 * the render — the LLM's text already covers tools without UI.
 */
export function getSchemaForTool(name: string): z.ZodTypeAny | undefined {
  // We can't use `name as ToolName` here — that would defeat the type
  // safety this module provides. Instead, we cast through `unknown` and
  // let the runtime check (TOOL_SCHEMAS[name]) return undefined for
  // unknown names. This is safe because TOOL_SCHEMAS is a Partial<>
  // map — accessing an unknown key returns undefined, not a crash.
  return (TOOL_SCHEMAS as Record<string, z.ZodTypeAny | undefined>)[name];
}

/**
 * Validates a `search_knowledge_base` tool-result payload against the
 * KB schema. Returns the parsed `KbResult` on success, `null` on failure.
 *
 * Used by `KbCitations.extractKbCitations` to validate each KB tool
 * result before extracting citation sources. KbCitations is rendered
 * by ToolComponentRenderer AFTER the rich cards and isn't wrapped in
 * ToolCardErrorBoundary — so this safeParse is its primary defense.
 *
 * Returning `null` (instead of throwing) lets the caller skip the
 * malformed entry and continue processing the rest. The chat keeps
 * working; only the citations are missing.
 */
export function validateKbResult(raw: unknown): KbResult | null {
  const parsed = kbResultSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(
      "[schemas] search_knowledge_base returned malformed data:",
      parsed.error.issues[0]?.message,
      { rawData: raw },
    );
    return null;
  }
  return parsed.data;
}

/**
 * Result of validating a tool-result payload.
 *
 * - `success: true`  → `data` is the parsed + typed value (safe to pass
 *                      to the card component as a typed prop).
 * - `success: false` → `error` is a Zod-formatted error string for logging.
 *
 * The ToolComponentRenderer uses this to decide render-vs-fallback.
 */
export type ValidationResult<T> = { success: true; data: T } | { success: false; error: string };

/**
 * Validates a tool-result payload against the registered schema.
 *
 * On success: returns the parsed data (Zod has already coerced + validated
 * the shape — the caller can pass it to the React component as a typed prop).
 *
 * On failure: returns the Zod error in a loggable string form. The caller
 * renders the existing error fallback UI instead of trying to render the
 * (malformed) data.
 *
 * If the tool has no registered schema (i.e., it's a tool without UI),
 * returns `{ success: true, data: raw }` — the raw data passes through
 * unchanged. This shouldn't happen in practice (the renderer only calls
 * this for tools in TOOL_UI_MAP), but the fallback is safe.
 *
 * @param name  Tool name from the SSE `tool_result.name` field.
 * @param raw   The `result` field from the SSE `tool_result` payload
 *              (untrusted — could be any JSON).
 */
export function validateToolResult<T = unknown>(name: string, raw: unknown): ValidationResult<T> {
  const schema = getSchemaForTool(name);
  if (!schema) {
    // No schema registered — pass through. The caller (renderer) only
    // calls this for tools in TOOL_UI_MAP, so this branch shouldn't hit
    // in practice. If it does, the card will receive raw `unknown` and
    // its own defensive code (or ToolCardErrorBoundary) handles it.
    return { success: true, data: raw as T };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return { success: true, data: parsed.data as T };
  }
  // Zod's error format is verbose — flatten to a single string for logging.
  // The first issue is usually the most relevant; subsequent issues are
  // often downstream of the first (a missing object → its fields all missing).
  const firstIssue = parsed.error.issues[0];
  const path = firstIssue.path.length > 0 ? firstIssue.path.join(".") : "(root)";
  const error = `${firstIssue.message} at ${path}`;
  return { success: false, error };
}
