/**
 * heightUtils.test.ts — unit tests for the frontend height-parsing helpers.
 *
 * Mirrors the backend `parseHeightToMaxValue` tests in
 * `api-server/test/sellerListingSearch.test.ts`. The two test files MUST
 * stay in sync — if a height string parses one way on the backend, it
 * must parse the same way on the frontend (the helpers are duplicated,
 * not shared — see heightUtils.ts header comment for the rationale).
 *
 * Run with: pnpm --filter @workspace/tree-friend exec vitest run test/heightUtils.test.ts
 * (or: pnpm vitest run heightUtils.test.ts from the tree-friend directory)
 *
 * If vitest isn't configured for tree-friend yet (no vitest.config.ts in
 * this package), the tests still pass typecheck (tsc) — they serve as
 * living documentation + will execute as soon as a runner is added.
 */
import { describe, it, expect } from "vitest";
import {
  parseHeightToMaxValue,
  computeMaxHeight,
  pickLargestListing,
} from "../src/components/ai/tool-ui/heightUtils";
import type { ListingData } from "../src/components/ai/tool-ui/schemas";

// ─── Test fixtures ──────────────────────────────────────────────────────────
//
// Minimal ListingData shapes — only the fields the height-parsing helpers
// touch (variants[].height + identifier fields used in assertions). The
// other fields are stubbed with null/false to satisfy the type.

function makeListing(
  id: number,
  productName: string,
  variants: { height: string | null }[],
  minPrice: number | null = null,
): ListingData {
  return {
    listingId: id,
    productId: id,
    productName,
    productSlug: `slug-${id}`,
    sellerId: id,
    sellerName: `Seller ${id}`,
    sellerLocation: null,
    sellerIsVerified: false,
    rating: 0,
    reviewCount: 0,
    deliveryTimeDays: null,
    warrantyDays: null,
    paymentMethod: "cod",
    certification: null,
    productImage: null,
    variants: variants.map((v, i) => ({
      variantId: i + 1,
      form: null,
      rootType: null,
      potSize: null,
      age: null,
      height: v.height,
      condition: null,
      price: 100,
      discountPrice: null,
      availableQuantity: 1,
      deliveryCharge: 0,
      isPreOrder: false,
    })),
    hasInStockVariant: true,
    hasPreOrderVariant: false,
    minPrice,
  };
}

// ─── parseHeightToMaxValue ──────────────────────────────────────────────────

describe("parseHeightToMaxValue: range form", () => {
  it("parses '4-6 ft' as the upper bound (6)", () => {
    expect(parseHeightToMaxValue("4-6 ft")).toBe(6);
    expect(parseHeightToMaxValue("1-3 ft")).toBe(3);
    expect(parseHeightToMaxValue("8-12 m")).toBe(12);
  });

  it("parses range form with en-dash and em-dash separators", () => {
    expect(parseHeightToMaxValue("4–6 ft")).toBe(6); // en-dash
    expect(parseHeightToMaxValue("4—6 ft")).toBe(6); // em-dash
  });
});

describe("parseHeightToMaxValue: single value form", () => {
  it("parses '3 ft' as 3", () => {
    expect(parseHeightToMaxValue("3 ft")).toBe(3);
    expect(parseHeightToMaxValue("12 m")).toBe(12);
    expect(parseHeightToMaxValue("5")).toBe(5);
  });
});

describe("parseHeightToMaxValue: decimal values", () => {
  it("parses decimal range + single values", () => {
    expect(parseHeightToMaxValue("1.5-2.5 ft")).toBe(2.5);
    expect(parseHeightToMaxValue("2.5 ft")).toBe(2.5);
  });
});

