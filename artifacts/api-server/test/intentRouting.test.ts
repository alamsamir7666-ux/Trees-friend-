/**
 * Tests for v6.1 Part 3: intent → tool routing + admin endpoints.
 *
 * Verifies:
 *   - The chat route auto-calls search_seller_listings for PURCHASE/MIXED
 *     intent (source-shape check — no DB needed).
 *   - The renderPromptTemplate supports the new {{listings}} placeholder.
 *   - The formatSellerListingContextForPrompt helper formats listings
 *     correctly with the [[listing:<id>|<display>]] citation hint.
 *   - The intent admin endpoints are declared in aiAdmin.ts.
 *   - The intent metrics SQL queries the ai_chat_events table for the
 *     'intent_classified' event type added in Part 1.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/intentRouting.test.ts
 */
import { describe, it, expect } from "vitest";

process.env.AI_SESSION_SECRET ??= "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";

import {
  renderPromptTemplate,
  buildSystemPrompt,
  formatSellerListingContextForPrompt,
  SYSTEM_PROMPT_TEMPLATE_V1,
} from "../src/lib/aiContext";

describe("v6.1 Part 3: renderPromptTemplate supports {{listings}} placeholder", () => {
  it("replaces {{listings}} placeholder with the listings block", () => {
    const template = "Base prompt.\n{{listings}}\nMore content.";
    const result = renderPromptTemplate(
      template,
      "",
      "catalog context",
      "",
      "",
      "SELLER LISTING CONTEXT:\n- listingId:42",
    );
    expect(result).toContain("SELLER LISTING CONTEXT:");
    expect(result).toContain("listingId:42");
    expect(result).not.toContain("{{listings}}");
  });

  it("inserts listings block before CATALOG CONTEXT when no placeholder", () => {
    const template = "Base prompt.\n\nCATALOG CONTEXT: stuff";
    const result = renderPromptTemplate(
      template,
      "",
      "stuff",
      "",
      "",
      "SELLER LISTING CONTEXT:\n- listingId:42",
    );
    // The listings block should appear BEFORE the CATALOG CONTEXT block.
    const listingsIdx = result.indexOf("SELLER LISTING CONTEXT");
    const catalogIdx = result.indexOf("CATALOG CONTEXT");
    expect(listingsIdx).toBeGreaterThan(-1);
    expect(catalogIdx).toBeGreaterThan(-1);
    expect(listingsIdx).toBeLessThan(catalogIdx);
  });

  it("handles empty listings block (no insertion)", () => {
    const template = "Base prompt.\n{{listings}}\nMore content.";
    const result = renderPromptTemplate(template, "", "catalog", "", "", "");
    expect(result).not.toContain("{{listings}}");
    // No SELLER LISTING CONTEXT block.
    expect(result).not.toContain("SELLER LISTING CONTEXT");
  });
});

describe("v6.1 Part 3: SYSTEM_PROMPT_TEMPLATE_V1 includes {{listings}} placeholder", () => {
  it("the template has all 5 placeholders in the expected order", () => {
    // The placeholders should appear in this order at the end of the template:
    //   {{summary}}{{knowledge}}{{listings}}{{catalog}}{{tone}}
    const summaryIdx = SYSTEM_PROMPT_TEMPLATE_V1.lastIndexOf("{{summary}}");
    const knowledgeIdx = SYSTEM_PROMPT_TEMPLATE_V1.lastIndexOf("{{knowledge}}");
    const listingsIdx = SYSTEM_PROMPT_TEMPLATE_V1.lastIndexOf("{{listings}}");
    const catalogIdx = SYSTEM_PROMPT_TEMPLATE_V1.lastIndexOf("{{catalog}}");
    const toneIdx = SYSTEM_PROMPT_TEMPLATE_V1.lastIndexOf("{{tone}}");

    expect(summaryIdx).toBeGreaterThan(-1);
    expect(knowledgeIdx).toBeGreaterThan(summaryIdx);
    expect(listingsIdx).toBeGreaterThan(knowledgeIdx);
    expect(catalogIdx).toBeGreaterThan(listingsIdx);
    expect(toneIdx).toBeGreaterThan(catalogIdx);
  });

  it("the template documents the new search_seller_listings tool", () => {
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("search_seller_listings");
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("PURCHASE-intent");
  });

  it("the template documents the dual-citation format", () => {
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("[[listing:");
    expect(SYSTEM_PROMPT_TEMPLATE_V1).toContain("[[Alphonso Mango]]");
  });
});

