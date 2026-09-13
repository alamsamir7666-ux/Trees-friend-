/**
 * Slug normalization for the frontend.
 *
 * Mirrors the backend `lib/db/src/logic/slugs.ts` so the admin BlogTab's
 * live slug preview matches exactly what the server will store.
 *
 * IMPORTANT: keep this file in sync with the backend version. The two are
 * duplicated (not shared via a workspace package) because the db package
 * imports `pg`, which is server-only and would bloat the browser bundle.
 *
 * See `lib/db/src/logic/slugs.ts` for the full algorithm documentation.
 */

const MAX_SLUG_LENGTH = 200;

/**
 * Normalize a string into a URL-safe slug.
 *
 * @param input - Raw input (typically a blog post title).
 * @returns Lowercase, ASCII-only, hyphen-separated slug.
 */
export function normalizeSlug(input: string | null | undefined): string {
  if (input == null) return "";

  const normalized = input
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  const hyphenated = normalized.replace(/[^a-z0-9]+/g, "-");

  const cleaned = hyphenated.replace(/-+/g, "-").replace(/^-|-$/g, "");

  if (cleaned.length <= MAX_SLUG_LENGTH) return cleaned;

  const truncated = cleaned.slice(0, MAX_SLUG_LENGTH);
  const lastHyphen = truncated.lastIndexOf("-");
  if (lastHyphen < MAX_SLUG_LENGTH * 0.5) {
    return truncated;
  }
  return truncated.slice(0, lastHyphen);
}
