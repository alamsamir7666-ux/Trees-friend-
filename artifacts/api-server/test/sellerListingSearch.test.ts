/**
 * Tests for the search_seller_listings tool (v6.1 Part 2).
 *
 * Source-shape tests (no DB required) verifying:
 *   - The tool is declared in AI_TOOL_DECLARATIONS with the right name.
 *   - The tool is in the CATALOG_TOOLS set (for cache policy).
 *   - The tool is in the TOOL_TIERS map with tier="catalog" (for rate
 *     limiting).
 *   - The sellerListingSearch module exports the expected interface.
 *   - The executeTool switch routes "search_seller_listings" to the
 *     searchSellerListings function with the right arg-mapping.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/sellerListingSearch.test.ts
 */
import { describe, it, expect } from "vitest";

// Ensure the AI_SESSION_SECRET is set (required by sessionToken.ts which is
// transitively imported). setupEnv.ts handles this for the rest of the suite.
process.env.AI_SESSION_SECRET ??= "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";

import { AI_TOOL_DECLARATIONS, CATALOG_TOOLS, type ToolContext } from "../src/lib/aiTools";
import { TOOL_TIERS } from "../src/lib/toolRateLimiter";
import {
  searchSellerListings,
  type SellerListingSearchResult,
  type SellerListingResult,
  type SellerListingVariantResult,
} from "../src/lib/sellerListingSearch";

describe("search_seller_listings tool declaration (v6.1)", () => {
  it("is declared in AI_TOOL_DECLARATIONS", () => {
    const tool = AI_TOOL_DECLARATIONS.find((t) => t.name === "search_seller_listings");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("search_seller_listings");
    expect(tool!.description).toContain("BUY");
    expect(tool!.description).toContain("[[listing:<id>|<display>]]");
  });

  it("declares the expected parameters (query required, others optional)", () => {
    const tool = AI_TOOL_DECLARATIONS.find((t) => t.name === "search_seller_listings");
    expect(tool).toBeDefined();
    const params = tool!.parameters!;
    // query is required.
    expect(params.required).toEqual(["query"]);
    // Optional params: max_price, form, limit.
    const props = params.properties as Record<string, { type: string }>;
    expect(props.query).toBeDefined();
    expect(props.max_price).toBeDefined();
    expect(props.form).toBeDefined();
    expect(props.limit).toBeDefined();
  });

  it("is in CATALOG_TOOLS set (5-min cache TTL, not user-scoped)", () => {
    // Critical: the tool must NOT be in USER_SCOPED_TOOLS (its results are
    // public — listings + variants + sellers are all visible on the marketplace).
    expect(CATALOG_TOOLS.has("search_seller_listings")).toBe(true);
  });

  it("is in TOOL_TIERS map with tier=catalog (60 calls/hour)", () => {
    expect(TOOL_TIERS["search_seller_listings"]).toBe("catalog");
  });
});

describe("sellerListingSearch module interface", () => {
  it("exports the searchSellerListings function", () => {
    expect(typeof searchSellerListings).toBe("function");
  });

  it("exports the expected types (compile-time check via type assertion)", () => {
    // Type-only — verifies the interfaces are exported + have the right shape.
    const _result: SellerListingSearchResult = {
      listings: [],
      totalCount: 0,
      query: "test",
      buyerCity: null,
      buyerDistrict: null,
    };
    const _listing: SellerListingResult = {
      listingId: 1,
      productId: 1,
      productName: "Test",
      productSlug: "test",
      sellerId: 1,
      sellerName: "Test Seller",
      sellerLocation: null,
      sellerIsVerified: false,
      rating: 0,
      reviewCount: 0,
      deliveryTimeDays: null,
      warrantyDays: null,
      paymentMethod: "cod",
      certification: null,
      variants: [],
      hasInStockVariant: false,
      hasPreOrderVariant: false,
      minPrice: null,
    };
    const _variant: SellerListingVariantResult = {
      variantId: 1,
      form: "sapling",
      rootType: null,
      potSize: null,
      age: null,
      height: "3ft",
      condition: null,
      price: 450,
      discountPrice: null,
      availableQuantity: 10,
      deliveryCharge: 50,
      isPreOrder: false,
    };
    // Use the variables to avoid unused-var lint.
    expect(_result.listings).toEqual([]);
    expect(_listing.listingId).toBe(1);
    expect(_variant.variantId).toBe(1);
  });
});

