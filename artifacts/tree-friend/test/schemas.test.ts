/**
 * schemas.test.ts — unit tests for the tool-result Zod schemas.
 *
 * These tests prove the schemas catch backend drift BEFORE it reaches the
 * React render phase (the whole point of Gap Fix #1). They use the same
 * shape the backend returns today (the "happy path"), then mutate it to
 * simulate drift.
 *
 * Run with: pnpm --filter @workspace/tree-friend exec vitest run src/components/ai/tool-ui/schemas.test.ts
 * (or: pnpm vitest run schemas.test.ts from the tree-friend directory)
 *
 * The tests are deliberately small + standalone — no React, no mocks, just
 * Zod schema inputs/outputs. They catch regressions in the schema shapes
 * if the backend types change.
 */
import { describe, it, expect } from "vitest";
import {
  orderResultSchema,
  ordersResultSchema,
  listingSearchResultSchema,
  careResultSchema,
  kbResultSchema,
  validateToolResult,
  validateKbResult,
} from "../src/components/ai/tool-ui/schemas";
import { isToolName, TOOL_NAMES } from "../src/components/ai/tool-ui/toolNames";

// ─── Happy paths: real backend payloads validate ──────────────────────────

describe("tool-result schemas — happy paths", () => {
  it("validates a well-formed get_order_details payload", () => {
    const payload = {
      order: {
        order_number: 1234,
        tracking_id: "TF-ABC123",
        status: "shipped",
        payment_status: "paid",
        payment_method: "bkash",
        total: "1250.00",
        placed_at: "2024-08-15",
        confirmed_at: "2024-08-15",
        shipped_at: "2024-08-16",
        delivered_at: null,
        cancelled_at: null,
        items: [
          { name: "Alphonso Mango Sapling", qty: 1, price: 950 },
          { name: "Fertilizer Pack", qty: 1, price: 300 },
        ],
        location: "Dhaka, Dhaka",
      },
    };
    const parsed = orderResultSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.order?.order_number).toBe(1234);
      expect(parsed.data.order?.items).toHaveLength(2);
    }
  });

  it("validates get_order_details with order: null (not-signed-in case)", () => {
    const payload = {
      order: null,
      signed_in: false,
      message: "User is not signed in.",
    };
    const parsed = orderResultSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("validates a well-formed get_user_orders payload", () => {
    const payload = {
      signed_in: true,
      orders: [
        {
          order_number: 1234,
          tracking_id: "TF-ABC",
          status: "delivered",
          payment_status: "paid",
          total: 950,
          date: "2024-08-15",
          delivered: "2024-08-18",
          items: ["1× Alphonso Mango Sapling"],
          location: "Dhaka",
        },
      ],
    };
    const parsed = ordersResultSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("validates a well-formed search_seller_listings payload", () => {
    const payload = {
      listings: [
        {
          listingId: 42,
          productId: 7,
          productName: "Alphonso Mango",
          productSlug: "alphonso-mango",
          sellerId: 99,
          sellerName: "Green Nursery",
          sellerLocation: "Dhaka",
          sellerIsVerified: true,
          rating: 4.5,
          reviewCount: 12,
          deliveryTimeDays: 3,
          warrantyDays: 30,
          paymentMethod: "both",
          certification: "Organic",
          productImage: "https://cdn.example.com/img.jpg",
          variants: [
            {
              variantId: 1,
              form: "Sapling",
              rootType: null,
              potSize: null,
              age: "1 year",
              height: "3ft",
              condition: null,
              price: 450,
              discountPrice: 400,
              availableQuantity: 10,
              deliveryCharge: 50,
              isPreOrder: false,
            },
          ],
          hasInStockVariant: true,
          hasPreOrderVariant: false,
          minPrice: 400,
        },
      ],
      totalCount: 1,
      query: "mango",
      buyerCity: "Dhaka",
      buyerDistrict: "Dhaka",
    };
    const parsed = listingSearchResultSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("validates search_seller_listings with productImage: null (Bug 1 fallback)", () => {
    const payload = {
      listings: [
        {
          listingId: 1,
          productId: 1,
          productName: "Test",
          productSlug: "test",
          sellerId: 1,
          sellerName: "Seller",
          sellerLocation: null,
          sellerIsVerified: false,
          rating: 0,
          reviewCount: 0,
          deliveryTimeDays: null,
          warrantyDays: null,
          paymentMethod: "cod",
          certification: null,
          productImage: null,
          variants: [],
          hasInStockVariant: false,
          hasPreOrderVariant: false,
          minPrice: null,
        },
      ],
      totalCount: 1,
      query: "test",
      buyerCity: null,
      buyerDistrict: null,
    };
    const parsed = listingSearchResultSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("validates a well-formed get_product_care payload", () => {
    const payload = {
      product: {
        name: "Alphonso Mango",
        slug: "alphonso-mango",
        scientific_name: "Mangifera indica",
        description: "A sweet mango variety.",
        sunlight: "full_sun",
        watering: "weekly",
        soil_type: "well-draining",
        mature_height: "30ft",
        climate_zone: "tropical",
        growth_rate: "fast",
        bloom_season: "spring",
        key_benefits: ["Sweet fruit", "Drought tolerant"],
        best_for: ["garden"],
        care_tips: ["Water deeply", "Prune in winter"],
        images: ["https://cdn.example.com/mango.jpg"],
        product_status: "active",
      },
    };
    const parsed = careResultSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("validates get_product_care with product: null (not found case)", () => {
    const payload = { product: null, error: "Product not found." };
    const parsed = careResultSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("validates a well-formed search_knowledge_base payload", () => {
    const payload = {
      results: [
        {
          title: "Mango Care in Bangladesh",
          content: "Water weekly during dry season...",
          keywords: ["mango", "watering"],
          category: "Plant Care",
          product: null,
          source: {
            type: "article",
            title: "Bangladesh Horticulture Board",
            url: "https://example.com/article",
          },
          relevance_score: 0.85,
        },
        {
          title: "Internal Note",
          content: "Internal growing tips.",
          keywords: [],
          category: null,
          product: null,
          source: null,
          relevance_score: 0.42,
        },
      ],
      count: 2,
    };
    const parsed = kbResultSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.results).toHaveLength(2);
    }
  });
});

// ─── Drift detection: schemas CATCH backend shape changes ────────────────

describe("tool-result schemas — drift detection", () => {
  it("rejects get_order_details with missing required field (order_number)", () => {
    const payload = {
      order: {
        // order_number missing — simulates a backend column rename
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
    const parsed = orderResultSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // The error should mention the missing field path.
      expect(parsed.error.issues[0].path).toContain("order");
      expect(parsed.error.issues[0].path).toContain("order_number");
    }
  });

  it("rejects get_user_orders with orders: not-an-array", () => {
    const payload = {
      signed_in: true,
      orders: "not-an-array", // drift: backend changed shape
    };
    const parsed = ordersResultSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });

  it("rejects search_seller_listings with a listing missing variants", () => {
    const payload = {
      listings: [
        {
          listingId: 1,
          productId: 1,
          productName: "Test",
          productSlug: "test",
          sellerId: 1,
          sellerName: "Seller",
          sellerLocation: null,
          sellerIsVerified: false,
          rating: 0,
          reviewCount: 0,
          deliveryTimeDays: null,
          warrantyDays: null,
          paymentMethod: "cod",
          certification: null,
          // variants missing — drift simulation
          hasInStockVariant: false,
          hasPreOrderVariant: false,
          minPrice: null,
        },
      ],
      totalCount: 1,
      query: "test",
      buyerCity: null,
      buyerDistrict: null,
    };
    const parsed = listingSearchResultSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });

  it("rejects get_product_care with non-string sunlight (type drift)", () => {
    const payload = {
      product: {
        name: "Test",
        slug: "test",
        scientific_name: null,
        description: null,
        sunlight: 42, // drift: should be string|null, got number
        watering: null,
        soil_type: null,
        mature_height: null,
        climate_zone: null,
        growth_rate: null,
        bloom_season: null,
        key_benefits: null,
        best_for: null,
        care_tips: null,
        images: null,
        product_status: null,
      },
    };
    const parsed = careResultSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });

  it("rejects search_knowledge_base with malformed source.url (number instead of string|null)", () => {
    const payload = {
      results: [
        {
          title: "Test",
          content: "Test",
          keywords: [],
          category: null,
          product: null,
          source: { type: "article", title: "X", url: 12345 }, // drift
          relevance_score: 0.5,
        },
      ],
      count: 1,
    };
    const parsed = kbResultSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });
});

// ─── Passthrough: extra fields don't break validation ────────────────────

describe("tool-result schemas — passthrough (backward-compat)", () => {
  it("accepts get_order_details with EXTRA fields (backend added a field)", () => {
    const payload = {
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
        // Brand new backend field — frontend doesn't know about it
        // but shouldn't break.
        estimated_delivery_window: "3-5 days",
      },
      // Backend added a top-level field too.
      cache_ttl_seconds: 300,
    };
    const parsed = orderResultSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });
});

// ─── validateToolResult boundary helper ────────────────────────────────────

describe("validateToolResult — boundary helper", () => {
  it("returns success: true with parsed data for a valid payload", () => {
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
    const result = validateToolResult("get_order_details", valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.order?.order_number).toBe(1);
    }
  });

  it("returns success: false with a loggable error string for a malformed payload", () => {
    const malformed = {
      order: {
        /* missing fields */
      },
    };
    const result = validateToolResult("get_order_details", malformed);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("passes through unchanged for tools without a schema (no UI)", () => {
    // search_catalog has no UI registered, so no schema.
    const raw = { results: [], count: 0 };
    const result = validateToolResult("search_catalog", raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(raw); // identity — same reference
    }
  });
});

// ─── validateKbResult helper (used by KbCitations) ─────────────────────────

describe("validateKbResult — KB citation extractor defense", () => {
  it("returns parsed data for a valid payload", () => {
    const valid = {
      results: [
        {
          title: "Test",
          content: "content",
          keywords: [],
          category: null,
          product: null,
          source: null,
          relevance_score: 0.5,
        },
      ],
      count: 1,
    };
    expect(validateKbResult(valid)).not.toBeNull();
  });

  it("returns null (not throw) for a malformed payload", () => {
    const malformed = { results: "not-an-array" };
    expect(validateKbResult(malformed)).toBeNull();
  });

  it("returns null for non-object input (defensive — JSON.parse garbage)", () => {
    expect(validateKbResult(null)).toBeNull();
    expect(validateKbResult(undefined)).toBeNull();
    expect(validateKbResult("string")).toBeNull();
    expect(validateKbResult(42)).toBeNull();
  });
});

// ─── Fix #2 — toolNames type safety ────────────────────────────────────────

describe("Fix #2 — toolNames type safety", () => {
  it("TOOL_NAMES includes every backend tool name", () => {
    // Cross-reference: artifacts/api-server/src/lib/aiTools.ts executeTool switch.
    // If a tool is added/removed there, this test catches it.
    expect(TOOL_NAMES).toContain("search_catalog");
    expect(TOOL_NAMES).toContain("get_product_care");
    expect(TOOL_NAMES).toContain("get_user_orders");
    expect(TOOL_NAMES).toContain("get_order_details");
    expect(TOOL_NAMES).toContain("search_knowledge_base");
    expect(TOOL_NAMES).toContain("search_seller_listings");
    expect(TOOL_NAMES).toHaveLength(6);
  });

  it("isToolName narrows known names + rejects unknown", () => {
    expect(isToolName("get_order_details")).toBe(true);
    expect(isToolName("search_catalog")).toBe(true);

    // Typo — missing 's' — would compile with `string` but is rejected.
    expect(isToolName("get_order_detail")).toBe(false);

    // Future tool we haven't added to TOOL_NAMES yet.
    expect(isToolName("future_tool_name")).toBe(false);

    // Empty / weird inputs.
    expect(isToolName("")).toBe(false);
  });

  it("TOOL_NAMES values are unique (no duplicate entries)", () => {
    const set = new Set(TOOL_NAMES);
    expect(set.size).toBe(TOOL_NAMES.length);
  });
});

// ─── Compile-time test: the typed maps reject bad keys ────────────────────
//
// This is a type-level test — uncomment the lines below to confirm that
// TypeScript rejects them at compile time. They're commented out so the
// test file compiles + runs; if you want to verify the type-safety, paste
// them into a .ts file and run `tsc --noEmit`.
//
// import type { ToolName } from "./toolNames";
//
// // ❌ Should fail: typo'd tool name
// const bad: Record<ToolName, string> = {
//   get_order_detail: "x", // missing 's'
//   get_user_orders: "x",
//   search_seller_listings: "x",
//   get_product_care: "x",
//   search_knowledge_base: "x",
//   search_catalog: "x",
// };
//
// // ❌ Should fail: missing entry (every ToolName must be present)
// const incomplete: Record<ToolName, string> = {
//   get_order_details: "x",
//   // missing the other 5 tools
// };