describe("parseHeightToMaxValue: word-form markers", () => {
  it("treats 'mature' as the maximum (999) so it always ranks first", () => {
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
});

describe("parseHeightToMaxValue: null/undefined/empty/unparseable", () => {
  it("returns 0 for null/undefined/empty/unparseable strings", () => {
    expect(parseHeightToMaxValue(null)).toBe(0);
    expect(parseHeightToMaxValue(undefined)).toBe(0);
    expect(parseHeightToMaxValue("")).toBe(0);
    expect(parseHeightToMaxValue("   ")).toBe(0);
    expect(parseHeightToMaxValue("unknown")).toBe(0);
  });
});

describe("parseHeightToMaxValue: case-insensitive", () => {
  it("handles uppercase + mixed case", () => {
    expect(parseHeightToMaxValue("4-6 FT")).toBe(6);
    expect(parseHeightToMaxValue("Mature")).toBe(999);
    expect(parseHeightToMaxValue("SAPLING")).toBe(1);
  });
});

// ─── computeMaxHeight ───────────────────────────────────────────────────────

describe("computeMaxHeight: per-listing max", () => {
  it("returns 0 for a listing with no variants", () => {
    const listing = makeListing(1, "Test", []);
    expect(computeMaxHeight(listing)).toBe(0);
  });

  it("returns the max height across all variants", () => {
    const listing = makeListing(1, "Test", [
      { height: "1-3 ft" }, // 3
      { height: "4-6 ft" }, // 6
      { height: "2 ft" }, // 2
    ]);
    expect(computeMaxHeight(listing)).toBe(6);
  });

  it("returns 0 when all variants have null/unparseable height", () => {
    const listing = makeListing(1, "Test", [
      { height: null },
      { height: "" },
      { height: "unknown" },
    ]);
    expect(computeMaxHeight(listing)).toBe(0);
  });

  it("treats 'mature' variants as the largest", () => {
    const listing = makeListing(1, "Test", [
      { height: "4-6 ft" }, // 6
      { height: "mature" }, // 999
      { height: "1-3 ft" }, // 3
    ]);
    expect(computeMaxHeight(listing)).toBe(999);
  });
});

// ─── pickLargestListing ─────────────────────────────────────────────────────

describe("pickLargestListing", () => {
  it("returns null for an empty list", () => {
    expect(pickLargestListing([])).toBeNull();
  });

  it("picks the listing with the largest max-height variant", () => {
    const small = makeListing(1, "Small Mango", [{ height: "1-3 ft" }]); // 3
    const large = makeListing(2, "Large Mango", [{ height: "4-6 ft" }]); // 6
    const medium = makeListing(3, "Medium Mango", [{ height: "2-4 ft" }]); // 4
    const result = pickLargestListing([small, large, medium]);
    expect(result?.listingId).toBe(2);
    expect(result?.productName).toBe("Large Mango");
  });

  it("returns the first listing when all have the same max-height (stable sort)", () => {
    const a = makeListing(1, "A", [{ height: "4-6 ft" }]);
    const b = makeListing(2, "B", [{ height: "4-6 ft" }]);
    const c = makeListing(3, "C", [{ height: "4-6 ft" }]);
    const result = pickLargestListing([a, b, c]);
    // First wins on tie — preserves the search's own ranking (text-relevance +
    // in-stock + distance) when maturity is equal.
    expect(result?.listingId).toBe(1);
  });

  it("falls back to first listing when no listing has a parseable height", () => {
    const a = makeListing(1, "A", [{ height: null }]);
    const b = makeListing(2, "B", [{ height: "" }]);
    const c = makeListing(3, "C", [{ height: "unknown" }]);
    const result = pickLargestListing([a, b, c]);
    // All heights parse to 0; the loop's first iteration set `best` to A
    // (because 0 > -1). Acceptable — the callout still renders SOME
    // listing, the grid below shows the actual variants.
    expect(result?.listingId).toBe(1);
  });

  it("ranks 'mature' variants above any numeric height", () => {
    const numeric = makeListing(1, "Numeric", [{ height: "8-12 ft" }]); // 12
    const mature = makeListing(2, "Mature", [{ height: "mature" }]); // 999
    const result = pickLargestListing([numeric, mature]);
    expect(result?.listingId).toBe(2);
  });

  it("handles multiple variants per listing — uses the MAX across variants", () => {
    const multiSmallLarge = makeListing(1, "Multi", [
      { height: "1-3 ft" }, // 3
      { height: "4-6 ft" }, // 6
      { height: "2 ft" }, // 2
    ]); // max = 6
    const singleMedium = makeListing(2, "Single", [{ height: "3-4 ft" }]); // 4
    const result = pickLargestListing([singleMedium, multiSmallLarge]);
    expect(result?.listingId).toBe(1); // 6 > 4
  });
});
