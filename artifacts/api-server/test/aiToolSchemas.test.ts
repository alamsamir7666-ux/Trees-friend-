/**
 * aiToolSchemas.test.ts — unit tests for the backend Zod schemas.
 *
 * These tests prove the backend catches:
 *   - LLM hallucinated arg types (input validation, validateToolArgs)
 *   - Implementation drift in tool results (output validation, validateToolResult)
 *
 * Mirror of the frontend's schemas.test.ts — same shapes, same happy-path
 * + drift cases. Together the two suites ensure the producer (backend) and
 * consumer (frontend) sides can't silently diverge.
 *
 * Run with: pnpm --filter @workspace/api-server exec vitest run test/aiToolSchemas.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TOOL_NAMES,
  isToolName,
  validateToolArgs,
  validateToolResult,
  TOOLS_WITH_UI,
  searchCatalogArgsSchema,
  getOrderDetailsArgsSchema,
  searchSellerListingsArgsSchema,
  searchKbArgsSchema,
  orderResultSchema,
  listingSearchResultSchema,
} from "../src/lib/aiToolSchemas";

// Silence the logger during tests (validateToolResult calls logger.error
// on validation failure — these are expected test paths, not real errors).
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// ─── Fix #2: Typed tool-name registry ──────────────────────────────────────

describe("Fix #2 — typed tool-name registry", () => {
  it("TOOL_NAMES includes every backend tool name", () => {
    // Cross-reference: aiTools.ts's executeTool switch.
    expect(TOOL_NAMES).toContain("search_catalog");
    expect(TOOL_NAMES).toContain("get_product_care");
    expect(TOOL_NAMES).toContain("get_user_orders");
    expect(TOOL_NAMES).toContain("get_order_details");
    expect(TOOL_NAMES).toContain("search_knowledge_base");
    expect(TOOL_NAMES).toContain("search_seller_listings");
    expect(TOOL_NAMES).toHaveLength(6);
  });

  it("TOOL_NAMES values are unique", () => {
    const set = new Set(TOOL_NAMES);
    expect(set.size).toBe(TOOL_NAMES.length);
  });

  it("isToolName narrows known names + rejects unknown", () => {
    expect(isToolName("get_order_details")).toBe(true);
    expect(isToolName("search_catalog")).toBe(true);
    // Typo — missing 's'
    expect(isToolName("get_order_detail")).toBe(false);
    // Future tool not yet added
    expect(isToolName("future_tool")).toBe(false);
    expect(isToolName("")).toBe(false);
  });

  it("TOOLS_WITH_UI includes all tools with frontend-rendered cards", () => {
    // Cross-reference: frontend toolNames.ts TOOLS_WITH_UI (must mirror).
    expect(TOOLS_WITH_UI.has("get_order_details")).toBe(true);
    expect(TOOLS_WITH_UI.has("get_user_orders")).toBe(true);
    expect(TOOLS_WITH_UI.has("search_seller_listings")).toBe(true);
    expect(TOOLS_WITH_UI.has("get_product_care")).toBe(true);
    // search_knowledge_base is in TOOLS_WITH_UI because KbCitations
    // consumes its result on the frontend.
    expect(TOOLS_WITH_UI.has("search_knowledge_base")).toBe(true);
    // search_catalog is NOT in TOOLS_WITH_UI — the LLM's text covers it.
    expect(TOOLS_WITH_UI.has("search_catalog")).toBe(false);
  });
});

// ─── Fix #1 (input): Per-tool Zod schemas for LLM-generated args ──────────

describe("Fix #1 (input) — validateToolArgs catches LLM arg drift", () => {
  it("validates well-formed search_catalog args", () => {
    const valid = { query: "mango", max_price: 500, sunlight: "full_sun" };
    const result = validateToolArgs("search_catalog", valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.args.query).toBe("mango");
      expect(result.args.max_price).toBe(500);
    }
  });

  it("rejects search_catalog args with missing required 'query'", () => {
    const invalid = { max_price: 500 }; // query missing
    const result = validateToolArgs("search_catalog", invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("query");
    }
  });

  it("rejects search_catalog args with empty-string 'query'", () => {
    const invalid = { query: "" }; // min(1) violation
    const result = validateToolArgs("search_catalog", invalid);
    expect(result.success).toBe(false);
  });

  it("rejects search_catalog args with wrong-type 'max_price' (string instead of number)", () => {
    // The LLM occasionally emits "500" instead of 500.
    const invalid = { query: "mango", max_price: "500" };
    const result = validateToolArgs("search_catalog", invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("max_price");
    }
  });

  it("rejects search_catalog args with invalid sunlight enum value", () => {
    const invalid = { query: "mango", sunlight: "full_sunlight" }; // typo
    const result = validateToolArgs("search_catalog", invalid);
    expect(result.success).toBe(false);
  });

  it("accepts search_catalog args with extra unknown fields (passthrough)", () => {
    // The LLM can hallucinate extra fields. Passthrough keeps them so we
    // don't fail validation — they're just ignored by the implementation.
    const valid = { query: "mango", hallucinated_field: "ignored" };
    const result = validateToolArgs("search_catalog", valid);
    expect(result.success).toBe(true);
  });

  it("validates well-formed get_order_details args", () => {
    const valid = { order_number: 1234 };
    const result = validateToolArgs("get_order_details", valid);
    expect(result.success).toBe(true);
  });

  it("rejects get_order_details with non-integer order_number", () => {
    const invalid = { order_number: 1234.5 };
    const result = validateToolArgs("get_order_details", invalid);
    expect(result.success).toBe(false);
  });

  it("rejects get_order_details with non-positive order_number", () => {
    const invalid = { order_number: 0 };
    const result = validateToolArgs("get_order_details", invalid);
    expect(result.success).toBe(false);
  });

  it("rejects get_order_details with string order_number (LLM type drift)", () => {
    const invalid = { order_number: "1234" }; // should be number
    const result = validateToolArgs("get_order_details", invalid);
    expect(result.success).toBe(false);
  });

  it("validates well-formed search_seller_listings args", () => {
    const valid = {
      query: "mango sapling",
      max_price: 500,
      form: "sapling",
      limit: 5,
      care_summary: true,
    };
    const result = validateToolArgs("search_seller_listings", valid);
    expect(result.success).toBe(true);
  });

  it("rejects search_seller_listings with limit > 8 (above cap)", () => {
    const invalid = { query: "mango", limit: 10 };
    const result = validateToolArgs("search_seller_listings", invalid);
    expect(result.success).toBe(false);
  });

  it("validates well-formed search_knowledge_base args", () => {
    const valid = {
      query: "mango watering",
      category_slug: "plant-care",
      max_results: 5,
    };
    const result = validateToolArgs("search_knowledge_base", valid);
    expect(result.success).toBe(true);
  });

  it("rejects search_knowledge_base with max_results > 10", () => {
    const invalid = { query: "mango", max_results: 20 };
    const result = validateToolArgs("search_knowledge_base", invalid);
    expect(result.success).toBe(false);
  });

  it("validates get_user_orders with empty args (no args needed)", () => {
    const result = validateToolArgs("get_user_orders", {});
    expect(result.success).toBe(true);
  });

  it("accepts get_user_orders with hallucinated args (passthrough, ignored)", () => {
    const result = validateToolArgs("get_user_orders", { limit: 10 });
    expect(result.success).toBe(true); // limit is ignored — tool returns 5 most recent
  });

  it("validates get_product_care args", () => {
    const result = validateToolArgs("get_product_care", { product_slug: "alphonso-mango" });
    expect(result.success).toBe(true);
  });

  it("rejects get_product_care with missing product_slug", () => {
    const result = validateToolArgs("get_product_care", {});
    expect(result.success).toBe(false);
  });
});

// ─── Fix #1 (output): Per-tool Zod schemas for tool results ───────────────

describe("Fix #1 (output) — validateToolResult catches implementation drift", () => {
  it("passes through a well-formed get_order_details result", () => {
    const valid = {
      order: {
        order_number: 1234,
        tracking_id: "TF-ABC",
        status: "shipped",
        payment_status: "paid",
        payment_method: "bkash",
        total: "1250.00",
        placed_at: "2024-08-15",
        confirmed_at: null,
        shipped_at: null,
        delivered_at: null,
        cancelled_at: null,
        items: [],
        location: null,
      },
    };
    const result = validateToolResult("get_order_details", valid);
    // On success, the parsed value is returned (identity for valid data).
    expect((result as { order: { order_number: number } }).order.order_number).toBe(1234);
  });

  it("returns a friendly error envelope for malformed get_order_details result", () => {
    // Simulate backend drift: order_number column renamed to orderNum.
    const malformed = {
      order: {
        orderNum: 1234, // renamed — frontend won't find order_number
        tracking_id: "TF-ABC",
        status: "shipped",
        payment_status: "paid",
        payment_method: "bkash",
        total: "1250",
        placed_at: "2024-08-15",
        confirmed_at: null,
        shipped_at: null,
        delivered_at: null,
        cancelled_at: null,
        items: [],
        location: null,
      },
    };
    const result = validateToolResult("get_order_details", malformed);
    // Should return the error envelope, NOT the malformed data.
    expect(result).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("malformed"),
        _validationFailed: true,
      }),
    );
  });

  it("passes through a well-formed search_seller_listings result", () => {
    const valid = {
      listings: [],
      totalCount: 0,
      query: "mango",
      buyerCity: null,
      buyerDistrict: null,
    };
    const result = validateToolResult("search_seller_listings", valid);
    expect((result as { totalCount: number }).totalCount).toBe(0);
  });

  it("returns a friendly error for malformed search_seller_listings result", () => {
    const malformed = {
      listings: "not-an-array", // drift
      totalCount: 0,
      query: "mango",
      buyerCity: null,
      buyerDistrict: null,
    };
    const result = validateToolResult("search_seller_listings", malformed);
    expect(result).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("malformed"),
        _validationFailed: true,
      }),
    );
  });

  it("passes through error envelopes (rate-limit responses) unchanged", () => {
    // Rate-limit responses have a different shape than success responses
    // (they carry `error` + `rateLimited` + `retryAfterSeconds`). The
    // output schema's optional fields accommodate this — validation
    // shouldn't reject them.
    const rateLimitResponse = {
      error: "This action (get_order_details) has been called too many times.",
      rateLimited: true,
      retryAfterSeconds: 600,
      // `order` is missing — schema allows it via optional + nullable path.
      // The rate-limit path returns BEFORE the tool runs, so no order data.
    };
    const result = validateToolResult("get_order_details", rateLimitResponse);
    // Should pass through (the schema accepts missing order — it's nullable).
    expect((result as { rateLimited: boolean }).rateLimited).toBe(true);
  });

  it("passes through plain { error: ... } envelopes (validation-failed responses)", () => {
    // When validateToolArgs fails, executeTool returns { error: ... } before
    // any tool runs. The output validator must accept this — it's a valid
    // response shape for the "args failed validation" path.
    const argErrorResponse = { error: "Invalid args: Expected number at 'order_number'" };
    const result = validateToolResult("get_order_details", argErrorResponse);
    // Should pass through — the output schema accepts { error?: string }.
    expect((result as { error: string }).error).toContain("Invalid args");
  });
});

// ─── Schema export sanity checks ──────────────────────────────────────────

describe("Schema exports", () => {
  it("searchCatalogArgsSchema validates a happy-path payload", () => {
    const result = searchCatalogArgsSchema.safeParse({ query: "mango" });
    expect(result.success).toBe(true);
  });

  it("getOrderDetailsArgsSchema rejects non-number order_number", () => {
    const result = getOrderDetailsArgsSchema.safeParse({ order_number: "abc" });
    expect(result.success).toBe(false);
  });

  it("searchSellerListingsArgsSchema accepts minimal args", () => {
    const result = searchSellerListingsArgsSchema.safeParse({ query: "mango" });
    expect(result.success).toBe(true);
  });

  it("searchKbArgsSchema rejects negative max_results", () => {
    const result = searchKbArgsSchema.safeParse({ query: "mango", max_results: -1 });
    expect(result.success).toBe(false);
  });

  it("orderResultSchema accepts a complete order payload", () => {
    const valid = {
      order: {
        order_number: 1,
        tracking_id: "TF-X",
        status: "pending",
        payment_status: "pending",
        payment_method: "cod",
        total: "100",
        placed_at: "2024-08-15",
        confirmed_at: null,
        shipped_at: null,
        delivered_at: null,
        cancelled_at: null,
        items: [],
        location: null,
      },
    };
    expect(orderResultSchema.safeParse(valid).success).toBe(true);
  });

  it("listingSearchResultSchema accepts an empty-listings payload", () => {
    const valid = {
      listings: [],
      totalCount: 0,
      query: "test",
      buyerCity: null,
      buyerDistrict: null,
    };
    expect(listingSearchResultSchema.safeParse(valid).success).toBe(true);
  });
});

// ─── Compile-time test: typed maps reject bad keys ────────────────────────
//
// Uncomment the lines below to verify TypeScript rejects them at compile
// time. They're commented out so the test file compiles + runs.
//
// import { TOOL_INPUT_SCHEMAS, TOOL_OUTPUT_SCHEMAS } from "../src/lib/aiToolSchemas";
//
// // ❌ Should fail: typo'd tool name
// const badInput: Record<ToolName, unknown> = {
//   get_order_detail: searchCatalogArgsSchema, // missing 's'
//   // ...
// };
//
// // ❌ Should fail: missing entry (Record<ToolName, ...> requires all keys)
// const incompleteOutput: Record<ToolName, unknown> = {
//   get_order_details: orderResultSchema,
//   // missing the other 5 tools
// };
