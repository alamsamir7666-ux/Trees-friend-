/**
 * Utilities for parsing TreeBot's response format.
 *
 * The AI's response has THREE parseable elements:
 *
 *   1. Product mentions (variety): wrapped in [[double square brackets]]
 *      e.g. "Try the [[Alphonso Mango]] for your garden"
 *      → the frontend linkifies these to /products?q=<name>
 *      (v1.5 simplicity — clicking searches the variety catalog)
 *
 *   2. Seller-listing mentions (v6.1): wrapped in [[listing:<id>|<display>]]
 *      e.g. "I found [[listing:42|Alphonso Mango — 3ft sapling, 450 BDT]]"
 *      → the frontend deep-links to /products/<productId>/seller-listings/<listingId>
 *      (one click to the SellerListingDetailPage → add to cart)
 *
 *      This format is used when the AI calls search_seller_listings (v6.1
 *      Part 2) and wants to recommend SPECIFIC purchasable listings to the
 *      user. Distinct from the variety-level [[name]] format which is
 *      knowledge-intent only.
 *
 *   3. Follow-up suggestions: a block at the end delimited by
 *      [followups] ... [/followups]
 *      Each line inside (after "- ") is one suggested question.
 *
 * This module exports:
 *   - extractFollowups(content) → { cleanedContent, followups: string[] }
 *     Strips the [followups] block from the content and returns the
 *     suggestions as an array.
 *   - extractProductMentions(content) → string[]  (variety-level names)
 *     Returns the list of bracketed product names found in the content.
 *     EXCLUDES the listing:<id>|<display> format (those go to
 *     extractListingMentions).
 *   - extractListingMentions(content) → ListingMention[]  (v6.1)
 *     Returns the list of [[listing:<id>|<display>]] mentions.
 *   - stripProductMentionMarkers(content) → string
 *     Strips ALL [[...]] markers (both formats) from the content.
 */

const FOLLOWUPS_OPEN = "[followups]";
const FOLLOWUPS_CLOSE = "[/followups]";

export interface ExtractedFollowups {
  /** The original content with the [followups] block removed. */
  cleanedContent: string;
  /** The suggested follow-up questions, in order. Empty if no block found. */
  followups: string[];
}

/**
 * A seller-listing mention extracted from the AI's response.
 * e.g. [[listing:42|Alphonso Mango — 3ft sapling, 450 BDT]]
 *   → { listingId: 42, display: "Alphonso Mango — 3ft sapling, 450 BDT" }
 *
 * The productId is NOT in the citation (the AI only knows the listingId
 * from the tool result). The frontend resolves productId by either:
 *   (a) calling a new endpoint GET /api/ai/listings/:id → { productId, ... }
 *   (b) using the existing GET /api/ai/products-by-slug route with the
 *       product's slug (but the citation doesn't have the slug either).
 *
 * For v1, we use approach (a) — a small lookup endpoint that returns just
 * the productId + listingId so the chip can build the deep-link.
 *
 * If that endpoint is unavailable (older deployment), the chip falls back
 * to /listings/<listingId> — which the router can map if needed.
 */
export interface ListingMention {
  /** The seller-listing ID (from the search_seller_listings tool result). */
  listingId: number;
  /** The display text the AI wrote (e.g. "Alphonso Mango — 3ft sapling, 450 BDT"). */
  display: string;
}

/**
 * Pulls the [followups]...[/followups] block out of the message content.
 * The block is removed from the returned `cleanedContent` (with surrounding
 * whitespace trimmed) so the main bubble renders cleanly.
 *
 * If no block is present, returns the original content and an empty array.
 *
 * Tolerant of:
 *   - Missing close tag (uses end-of-content as fallback)
 *   - Lines without the "- " prefix
 *   - Extra blank lines inside the block
 */
export function extractFollowups(content: string): ExtractedFollowups {
  const openIdx = content.indexOf(FOLLOWUPS_OPEN);
  if (openIdx === -1) {
    return { cleanedContent: content, followups: [] };
  }

  const afterOpen = content.slice(openIdx + FOLLOWUPS_OPEN.length);
  const closeIdx = afterOpen.indexOf(FOLLOWUPS_CLOSE);

  const blockContent = closeIdx === -1 ? afterOpen : afterOpen.slice(0, closeIdx);
  const remainder = closeIdx === -1 ? "" : afterOpen.slice(closeIdx + FOLLOWUPS_CLOSE.length);

  // Parse each "- question" line, trimming whitespace + bullet prefix.
  const followups = blockContent
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-•]\s*/, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, 5); // hard cap

  // Recombine the content before + after the block, trimming whitespace.
  const before = content.slice(0, openIdx);
  const cleanedContent = (before + remainder).replace(/\n{3,}/g, "\n\n").trim();

  return { cleanedContent, followups };
}

