/**
 * Slug normalization for blog posts (and any future content with a URL slug).
 *
 * The previous normalization `slug.trim().toLowerCase().replace(/\s+/g, "-")`
 * only collapsed whitespace — it left special characters like `!`, `?`, `#`,
 * `&`, `(`, `)` in the slug, producing URLs like `/blog/mango-tree!?` that
 * break routing (the `?` is parsed as a query-string separator, the `#` as a
 * fragment identifier, `&` separates query params, etc.).
 *
 * This module is the single source of truth for slug normalization. Both
 * the admin frontend (BlogTab's `autoSlug`) and the API server (POST/PATCH
 * /admin/blog-posts) import the same logic so they never drift.
 *
 * Strategy (industry-standard "pretty URL" slug):
 *   1. Lowercase
 *   2. Normalize Unicode → ASCII (NFKD + strip combining marks) so
 *      "café" → "cafe", not "caf" + U+0301
 *   3. Replace any run of non-[a-z0-9] characters with a single hyphen
 *      (covers spaces, punctuation, emojis, etc.)
 *   4. Strip leading/trailing hyphens
 *   5. Collapse consecutive hyphens
 *   6. Truncate to a max length (200 — matches the slug column's varchar(200))
 *      on a hyphen boundary (don't cut mid-word)
 *
 * Returns "" for empty / whitespace-only input — callers should reject
 * empty slugs at the validation layer (CreateBlogPostBody requires slug).
 */

const MAX_SLUG_LENGTH = 200;

/**
 * Normalize a string into a URL-safe slug.
 *
 * @param input - Raw input (typically a blog post title or admin-typed slug).
 * @returns Lowercase, ASCII-only, hyphen-separated slug. Empty string if
 *          the input has no alphanumeric characters.
 */
export function normalizeSlug(input: string | null | undefined): string {
  if (input == null) return "";

  // Step 1+2: lowercase + Unicode normalization.
  // NFKD decomposes combined characters (e.g. "é" → "e" + U+0301), then
  // we strip the combining marks (U+0300–U+036F) so accented Latin letters
  // become their ASCII base. This is the same algorithm used by slugify
  // libraries (lodash, speakingurl, etc.).
  const normalized = input
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  // Step 3: replace any run of non-[a-z0-9] characters with a single hyphen.
  // [^a-z0-9]+ matches: spaces, punctuation, emojis, CJK characters, etc.
  const hyphenated = normalized.replace(/[^a-z0-9]+/g, "-");

  // Step 4+5: strip leading/trailing hyphens + collapse consecutive hyphens
  // (the regex above already collapses to single hyphens, but defensive).
  const cleaned = hyphenated.replace(/-+/g, "-").replace(/^-|-$/g, "");

  // Step 6: truncate on a hyphen boundary so we don't cut mid-word.
  // If truncation lands in the middle of a word, walk back to the previous
  // hyphen and cut there. If there's no hyphen within the first
  // MAX_SLUG_LENGTH chars, just hard-cut (rare — titles aren't usually
  // one 200+ character word).
  if (cleaned.length <= MAX_SLUG_LENGTH) return cleaned;

  const truncated = cleaned.slice(0, MAX_SLUG_LENGTH);
  const lastHyphen = truncated.lastIndexOf("-");
  if (lastHyphen < MAX_SLUG_LENGTH * 0.5) {
    // No good hyphen boundary in the first half — hard cut (rare).
    return truncated;
  }
  return truncated.slice(0, lastHyphen);
}
