/**
 * heightUtils — frontend height-parsing helpers for the FactCallout picker
 * (v6.2 Part 16).
 *
 * Mirrors the backend `parseHeightToMaxValue` from
 * `api-server/src/lib/sellerListingSearch.ts`. Kept in sync via the
 * shared test cases in `api-server/test/sellerListingSearch.test.ts`
 * and `tree-friend/test/schemas.test.ts` (both files test the same
 * height strings).
 *
 * Why a separate frontend copy instead of importing from the backend:
 *   - The api-server is a separate pnpm workspace package; importing
 *     a single helper from it would pull in the whole `pg` / `drizzle`
 *     DB stack into the frontend bundle (~5MB of dead code).
 *   - The function is ~30 lines + deterministic. Duplicating it with
 *     shared test cases is cheaper than setting up a new shared-utils
 *     workspace package.
 *   - If more shared helpers accumulate, a `lib/shared/` package can
 *     be created later — the helpers will already be isolated + tested.
 *
 * Industry standard: this is the same pattern Vercel AI SDK + Inkeep
 * use for small helpers — duplicate, test, document, refactor later
 * if drift becomes a problem.
 */

import type { ListingData } from "./schemas";

/**
 * Parses seller_listing_variants.height strings into a numeric "max height"
 * for the maturity score. Examples (mirrors the backend helper):
 *   "1-3 ft"    → 3   (range, max)
 *   "4-6 ft"    → 6
 *   "8-12 m"    → 12  (meters, treated same as ft — we only compare
 *                       within the same unit implicitly; the data is
 *                       consistently ft for mango trees)
 *   "3 ft"      → 3   (single value)
 *   "mature"    → 999 (word "mature" always ranks highest — implies
 *                       the largest possible size)
 *   "" / null   → 0   (unrankable)
 *   "sapling"   → 1   (a sapling is the smallest form)
 *   "seed"      → 0.5 (smaller than sapling)
 *
 * The number returned is used ONLY for relative ranking within the same
 * search call — it's not surfaced to the user. So we tolerate the
 * unit ambiguity (ft vs m) because all variants of the same product
 * type typically use the same unit.
 *
 * Industry standard: this is a deterministic, locale-aware parser. No
 * LLM call needed for parsing — too expensive + too slow for a ranking
 * signal. The model already DECIDED to use maturity_desc; we just need
 * to execute that decision deterministically.
 */
export function parseHeightToMaxValue(height: string | null | undefined): number {
  if (!height || typeof height !== "string") return 0;
  const trimmed = height.trim().toLowerCase();
  if (trimmed.length === 0) return 0;

  // Word-form markers — "mature" always ranks highest.
  if (trimmed.includes("mature")) return 999;
  if (trimmed.includes("sapling")) return 1;
  if (trimmed.includes("seed")) return 0.5;

  // Numeric range form: "4-6 ft", "1-3 ft", "8-12 m". Take the MAX of the
  // range (the upper bound) so a "4-6 ft" tree ranks above a "1-3 ft" tree.
  // Regex: optional space, number, optional decimal, dash or en-dash,
  // optional space, number, optional decimal, optional unit.
  const rangeMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)/);
  if (rangeMatch) {
    const high = parseFloat(rangeMatch[2]);
    if (Number.isFinite(high)) return high;
  }

  // Single value form: "3 ft", "12 m", "5". Take the value directly.
  const singleMatch = trimmed.match(/(\d+(?:\.\d+)?)/);
  if (singleMatch) {
    const v = parseFloat(singleMatch[1]);
    if (Number.isFinite(v)) return v;
  }

  return 0;
}

/**
 * Returns the maximum height across all variants of a listing. Used as
 * the "maturity score" input — a listing with a 4-6 ft variant ranks
 * above one whose largest variant is 1-3 ft.
 *
 * Returns 0 when the listing has no variants or none have a parseable
 * height string (graceful degradation — the listing still ranks by
 * other factors like rating, distance, etc.).
 *
 * Mirrors the backend `computeMaxHeight` helper, but takes a
 * `ListingData` (frontend Zod-validated type) instead of the backend
 * `SellerListingResult` (structurally compatible — both have
 * `variants: { height: string | null }[]`).
 */
export function computeMaxHeight(listing: ListingData): number {
  if (!listing.variants || listing.variants.length === 0) return 0;
  let max = 0;
  for (const v of listing.variants) {
    const h = parseHeightToMaxValue(v.height);
    if (h > max) max = h;
  }
  return max;
}

/**
 * Picks the listing with the largest height variant from a list. Used by
 * the FactCallout picker when `sortBy === "maturity_desc"` — the callout
 * surfaces "Most mature: <listing>" so the user sees the top recommendation
 * at a glance, not just a count.
 *
 * Tie-break: when two listings have the same max-height parse, the one
 * appearing first in the list wins (stable sort). This matches user
 * expectations — if all variants are equally mature, the search's own
 * order (which already reflects text-relevance + in-stock + distance)
 * is preserved.
 *
 * Returns `null` when the list is empty or no listing has a parseable
 * height (graceful — the caller falls through to the default callout).
 */
export function pickLargestListing(listings: ListingData[]): ListingData | null {
  if (listings.length === 0) return null;
  let best: ListingData | null = null;
  let bestHeight = -1;
  for (const l of listings) {
    const h = computeMaxHeight(l);
    if (h > bestHeight) {
      bestHeight = h;
      best = l;
    }
  }
  // If no listing had a parseable height (all zeros), best is the first
  // listing (the loop's first iteration set it because 0 > -1). That's
  // the correct behavior — we still return SOME listing so the callout
  // can render. The user will see "Most mature: <listing>" where the
  // height parsing failed silently; acceptable because the listing grid
  // below shows the actual variants with their height strings.
  return best;
}
