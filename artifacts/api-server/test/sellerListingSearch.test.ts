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
      // v6.2 Part 4 (Bug 1 fix): new required field. NULL when both the
      // seller-listing and product image arrays are empty.
      productImage: null,
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
    const path = await import("node:path");
    // v6.2 Part 4: replaced hardcoded absolute path with a repo-relative
    // resolve so the test runs in any checkout location (CI, fresh clone,
    // different developer machine). Previously the test hardcoded
    // `${REPO_ROOT}/...` which only worked on
    // one developer's machine.
    const source = fs.readFileSync(path.resolve(__dirname, "../src/lib/aiTools.ts"), "utf8");
    // The switch must include a case for search_seller_listings that calls
    // searchSellerListings with the right arg-mapping.
    expect(source).toContain('case "search_seller_listings":');
    expect(source).toContain("searchSellerListings(");
    // Must pass userCity + userDistrict from the context.
    expect(source).toContain("context?.userCity");
    expect(source).toContain("context?.userDistrict");
  });
});

describe("ACTIVE_LISTING_FILTER (v6.1 bug fix verification)", () => {
  it("sellerListingSearch.ts uses the canonical filter (no deleted_at, no is_active)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    // v6.2 Part 4: same path-portability fix as above.
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/sellerListingSearch.ts"),
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

// ─── v6.2 Part 16: sort_by tests (industry-standard premium-intent support) ──

import {
  searchSellerListingsArgsSchema,
  listingSearchResultSchema,
} from "../src/lib/aiToolSchemas";
import { parseHeightToMaxValue } from "../src/lib/sellerListingSearch";

describe("sort_by: input args schema (v6.2 Part 16)", () => {
  it("accepts sort_by with all 4 enum values", () => {
    for (const v of ["price_asc", "price_desc", "maturity_desc", "rating_desc"] as const) {
      const parsed = searchSellerListingsArgsSchema.safeParse({ query: "mango", sort_by: v });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.sort_by).toBe(v);
      }
    }
  });

  it("accepts sort_by as optional (omitted = undefined, defaults to price_asc on backend)", () => {
    const parsed = searchSellerListingsArgsSchema.safeParse({ query: "mango" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sort_by).toBeUndefined();
    }
  });

  it("rejects sort_by with an invalid enum value", () => {
    // @ts-expect-error — intentionally invalid value for runtime test
    const parsed = searchSellerListingsArgsSchema.safeParse({
      query: "mango",
      sort_by: "invalid_value",
    });
    expect(parsed.success).toBe(false);
  });

  it("preserves other args alongside sort_by (passthrough)", () => {
    const parsed = searchSellerListingsArgsSchema.safeParse({
      query: "grafted mango",
      max_price: 1000,
      form: "grafted",
      limit: 5,
      care_summary: true,
      sort_by: "maturity_desc",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sort_by).toBe("maturity_desc");
      expect(parsed.data.max_price).toBe(1000);
      expect(parsed.data.form).toBe("grafted");
    }
  });
});

describe("sort_by: output result schema echoes back (v6.2 Part 16)", () => {
  it("listingSearchResultSchema accepts sortBy in the result envelope", () => {
    const parsed = listingSearchResultSchema.safeParse({
      listings: [],
      totalCount: 0,
      query: "mango",
      sortBy: "maturity_desc",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sortBy).toBe("maturity_desc");
    }
  });

  it("listingSearchResultSchema accepts undefined sortBy (default price_asc path)", () => {
    const parsed = listingSearchResultSchema.safeParse({
      listings: [],
      totalCount: 0,
      query: "mango",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sortBy).toBeUndefined();
    }
  });

  it("listingSearchResultSchema rejects invalid sortBy in the result envelope", () => {
    // @ts-expect-error — intentionally invalid
    const parsed = listingSearchResultSchema.safeParse({
      listings: [],
      totalCount: 0,
      query: "mango",
      sortBy: "INVALID",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("sort_by: LLM-visible tool declaration (v6.2 Part 16)", () => {
  it("declares sort_by as an optional parameter of search_seller_listings", () => {
    const tool = AI_TOOL_DECLARATIONS.find((t) => t.name === "search_seller_listings");
    expect(tool).toBeDefined();
    // The type is Type.STRING from @google/genai which serializes to "STRING"
    // (uppercase). The other params use the same enum.
    const props = tool!.parameters!.properties as Record<
      string,
      { type: string; description: string }
    >;
    expect(props.sort_by).toBeDefined();
    expect(props.sort_by.type).toBe("STRING");
  });

  it("sort_by description explains when to use each value (LLM picks, not keyword classifier)", () => {
    const tool = AI_TOOL_DECLARATIONS.find((t) => t.name === "search_seller_listings");
    const desc = (tool!.parameters!.properties as Record<string, { description: string }>).sort_by
      .description;
    // Must mention the 4 enum values so the LLM knows its options.
    expect(desc).toContain("price_asc");
    expect(desc).toContain("price_desc");
    expect(desc).toContain("maturity_desc");
    expect(desc).toContain("rating_desc");
    // Must include the canonical premium-intent trigger phrases so the
    // LLM maps them to maturity_desc (the user's exact screenshot).
    expect(desc).toContain("i dont care about price");
    expect(desc).toContain("most mature");
    expect(desc).toContain("best quality");
    // Must mention that the value is echoed back (single source of truth).
    expect(desc).toContain("echoed back");
  });

  it("sort_by is NOT in the required list (omitting defaults to price_asc)", () => {
    const tool = AI_TOOL_DECLARATIONS.find((t) => t.name === "search_seller_listings");
    expect(tool!.parameters!.required).toEqual(["query"]);
  });
});

describe("parseHeightToMaxValue: height-string parser (v6.2 Part 16)", () => {
  it("parses range form '4-6 ft' as the upper bound (6)", () => {
    expect(parseHeightToMaxValue("4-6 ft")).toBe(6);
    expect(parseHeightToMaxValue("1-3 ft")).toBe(3);
    expect(parseHeightToMaxValue("8-12 m")).toBe(12);
  });

  it("parses range form with en-dash and em-dash separators", () => {
    // Different dash variants the data might contain.
    expect(parseHeightToMaxValue("4–6 ft")).toBe(6); // en-dash
    expect(parseHeightToMaxValue("4—6 ft")).toBe(6); // em-dash
  });

  it("parses single value form '3 ft' as 3", () => {
    expect(parseHeightToMaxValue("3 ft")).toBe(3);
    expect(parseHeightToMaxValue("12 m")).toBe(12);
    expect(parseHeightToMaxValue("5")).toBe(5);
  });

  it("parses decimal values", () => {
    expect(parseHeightToMaxValue("1.5-2.5 ft")).toBe(2.5);
    expect(parseHeightToMaxValue("2.5 ft")).toBe(2.5);
  });

  it("treats 'mature' word-form as the maximum (999) so it always ranks first", () => {
    expect(parseHeightToMaxValue("mature")).toBe(999);
    expect(parseHeightToMaxValue("Mature tree")).toBe(999);
    expect(parseHeightToMaxValue("MATURE")).toBe(999);
  });

  it("treats 'sapling' as 1 (smallest form, ranks below any numeric height)", () => {
    expect(parseHeightToMaxValue("sapling")).toBe(1);
    expect(parseHeightToMaxValue("Sapling")).toBe(1);
  });

  it("treats 'seed' as 0.5 (smaller than sapling)", () => {
    expect(parseHeightToMaxValue("seed")).toBe(0.5);
  });

  it("returns 0 for null/undefined/empty/unparseable strings", () => {
    expect(parseHeightToMaxValue(null)).toBe(0);
    expect(parseHeightToMaxValue(undefined)).toBe(0);
    expect(parseHeightToMaxValue("")).toBe(0);
    expect(parseHeightToMaxValue("   ")).toBe(0);
    expect(parseHeightToMaxValue("unknown")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(parseHeightToMaxValue("4-6 FT")).toBe(6);
    expect(parseHeightToMaxValue("Mature")).toBe(999);
    expect(parseHeightToMaxValue("SAPLING")).toBe(1);
  });
});

describe("rankListings: weight matrix per sortBy (v6.2 Part 16, source-shape)", () => {
  // rankListings is not exported (it's an internal function called by
  // searchSellerListings). We verify the weight matrix is present in
  // the source so the LLM's sort_by decision actually changes ranking
  // behavior. Without this matrix, sort_by would be silently ignored.

  it("rankListings function accepts a sortBy parameter", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/sellerListingSearch.ts"),
      "utf8",
    );
    // The function signature must include sortBy.
    expect(source).toMatch(/function rankListings\([\s\S]*?sortBy[\s\S]*?\)/);
  });

  it("rankListings has a weight-matrix switch covering all 4 sortBy values", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/sellerListingSearch.ts"),
      "utf8",
    );
    // Each sortBy branch must be present in the switch.
    // We check the case labels are inside the rankListings function
    // (between the function signature and the closing brace).
    const rankStart = source.indexOf("function rankListings");
    expect(rankStart).toBeGreaterThan(-1);
    const rankSlice = source.slice(
      rankStart,
      source.indexOf("}", source.indexOf("return scored.map", rankStart)) + 1,
    );
    expect(rankSlice).toContain('case "price_desc"');
    expect(rankSlice).toContain('case "maturity_desc"');
    expect(rankSlice).toContain('case "rating_desc"');
    expect(rankSlice).toContain('case "price_asc"');
  });

  it("maturity_desc branch sets price weight to 0 + maturity weight to 0.4", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/sellerListingSearch.ts"),
      "utf8",
    );
    // The maturity_desc case must zero out price + activate maturity.
    const maturityCaseIdx = source.indexOf('case "maturity_desc"');
    expect(maturityCaseIdx).toBeGreaterThan(-1);
    const slice = source.slice(maturityCaseIdx, maturityCaseIdx + 400);
    expect(slice).toMatch(/price:\s*0/);
    expect(slice).toMatch(/maturity:\s*DEFAULT_PRICE_WEIGHT/);
  });

  it("rating_desc branch boosts rating weight from 0.3 to 0.7", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/sellerListingSearch.ts"),
      "utf8",
    );
    const ratingCaseIdx = source.indexOf('case "rating_desc"');
    expect(ratingCaseIdx).toBeGreaterThan(-1);
    const slice = source.slice(ratingCaseIdx, ratingCaseIdx + 400);
    expect(slice).toMatch(/rating:\s*0\.7/);
    expect(slice).toMatch(/price:\s*0/);
  });

  it("price_desc branch inverts the price direction (priceInverted: false)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/sellerListingSearch.ts"),
      "utf8",
    );
    const priceDescCaseIdx = source.indexOf('case "price_desc"');
    expect(priceDescCaseIdx).toBeGreaterThan(-1);
    const slice = source.slice(priceDescCaseIdx, priceDescCaseIdx + 400);
    expect(slice).toMatch(/priceInverted:\s*false/);
  });
});