describe("searchSellerListings: input validation + fail-safe", () => {
  it("returns error result for empty query", async () => {
    const result = await searchSellerListings({ query: "" });
    expect(result.listings).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.error).toBe("empty query");
  });

  it("returns error result for whitespace-only query", async () => {
    const result = await searchSellerListings({ query: "   " });
    expect(result.listings).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.error).toBe("empty query");
  });

  it("returns error result for query with all-too-short tokens", async () => {
    // Single 1-char token → no searchable tokens.
    const result = await searchSellerListings({ query: "a" });
    expect(result.listings).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.error).toContain("no searchable tokens");
  });

  it("propagates buyer city + district to the result (for transparency)", async () => {
    // We can't test the actual SQL without a DB, but we can verify the
    // buyer location is preserved in the result (for the LLM to see).
    const result = await searchSellerListings({
      query: "a", // will fail at the token step
      userCity: "Dhaka",
      userDistrict: "Dhaka",
    });
    expect(result.buyerCity).toBe("Dhaka");
    expect(result.buyerDistrict).toBe("Dhaka");
  });
});

describe("ToolContext: v6.1 userCity/userDistrict fields", () => {
  it("ToolContext interface accepts userCity + userDistrict", () => {
    // Type-only check — verifies the interface was extended.
    const ctx: ToolContext = {
      toneLockedCreatorId: null,
      toneLockedCreatorName: null,
      userCity: "Dhaka",
      userDistrict: "Dhaka",
    };
    expect(ctx.userCity).toBe("Dhaka");
    expect(ctx.userDistrict).toBe("Dhaka");
  });

  it("ToolContext accepts null/undefined for userCity/userDistrict (anonymous users)", () => {
    const ctx: ToolContext = {
      toneLockedCreatorId: null,
      toneLockedCreatorName: null,
      userCity: null,
      userDistrict: null,
    };
    expect(ctx.userCity).toBeNull();
    expect(ctx.userDistrict).toBeNull();
  });
});

describe("executeTool: search_seller_listings routing (source-shape)", () => {
  it("the executeTool switch includes a case for search_seller_listings", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/repos/Trees-friend-/artifacts/api-server/src/lib/aiTools.ts",
      "utf8",
    );
    // The switch must include a case for search_seller_listings that calls
    // searchSellerListings with the right arg-mapping.
    expect(source).toContain('case "search_seller_listings":');
    expect(source).toContain("return await searchSellerListings(");
    // Must pass userCity + userDistrict from the context.
    expect(source).toContain("context?.userCity");
    expect(source).toContain("context?.userDistrict");
  });
});

describe("ACTIVE_LISTING_FILTER (v6.1 bug fix verification)", () => {
  it("sellerListingSearch.ts uses the canonical filter (no deleted_at, no is_active)", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/repos/Trees-friend-/artifacts/api-server/src/lib/sellerListingSearch.ts",
      "utf8",
    );
    // The new module must use the canonical buyer-facing filter (visibility
    // + approval_status + seller status=active), NOT the buggy deleted_at
    // or is_active references.
    expect(source).toContain("sl.visibility = 'public'");
    expect(source).toContain("sl.approval_status = 'approved'");
    expect(source).toContain("s.status = 'active'");
    // The variant filter must include in-stock OR pre-order (per the
    // user's decision in question 6).
    expect(source).toContain("slv.available_quantity > 0 OR slv.is_pre_order = true");
    // Must NOT reference the non-existent columns.
    expect(source).not.toContain("sl.deleted_at");
    expect(source).not.toContain("sl.is_active");
  });
});