// ─── v6.1: Listing-mention extraction ──────────────────────────────────────
//
// Format: [[listing:<id>|<display>]]
// Examples:
//   [[listing:42|Alphonso Mango — 3ft sapling, 450 BDT]]
//   [[listing:1337|Langra Mango — grafted, 600 BDT, in stock]]
//
// Regex breakdown:
//   \[\[              — opening [[
//   listing:(\d+)     — literal "listing:" + capture group 1 (digits = listingId)
//   \|                — literal | (pipe separator, escaped)
//   ([^\]]+)          — capture group 2 (display text — anything but ])
//   \]\]              — closing ]]
//
// We use [^\]]+ instead of .*? to avoid greedy matching across multiple
// citations on one line. The display text can contain anything except ]
// (which would terminate the citation).
const LISTING_MENTION_REGEX = /\[\[listing:(\d+)\|([^\]]+)\]\]/g;

/**
 * Extracts all [[listing:<id>|<display>]] mentions from the content.
 * Returns an array of { listingId, display } objects, in the order they appear.
 *
 * Used by the ListingChip component (v6.1) to deep-link to the
 * SellerListingDetailPage.
 *
 * Dedupes by listingId (the AI might cite the same listing twice — keep
 * only the first occurrence so the chip list isn't cluttered).
 */
export function extractListingMentions(content: string): ListingMention[] {
  if (!content) return [];
  const seen = new Set<number>();
  const result: ListingMention[] = [];
  // Reset regex state (global flag — lastIndex persists between calls).
  LISTING_MENTION_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LISTING_MENTION_REGEX.exec(content)) !== null) {
    const listingId = Number(match[1]);
    const display = match[2].trim();
    if (Number.isFinite(listingId) && listingId > 0 && display.length > 0 && !seen.has(listingId)) {
      seen.add(listingId);
      result.push({ listingId, display });
    }
  }
  return result;
}

/**
 * Extracts all [[product name]] mentions from the content.
 * Returns the names (without brackets), in the order they appear.
 *
 * v6.1: EXCLUDES the [[listing:<id>|<display>]] format — those go to
 * extractListingMentions. A simple [[Alphonso Mango]] citation is
 * variety-level (links to the variety catalog search); a
 * [[listing:42|...]] citation is purchasable (deep-links to the listing).
 *
 * Used by the ProductChips component to fetch product data via
 * GET /api/ai/products-by-slug?slugs=...
 *
 * Note: we return the NAME as written by the AI. The backend resolves
 * names → slugs via the products table (case-insensitive name match).
 * Actually — we return names because the backend's products-by-slug
 * endpoint takes slugs, not names. The frontend will need to either:
 *   (a) call a products-by-name endpoint, OR
 *   (b) keep the names as-is and linkify to a search URL like
 *       /products?q=<name>
 *
 * We go with (b) for v1.5 simplicity — clicking a product mention
 * navigates to /products?q=<name> which shows matching products.
 */
export function extractProductMentions(content: string): string[] {
  // Match all [[...]] patterns, then filter OUT the listing:<id>|<display>
  // format (which we don't want here — those are processed by
  // extractListingMentions).
  const matches = content.match(/\[\[([^\]]+)\]\]/g);
  if (!matches) return [];
  // Dedupe while preserving order.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of matches) {
    const name = m.slice(2, -2).trim();
    // Skip the [[listing:<id>|<display>]] format — those are listing
    // mentions, not product mentions.
    if (name.startsWith("listing:")) continue;
    if (name && !seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

/**
 * Strips [[...]] markers from content, leaving the bare product/listing name.
 * Used when rendering the message body (we don't show the brackets to
 * the user — they were a parseable marker for the AI, not display text).
 *
 * v6.1: handles BOTH citation formats:
 *   - [[Alphonso Mango]] → "Alphonso Mango"
 *   - [[listing:42|Alphonso Mango — 3ft sapling, 450 BDT]] →
 *     "Alphonso Mango — 3ft sapling, 450 BDT" (extracts just the display part)
 */
export function stripProductMentionMarkers(content: string): string {
  // First strip the listing:<id>|<display> format → keep only the display.
  let result = content.replace(LISTING_MENTION_REGEX, "$2");
  // Then strip the simple [[name]] format.
  result = result.replace(/\[\[([^\]]+)\]\]/g, "$1");
  return result;
}