describe("v6.1 Part 3: buildSystemPrompt passes listings block through", () => {
  it("builds a prompt with all 5 blocks (summary, knowledge, listings, catalog, tone)", () => {
    const prompt = buildSystemPrompt(
      "catalog stuff",
      "summary stuff",
      "knowledge stuff",
      "tone stuff",
      "listings stuff",
    );
    expect(prompt).toContain("catalog stuff");
    expect(prompt).toContain("summary stuff");
    expect(prompt).toContain("knowledge stuff");
    expect(prompt).toContain("tone stuff");
    expect(prompt).toContain("listings stuff");
  });

  it("builds a prompt with empty listings block (no listings context)", () => {
    const prompt = buildSystemPrompt("catalog", "summary", "knowledge", "tone");
    expect(prompt).toContain("catalog");
    expect(prompt).toContain("summary");
    expect(prompt).not.toContain("SELLER LISTING CONTEXT");
  });
});

describe("v6.1 Part 3: formatSellerListingContextForPrompt formats listings", () => {
  it("returns empty string for empty listings array", () => {
    expect(formatSellerListingContextForPrompt([])).toBe("");
  });

  it("formats a single listing with the citation format hint", () => {
    const result = formatSellerListingContextForPrompt([
      {
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
      },
    ]);
    expect(result).toContain("SELLER LISTING CONTEXT");
    expect(result).toContain("[[listing:<id>|<display>]]");
    expect(result).toContain("listingId:42");
    expect(result).toContain("productId:1");
    expect(result).toContain("Alphonso Mango");
    expect(result).toContain("Green Nursery");
    expect(result).toContain("[verified seller]");
    expect(result).toContain("4.8★");
    expect(result).toContain("(12 reviews)");
    expect(result).toContain("450 BDT");
    expect(result).toContain("sapling");
    expect(result).toContain("3ft");
  });

  it("formats multiple listings, each with up to 3 variants", () => {
    const result = formatSellerListingContextForPrompt([
      {
        listingId: 1,
        productId: 1,
        productName: "Variety A",
        sellerName: "Seller A",
        sellerLocation: null,
        sellerIsVerified: false,
        rating: 0,
        reviewCount: 0,
        deliveryTimeDays: null,
        minPrice: 100,
        hasInStockVariant: true,
        hasPreOrderVariant: false,
        variants: [
          {
            form: "seed",
            height: null,
            price: 100,
            discountPrice: null,
            availableQuantity: 5,
            isPreOrder: false,
          },
          {
            form: "sapling",
            height: "1ft",
            price: 200,
            discountPrice: null,
            availableQuantity: 3,
            isPreOrder: false,
          },
          {
            form: "grafted",
            height: "2ft",
            price: 300,
            discountPrice: 250,
            availableQuantity: 0,
            isPreOrder: true,
          },
          {
            form: "potted",
            height: "3ft",
            price: 400,
            discountPrice: null,
            availableQuantity: 1,
            isPreOrder: false,
          },
        ],
      },
      {
        listingId: 2,
        productId: 2,
        productName: "Variety B",
        sellerName: "Seller B",
        sellerLocation: "Chattogram",
        sellerIsVerified: true,
        rating: 5.0,
        reviewCount: 3,
        deliveryTimeDays: 5,
        minPrice: 250,
        hasInStockVariant: false,
        hasPreOrderVariant: true,
        variants: [
          {
            form: "sapling",
            height: null,
            price: 250,
            discountPrice: null,
            availableQuantity: 0,
            isPreOrder: true,
          },
        ],
      },
    ]);
    // Both listings included.
    expect(result).toContain("listingId:1");
    expect(result).toContain("listingId:2");
    // First listing has 4 variants but only 3 should be listed.
    expect(result).toContain("seed");
    expect(result).toContain("sapling");
    expect(result).toContain("grafted");
    expect(result).not.toContain("potted");
    // Discount price used for the grafted variant.
    expect(result).toContain("250 BDT");
    // Second listing is pre-order only.
    expect(result).toContain("pre-order only");
    expect(result).toContain("Chattogram");
  });

  it("handles listings with no variants (empty variants array)", () => {
    const result = formatSellerListingContextForPrompt([
      {
        listingId: 99,
        productId: 1,
        productName: "Empty Listing",
        sellerName: "Seller X",
        sellerLocation: null,
        sellerIsVerified: false,
        rating: 0,
        reviewCount: 0,
        deliveryTimeDays: null,
        minPrice: null,
        hasInStockVariant: false,
        hasPreOrderVariant: false,
        variants: [],
      },
    ]);
    expect(result).toContain("listingId:99");
    expect(result).toContain("out of stock");
    expect(result).toContain("n/a BDT"); // null minPrice → "n/a"
  });
});

