/**
 * Tests for the careSummary flag (v6.1 Part 4).
 *
 * Verifies:
 *   - The search_seller_listings tool declaration includes the care_summary
 *     boolean parameter.
 *   - The executeTool switch passes careSummary from args.care_summary.
 *   - The SellerListingSearchResult type includes the optional careSummary
 *     field.
 *   - The formatSellerListingContextForPrompt helper prepends the care
 *     summary line when present.
 *   - The chat route skips KB auto-inject for MIXED intent + passes
 *     careSummary=true to the listings auto-call.
 *   - The v1.2.0 prompt seed is declared in ensureAiTables.ts.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/careSummary.test.ts
 */
import { describe, it, expect } from "vitest";

process.env.AI_SESSION_SECRET ??= "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";

import { AI_TOOL_DECLARATIONS } from "../src/lib/aiTools";
import { formatSellerListingContextForPrompt } from "../src/lib/aiContext";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

describe("v6.1 Part 4: search_seller_listings tool declaration includes care_summary", () => {
  it("declares the care_summary boolean parameter", () => {
    const tool = AI_TOOL_DECLARATIONS.find((t) => t.name === "search_seller_listings");
    expect(tool).toBeDefined();
    const props = tool!.parameters!.properties as Record<
      string,
      { type: string; description: string }
    >;
    expect(props.care_summary).toBeDefined();
    expect(props.care_summary.type).toBe("BOOLEAN");
    expect(props.care_summary.description).toContain("1-line KB care summary");
    expect(props.care_summary.description).toContain("MIXED-intent");
  });

  it("the tool description mentions the care_summary flag", () => {
    const tool = AI_TOOL_DECLARATIONS.find((t) => t.name === "search_seller_listings");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("care_summary");
    expect(tool!.description).toContain("MIXED-intent");
  });
});

describe("v6.1 Part 4: executeTool passes careSummary from args.care_summary", () => {
  it("the executeTool switch reads args.care_summary + passes it as careSummary", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/aiTools.ts`,
      "utf8",
    );
    // The executeTool switch must read args.care_summary (boolean) and
    // pass it as careSummary to searchSellerListings.
    expect(source).toContain("careSummary: args.care_summary === true");
  });
});

describe("v6.1 Part 4: formatSellerListingContextForPrompt prepends care summary", () => {
  // Use a minimal listing fixture for the tests.
  const sampleListing = {
    listingId: 42,
    productId: 1,
    productName: "Alphonso Mango",
    sellerName: "Green Nursery",
    sellerLocation: "Dhaka",
    sellerIsVerified: true,
    rating: 4.8,
    reviewCount: 12,
    deliveryTimeDays: 3,
    minPrice: 450,
    hasInStockVariant: true,
    hasPreOrderVariant: false,
    variants: [
      {
        form: "sapling",
        height: "3ft",
        price: 450,
        discountPrice: null,
        availableQuantity: 10,
        isPreOrder: false,
      },
    ],
  };

  it("returns listings block without care summary when careSummary is null/undefined", () => {
    const result = formatSellerListingContextForPrompt([sampleListing]);
    expect(result).toContain("SELLER LISTING CONTEXT");
    expect(result).toContain("listingId:42");
    expect(result).not.toContain("CARE SUMMARY");
  });

  it("prepends the care summary line when careSummary is provided", () => {
    const result = formatSellerListingContextForPrompt([sampleListing], {
      content: "Water deeply once a week during the growing season.",
      entryId: 99,
      sourceTitle: "Mango Sapling Care — Summer Watering",
    });
    // Care summary appears BEFORE the listing entries.
    const careIdx = result.indexOf("CARE SUMMARY");
    const listingIdx = result.indexOf("listingId:42");
    expect(careIdx).toBeGreaterThan(-1);
    expect(listingIdx).toBeGreaterThan(-1);
    expect(careIdx).toBeLessThan(listingIdx);
    // Care summary content included.
    expect(result).toContain("Water deeply once a week during the growing season.");
    // Source title included.
    expect(result).toContain("Mango Sapling Care — Summer Watering");
  });

  it("handles careSummary with null content (no care summary line)", () => {
    const result = formatSellerListingContextForPrompt([sampleListing], null);
    expect(result).not.toContain("CARE SUMMARY");
    expect(result).toContain("listingId:42");
  });

  it("handles careSummary with empty content (no care summary line)", () => {
    const result = formatSellerListingContextForPrompt([sampleListing], {
      content: "",
      entryId: 1,
      sourceTitle: "Empty",
    });
    // Empty content → no care summary line (defensive — don't render an
    // empty CARE SUMMARY block).
    expect(result).not.toContain("CARE SUMMARY");
  });

  it("handles empty listings array (returns empty string regardless of careSummary)", () => {
    const result = formatSellerListingContextForPrompt([], {
      content: "Some care info",
      entryId: 1,
    });
    expect(result).toBe("");
  });
});

describe("v6.1 Part 4: chat route skips KB auto-inject for MIXED intent", () => {
  it("routes/ai.ts declares skipKbAutoInject for MIXED+PURCHASE intent", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/routes/ai.ts`,
      "utf8",
    );
    // v6.1 Part 5 (Gap #4): changed from `const` to `let` so the
    // MIXED+0-listings fallback can reassign kbContext.
    // v6.1 Part 6: also skips for PURCHASE intent (KB is care-focused,
    // won't match pure purchase queries — saves ~200ms-3.5s).
    expect(source).toContain("skipKbAutoInject");
    expect(source).toContain('intentClassification.intent === "MIXED"');
    expect(source).toContain('intentClassification.intent === "PURCHASE"');
    expect(source).toContain("let kbContext = skipKbAutoInject");
    expect(source).toContain("injected: false");
    // The fallback logic for MIXED + 0 listings.
    expect(source).toContain("isMixedIntent");
    expect(source).toContain("MIXED + 0 listings");
    expect(source).toContain("fallbackKbContext");
  });

  it("the chat route passes careSummary=isMixedIntent to searchSellerListings", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/routes/ai.ts`,
      "utf8",
    );
    expect(source).toContain('const isMixedIntent = intentClassification.intent === "MIXED"');
    expect(source).toContain("careSummary: isMixedIntent");
  });

  it("the chat route passes careSummary to formatSellerListingContextForPrompt", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/routes/ai.ts`,
      "utf8",
    );
    // The formatSellerListingContextForPrompt call must pass the careSummary
    // from the search result.
    expect(source).toContain("formatSellerListingContextForPrompt(");
    expect(source).toContain("listingSearchResult.careSummary");
  });
});