describe("sort_by: end-to-end plumbing (v6.2 Part 16, source-shape)", () => {
  it("executeTool passes sort_by from v.args to searchSellerListings call", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.resolve(__dirname, "../src/lib/aiTools.ts"), "utf8");
    // The executeTool switch case for search_seller_listings must pass
    // sort_by from the LLM-generated args to the searchSellerListings call.
    const caseIdx = source.indexOf('case "search_seller_listings"');
    expect(caseIdx).toBeGreaterThan(-1);
    const caseEnd = source.indexOf("break;", caseIdx);
    const caseSlice = source.slice(caseIdx, caseEnd);
    expect(caseSlice).toContain("sortBy: v.args.sort_by");
  });

  it("searchSellerListings echoes sortBy back in the success-path return", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/sellerListingSearch.ts"),
      "utf8",
    );
    // The success-path return must include sortBy (echoed back).
    // Look for the return block that includes 'listings: truncated'.
    const returnIdx = source.indexOf("listings: truncated");
    expect(returnIdx).toBeGreaterThan(-1);
    const returnSlice = source.slice(returnIdx, returnIdx + 400);
    expect(returnSlice).toContain("sortBy,");
  });
});

// ─── v1.8.0 (Part 17): deterministic filter args tests ─────────────────────

describe("v1.8.0: input args schema accepts the 5 new filter args", () => {
  it("accepts max_height (positive number)", () => {
    const parsed = searchSellerListingsArgsSchema.safeParse({
      query: "mango",
      max_height: 6,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.max_height).toBe(6);
    }
  });

  it("rejects max_height <= 0 (must be positive)", () => {
    const parsed = searchSellerListingsArgsSchema.safeParse({
      query: "mango",
      max_height: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts bloom_season (non-empty string)", () => {
    const parsed = searchSellerListingsArgsSchema.safeParse({
      query: "mango",
      bloom_season: "winter",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.bloom_season).toBe("winter");
    }
  });

  it("rejects empty bloom_season", () => {
    const parsed = searchSellerListingsArgsSchema.safeParse({
      query: "mango",
      bloom_season: "",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts min_rating (0-5 range)", () => {
    for (const v of [0, 0.5, 1, 2.5, 4, 4.5, 5]) {
      const parsed = searchSellerListingsArgsSchema.safeParse({
        query: "mango",
        min_rating: v,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.min_rating).toBe(v);
      }
    }
  });

  it("rejects min_rating > 5 (out of range)", () => {
    const parsed = searchSellerListingsArgsSchema.safeParse({
      query: "mango",
      min_rating: 5.5,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts max_delivery_days (positive integer)", () => {
    const parsed = searchSellerListingsArgsSchema.safeParse({
      query: "mango",
      max_delivery_days: 3,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.max_delivery_days).toBe(3);
    }
  });

  it("rejects max_delivery_days = 0 (must be positive)", () => {
    const parsed = searchSellerListingsArgsSchema.safeParse({
      query: "mango",
      max_delivery_days: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts distinct_products (boolean)", () => {
    const parsed = searchSellerListingsArgsSchema.safeParse({
      query: "mango",
      distinct_products: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.distinct_products).toBe(true);
    }
  });

  it("composes all 5 new args + the existing args (passthrough)", () => {
    const parsed = searchSellerListingsArgsSchema.safeParse({
      query: "grafted mango",
      max_price: 500,
      form: "grafted",
      limit: 3,
      sort_by: "maturity_desc",
      max_height: 6,
      bloom_season: "winter",
      min_rating: 4.0,
      max_delivery_days: 5,
      distinct_products: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.max_height).toBe(6);
      expect(parsed.data.bloom_season).toBe("winter");
      expect(parsed.data.min_rating).toBe(4.0);
      expect(parsed.data.max_delivery_days).toBe(5);
      expect(parsed.data.distinct_products).toBe(true);
    }
  });
});

describe("v1.8.0: LLM-visible tool declaration includes the 5 new args", () => {
  it("declares max_height as an optional NUMBER parameter", () => {
    const tool = AI_TOOL_DECLARATIONS.find((t) => t.name === "search_seller_listings");
    const props = tool!.parameters!.properties as Record<
      string,
      { type: string; description: string }
    >;
    expect(props.max_height).toBeDefined();
    expect(props.max_height.type).toBe("NUMBER");
    expect(props.max_height.description).toContain("max height variant");
    expect(props.max_height.description).toContain("under 6 ft");
  });

  it("declares bloom_season as an optional STRING parameter", () => {
    const tool = AI_TOOL_DECLARATIONS.find((t) => t.name === "search_seller_listings");
    const props = tool!.parameters!.properties as Record<
      string,
      { type: string; description: string }
    >;
    expect(props.bloom_season).toBeDefined();
    expect(props.bloom_season.type).toBe("STRING");
    expect(props.bloom_season.description).toContain("fruits in winter");
    expect(props.bloom_season.description).toContain("ILIKE");
  });

  it("declares min_rating as an optional NUMBER parameter", () => {
    const tool = AI_TOOL_DECLARATIONS.find((t) => t.name === "search_seller_listings");
    const props = tool!.parameters!.properties as Record<
      string,
      { type: string; description: string }
    >;
    expect(props.min_rating).toBeDefined();
    expect(props.min_rating.type).toBe("NUMBER");
    expect(props.min_rating.description).toContain("4.5+");
  });

  it("declares max_delivery_days as an optional NUMBER parameter", () => {
    const tool = AI_TOOL_DECLARATIONS.find((t) => t.name === "search_seller_listings");
    const props = tool!.parameters!.properties as Record<
      string,
      { type: string; description: string }
    >;
    expect(props.max_delivery_days).toBeDefined();
    expect(props.max_delivery_days.type).toBe("NUMBER");
    expect(props.max_delivery_days.description).toContain("delivered within 3");
  });

  it("declares distinct_products as an optional BOOLEAN parameter", () => {
    const tool = AI_TOOL_DECLARATIONS.find((t) => t.name === "search_seller_listings");
    const props = tool!.parameters!.properties as Record<
      string,
      { type: string; description: string }
    >;
    expect(props.distinct_products).toBeDefined();
    expect(props.distinct_products.type).toBe("BOOLEAN");
    expect(props.distinct_products.description).toContain("different varieties");
  });

  it("still only requires `query` (the 5 new args are all optional)", () => {
    const tool = AI_TOOL_DECLARATIONS.find((t) => t.name === "search_seller_listings");
    expect(tool!.parameters!.required).toEqual(["query"]);
  });
});

describe("v1.8.0: SQL filter clauses + post-SQL filters (source-shape)", () => {
  it("sellerListingSearch.ts builds bloomSeasonFilter when bloomSeason is set", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/sellerListingSearch.ts"),
      "utf8",
    );
    expect(source).toContain("bloomSeasonFilter");
    expect(source).toContain("product_bloom_season IS NOT NULL");
    expect(source).toContain("LIKE");
  });

  it("sellerListingSearch.ts builds minRatingFilter when minRating is set", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/sellerListingSearch.ts"),
      "utf8",
    );
    expect(source).toContain("minRatingFilter");
    expect(source).toContain("AVG(r.rating)");
  });

  it("sellerListingSearch.ts builds maxDeliveryDaysFilter when maxDeliveryDays is set", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/sellerListingSearch.ts"),
      "utf8",
    );
    expect(source).toContain("maxDeliveryDaysFilter");
    expect(source).toContain("sl.delivery_time_days IS NOT NULL");
  });

  it("sellerListingSearch.ts applies maxHeight post-SQL via computeMaxHeight", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/sellerListingSearch.ts"),
      "utf8",
    );
    expect(source).toContain("if (maxHeight !== undefined && maxHeight !== null)");
    expect(source).toContain("computeMaxHeight(l) <= maxHeight");
  });

  it("sellerListingSearch.ts applies distinctProducts post-SQL via productName dedup", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/sellerListingSearch.ts"),
      "utf8",
    );
    expect(source).toContain("if (distinctProducts)");
    expect(source).toContain("seen.has(l.productName)");
  });

  it("SQL query selects p.bloom_season AS product_bloom_season in candidate_products CTE", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/sellerListingSearch.ts"),
      "utf8",
    );
    expect(source).toContain("p.bloom_season AS product_bloom_season");
  });

  it("executeTool passes the 5 new args from v.args to searchSellerListings", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.resolve(__dirname, "../src/lib/aiTools.ts"), "utf8");
    const caseIdx = source.indexOf('case "search_seller_listings"');
    expect(caseIdx).toBeGreaterThan(-1);
    const caseEnd = source.indexOf("break;", caseIdx);
    const caseSlice = source.slice(caseIdx, caseEnd);
    expect(caseSlice).toContain("maxHeight: v.args.max_height");
    expect(caseSlice).toContain("bloomSeason: v.args.bloom_season");
    expect(caseSlice).toContain("minRating: v.args.min_rating");
    expect(caseSlice).toContain("maxDeliveryDays: v.args.max_delivery_days");
    expect(caseSlice).toContain("distinctProducts: v.args.distinct_products");
  });
});
