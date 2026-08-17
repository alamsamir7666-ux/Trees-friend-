/**
 * Tests for the parseMessage.ts citation format extractors (v6.1 Part 2).
 *
 * Verifies that the new [[listing:<id>|<display>]] format is correctly:
 *   - Extracted by extractListingMentions()
 *   - Excluded from extractProductMentions() (which should ONLY return
 *     variety-level [[name]] citations)
 *   - Stripped from the displayed content by stripProductMentionMarkers()
 *     (keeping just the display text, not the listing: prefix)
 *
 * Also verifies backward compatibility: existing [[Alphonso Mango]]
 * citations still work, and a response mixing both formats handles each
 * correctly.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/parseMessage.test.ts
 */
import { describe, it, expect } from "vitest";

// parseMessage.ts is a frontend file but has no React imports — it's pure
// TS string manipulation. We import it via relative path.
// The path resolves to artifacts/tree-friend/src/components/ai/parseMessage.ts
// from the api-server/test directory.
import {
  extractFollowups,
  extractProductMentions,
  extractListingMentions,
  stripProductMentionMarkers,
} from "../../tree-friend/src/components/ai/parseMessage";

describe("parseMessage: extractListingMentions (v6.1 new format)", () => {
  it("extracts a single [[listing:<id>|<display>]] citation", () => {
    const content = "I found [[listing:42|Alphonso Mango — 3ft sapling, 450 BDT]] for you.";
    const mentions = extractListingMentions(content);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].listingId).toBe(42);
    expect(mentions[0].display).toBe("Alphonso Mango — 3ft sapling, 450 BDT");
  });

  it("extracts multiple citations in order", () => {
    const content =
      "Try [[listing:42|Alphonso Mango — 450 BDT]] or [[listing:1337|Langra Mango — 600 BDT]].";
    const mentions = extractListingMentions(content);
    expect(mentions).toHaveLength(2);
    expect(mentions[0].listingId).toBe(42);
    expect(mentions[0].display).toBe("Alphonso Mango — 450 BDT");
    expect(mentions[1].listingId).toBe(1337);
    expect(mentions[1].display).toBe("Langra Mango — 600 BDT");
  });

  it("dedupes by listingId (keeps first occurrence)", () => {
    const content =
      "Try [[listing:42|Alphonso Mango — 450 BDT]]. [[listing:42|Alphonso Mango — 450 BDT]] is great.";
    const mentions = extractListingMentions(content);
    expect(mentions).toHaveLength(1);
  });

  it("handles special characters in display text (em-dash, comma)", () => {
    const content = "[[listing:99|Mango Sapling — Grafted, 3ft, 500 BDT]]";
    const mentions = extractListingMentions(content);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].display).toBe("Mango Sapling — Grafted, 3ft, 500 BDT");
  });

  it("handles Bengali display text", () => {
    const content = "[[listing:7|আমের চারা — ৩ ফুট, ৪৫০ টাকা]]";
    const mentions = extractListingMentions(content);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].listingId).toBe(7);
    expect(mentions[0].display).toBe("আমের চারা — ৩ ফুট, ৪৫০ টাকা");
  });

  it("ignores invalid listing IDs (zero, negative, non-numeric)", () => {
    const content =
      "[[listing:0|zero]] [[listing:-5|negative]] [[listing:abc|non-numeric]] [[listing:42|valid]]";
    const mentions = extractListingMentions(content);
    // Only the valid one should be returned.
    expect(mentions).toHaveLength(1);
    expect(mentions[0].listingId).toBe(42);
  });

  it("returns empty array for content with no listing citations", () => {
    const content = "Try the [[Alphonso Mango]] variety.";
    const mentions = extractListingMentions(content);
    expect(mentions).toEqual([]);
  });

  it("returns empty array for empty/null content", () => {
    expect(extractListingMentions("")).toEqual([]);
    expect(extractListingMentions(null as unknown as string)).toEqual([]);
    expect(extractListingMentions(undefined as unknown as string)).toEqual([]);
  });
});

describe("parseMessage: extractProductMentions (variety-level, excludes listing format)", () => {
  it("extracts [[Alphonso Mango]] variety citations", () => {
    const content = "Try the [[Alphonso Mango]] or [[Langra Mango]] varieties.";
    const mentions = extractProductMentions(content);
    expect(mentions).toHaveLength(2);
    expect(mentions).toContain("Alphonso Mango");
    expect(mentions).toContain("Langra Mango");
  });

  it("EXCLUDES the [[listing:<id>|<display>]] format (v6.1)", () => {
    // Critical: extractProductMentions must NOT return listing citations.
    // Those go to extractListingMentions. Mixing them would cause
    // ProductChips to try to navigate to /products?q=listing:42|... which
    // is wrong.
    const content = "Try [[Alphonso Mango]] variety or [[listing:42|Alphonso — 450 BDT]] listing.";
    const mentions = extractProductMentions(content);
    expect(mentions).toHaveLength(1);
    expect(mentions).toContain("Alphonso Mango");
    expect(mentions).not.toContain("listing:42|Alphonso — 450 BDT");
  });

  it("dedupes variety mentions while preserving order", () => {
    const content = "[[Alphonso Mango]] [[Alphonso Mango]] [[Langra Mango]]";
    const mentions = extractProductMentions(content);
    expect(mentions).toEqual(["Alphonso Mango", "Langra Mango"]);
  });

  it("returns empty array for content with no citations", () => {
    expect(extractProductMentions("just text")).toEqual([]);
    expect(extractProductMentions("")).toEqual([]);
  });
});