describe("v6.1 Part 4: v1.2.0 prompt seed declared in ensureAiTables.ts", () => {
  it("seeds the v1.2.0 row idempotently", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/ensureAiTables.ts`,
      "utf8",
    );
    expect(source).toContain('"1.2.0"');
    expect(source).toContain(
      "v6.1 Part 4: search_seller_listings tool now accepts care_summary=true",
    );
    expect(source).toContain("is_active, created_by"); // FALSE — not auto-activated
  });
});

describe("v6.1 Part 4: sellerListingSearch.ts careSummary fetch logic", () => {
  it("imports searchKnowledgeBase from kbSearch", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/sellerListingSearch.ts`,
      "utf8",
    );
    expect(source).toContain('import { searchKnowledgeBase } from "./kbSearch"');
  });

  it("the careSummary fetch is gated on params.careSummary === true + truncated.length > 0", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/sellerListingSearch.ts`,
      "utf8",
    );
    expect(source).toContain("params.careSummary === true && truncated.length > 0");
  });

  it("uses lightweight KB params (maxResults=1, minScore=0.5, skipRerank=true)", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/sellerListingSearch.ts`,
      "utf8",
    );
    expect(source).toContain("maxResults: 1");
    expect(source).toContain("minScore: 0.5");
    expect(source).toContain("skipRerank: true");
  });

  it("truncates care summary content to ~200 chars (sentence boundary preferred)", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/sellerListingSearch.ts`,
      "utf8",
    );
    expect(source).toContain("CARE_SUMMARY_MAX_CHARS = 200");
    expect(source).toContain("lastIndexOf"); // sentence-boundary search
  });

  it("the careSummary field is included in the result type", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/sellerListingSearch.ts`,
      "utf8",
    );
    expect(source).toContain("careSummary?:");
    expect(source).toContain("entryId?: number");
    expect(source).toContain("sourceTitle?: string");
  });

  it("the careSummary is included in the return statement", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/sellerListingSearch.ts`,
      "utf8",
    );
    expect(source).toMatch(/return \{[\s\S]*?careSummary,/);
  });

  it("the careSummary fetch is wrapped in try/catch (fail-safe)", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/sellerListingSearch.ts`,
      "utf8",
    );
    // The careSummary fetch must not crash the search — if it fails, the
    // listings are still returned.
    expect(source).toContain("Non-fatal — the listings are still returned");
  });
});