describe("v6.1 Part 3: chat route auto-calls search_seller_listings for PURCHASE/MIXED", () => {
  it("routes/ai.ts imports searchSellerListings + formatSellerListingContextForPrompt", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/repos/Trees-friend-/artifacts/api-server/src/routes/ai.ts",
      "utf8",
    );
    expect(source).toContain('import { searchSellerListings } from "../lib/sellerListingSearch"');
    expect(source).toContain("formatSellerListingContextForPrompt");
  });

  it("the chat route conditionally auto-calls search_seller_listings for PURCHASE/MIXED intent", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/repos/Trees-friend-/artifacts/api-server/src/routes/ai.ts",
      "utf8",
    );
    // The auto-call must be gated on the intent being PURCHASE or MIXED.
    expect(source).toContain('intentClassification.intent === "PURCHASE"');
    expect(source).toContain('intentClassification.intent === "MIXED"');
    expect(source).toContain("await searchSellerListings(");
    // v6.1 Part 4: formatSellerListingContextForPrompt now takes 2 args
    // (listings + careSummary). The old single-arg call is updated.
    expect(source).toContain("formatSellerListingContextForPrompt(");
    expect(source).toContain("listingSearchResult.listings");
    expect(source).toContain("listingSearchResult.careSummary");
  });

  it("the chat route passes listingsBlock to renderPromptTemplate + buildSystemPrompt", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/repos/Trees-friend-/artifacts/api-server/src/routes/ai.ts",
      "utf8",
    );
    expect(source).toContain("listingsBlock");
    // Both the renderPromptTemplate call and the buildSystemPrompt call
    // must pass the listingsBlock.
    expect(source).toMatch(/renderPromptTemplate\([\s\S]*?listingsBlock/);
    expect(source).toMatch(/buildSystemPrompt\([\s\S]*?listingsBlock/);
  });
});

describe("v6.1 Part 3: intent admin endpoints declared in aiAdmin.ts", () => {
  it("declares GET /ai/admin/intent/health", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/repos/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toContain('router.get("/ai/admin/intent/health"');
  });

  it("declares GET /ai/admin/intent/metrics", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/repos/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toContain('router.get("/ai/admin/intent/metrics"');
    // The SQL must query the 'intent_classified' event type from Part 1.
    expect(source).toContain("'intent_classified'");
  });

  it("declares POST /ai/admin/intent/test", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/repos/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toContain('router.post("/ai/admin/intent/test"');
  });

  it("declares POST /ai/admin/intent/clear-cache", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/repos/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
      "utf8",
    );
    expect(source).toContain('router.post("/ai/admin/intent/clear-cache"');
  });
});

describe("v6.1 Part 3: AiInsightsTab renders intent distribution UI", () => {
  it("imports the new intent types (IntentHealth + IntentMetrics)", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/repos/Trees-friend-/artifacts/tree-friend/src/components/admin/tabs/AiInsightsTab.tsx",
      "utf8",
    );
    expect(source).toContain("interface IntentHealth");
    expect(source).toContain("interface IntentMetrics");
  });

  it("fetches the intent health + metrics in the parallel Promise.all", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/repos/Trees-friend-/artifacts/tree-friend/src/components/admin/tabs/AiInsightsTab.tsx",
      "utf8",
    );
    expect(source).toContain('"/api/ai/admin/intent/health"');
    expect(source).toContain('"/api/ai/admin/intent/metrics?hours=24"');
  });

  it("has a collapsible Intent Classifier section", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/home/z/my-project/repos/Trees-friend-/artifacts/tree-friend/src/components/admin/tabs/AiInsightsTab.tsx",
      "utf8",
    );
    expect(source).toContain('id="intent"');
    expect(source).toContain('title="Intent Classifier (24h)"');
  });
});