describe("parseMessage: stripProductMentionMarkers (strips BOTH formats)", () => {
  it("strips [[name]] variety citations → leaves bare name", () => {
    const content = "Try the [[Alphonso Mango]] variety.";
    const stripped = stripProductMentionMarkers(content);
    expect(stripped).toBe("Try the Alphonso Mango variety.");
  });

  it("strips [[listing:<id>|<display>]] → leaves just the display text", () => {
    const content = "Try [[listing:42|Alphonso Mango — 3ft sapling, 450 BDT]] now.";
    const stripped = stripProductMentionMarkers(content);
    // Critical: the display text is preserved (NOT the listing:42| prefix).
    expect(stripped).toBe("Try Alphonso Mango — 3ft sapling, 450 BDT now.");
    expect(stripped).not.toContain("listing:");
    expect(stripped).not.toContain("[[");
    expect(stripped).not.toContain("]]");
  });

  it("strips BOTH formats in mixed content", () => {
    const content = "Try [[Alphonso Mango]] variety or [[listing:42|Alphonso — 450 BDT]] listing.";
    const stripped = stripProductMentionMarkers(content);
    expect(stripped).toBe("Try Alphonso Mango variety or Alphonso — 450 BDT listing.");
  });

  it("handles content with no markers (no-op)", () => {
    expect(stripProductMentionMarkers("just text")).toBe("just text");
  });
});

describe("parseMessage: extractFollowups (existing — verify no regression)", () => {
  it("extracts followups block", () => {
    const content =
      "Here's your answer.\n\n[followups]\n- How to care for it?\n- Where to plant?\n- When to water?\n[/followups]";
    const { cleanedContent, followups } = extractFollowups(content);
    expect(followups).toEqual(["How to care for it?", "Where to plant?", "When to water?"]);
    expect(cleanedContent).toBe("Here's your answer.");
  });

  it("returns empty followups when no block present", () => {
    const content = "Just an answer.";
    const { cleanedContent, followups } = extractFollowups(content);
    expect(followups).toEqual([]);
    expect(cleanedContent).toBe("Just an answer.");
  });
});

describe("parseMessage: mixed-format integration (real AI responses)", () => {
  it("handles a realistic purchase-intent response", () => {
    // Real AI response after calling search_seller_listings.
    const content = `I found some mango saplings for you:

1. [[listing:42|Alphonso Mango — 3ft grafted sapling, 450 BDT, in stock]] from Green Nursery (Dhaka, verified seller, 4.8★).
2. [[listing:1337|Langra Mango — 2ft sapling, 380 BDT, in stock]] from Plant World (Chittagong, 4.5★).

Both offer cash on delivery. Click any listing to view details and add to cart.

[followups]
- What's the delivery time?
- Do they offer warranty?
- Show me more mango varieties
[/followups]`;

    const listings = extractListingMentions(content);
    const products = extractProductMentions(content);
    const { cleanedContent, followups } = extractFollowups(content);
    const stripped = stripProductMentionMarkers(cleanedContent);

    // Two listing citations extracted.
    expect(listings).toHaveLength(2);
    expect(listings[0].listingId).toBe(42);
    expect(listings[1].listingId).toBe(1337);

    // No variety-level citations in this purchase-intent response.
    expect(products).toEqual([]);

    // Followups extracted.
    expect(followups).toEqual([
      "What's the delivery time?",
      "Do they offer warranty?",
      "Show me more mango varieties",
    ]);

    // Stripped content has no [[ markers, no listing: prefix.
    expect(stripped).not.toContain("[[");
    expect(stripped).not.toContain("]]");
    expect(stripped).not.toContain("listing:");
    expect(stripped).toContain("Alphonso Mango — 3ft grafted sapling, 450 BDT, in stock");
    expect(stripped).toContain("Langra Mango — 2ft sapling, 380 BDT, in stock");
  });

  it("handles a realistic knowledge-intent response (no listing citations)", () => {
    const content = `The [[Alphonso Mango]] is a popular variety from India. It prefers full sun and well-drained soil.

Water deeply once a week during the growing season. Reduce watering in winter.

[followups]
- Where can I buy an Alphonso Mango?
- How long until it fruits?
- Common pests?
[/followups]`;

    const listings = extractListingMentions(content);
    const products = extractProductMentions(content);

    expect(listings).toEqual([]);
    expect(products).toEqual(["Alphonso Mango"]);
  });

  it("handles a realistic MIXED-intent response (both formats)", () => {
    const content = `The [[Alphonso Mango]] variety prefers full sun. You can buy one from [[listing:42|Green Nursery — Alphonso 3ft, 450 BDT]].

[followups]
- How to water it?
- More sellers?
[/followups]`;

    const listings = extractListingMentions(content);
    const products = extractProductMentions(content);

    // Both formats extracted independently.
    expect(listings).toHaveLength(1);
    expect(listings[0].listingId).toBe(42);
    expect(products).toEqual(["Alphonso Mango"]);
  });
});
