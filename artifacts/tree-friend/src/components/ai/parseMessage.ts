/**
 * Utilities for parsing TreeBot's response format.
 *
 * The AI's response has two parseable elements:
 *
 *   1. Product mentions: wrapped in [[double square brackets]]
 *      e.g. "Try the [[Alphonso Mango]] for your garden"
 *      → the frontend linkifies these to /products/<slug>
 *
 *   2. Follow-up suggestions: a block at the end delimited by
 *      [followups] ... [/followups]
 *      Each line inside (after "- ") is one suggested question.
 *
 * This module exports:
 *   - extractFollowups(content) → { cleanedContent, followups: string[] }
 *     Strips the [followups] block from the content and returns the
 *     suggestions as an array.
 *   - extractProductMentions(content) → string[]  (raw names)
 *     Returns the list of bracketed product names found in the content.
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

  const blockContent =
    closeIdx === -1 ? afterOpen : afterOpen.slice(0, closeIdx);
  const remainder =
    closeIdx === -1 ? "" : afterOpen.slice(closeIdx + FOLLOWUPS_CLOSE.length);

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

/**
 * Extracts all [[product name]] mentions from the content.
 * Returns the names (without brackets), in the order they appear.
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
  const matches = content.match(/\[\[([^\]]+)\]\]/g);
  if (!matches) return [];
  // Dedupe while preserving order.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of matches) {
    const name = m.slice(2, -2).trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

/**
 * Strips [[...]] markers from content, leaving the bare product name.
 * Used when rendering the message body (we don't show the brackets to
 * the user — they were a parseable marker for the AI, not display text).
 */
export function stripProductMentionMarkers(content: string): string {
  return content.replace(/\[\[([^\]]+)\]\]/g, "$1");
}
