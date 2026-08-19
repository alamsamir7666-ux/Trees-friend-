/**
 * Seller-listing search for the TreeBot AI assistant (v6.1 Part 2).
 *
 * ─── The problem this solves ─────────────────────────────────────────────────
 *
 * The existing `search_catalog` tool queries the `products` table (the
 * variety catalog — admin-owned, no price/stock of its own). It returns
 * variety-level info + an aggregate `min_price` across all sellers. The AI
 * then says things like "Alphonso Mango starts at 350 BDT" — but the user
 * has no idea WHO sells it, WHERE the seller is, what variants are
 * available (sapling vs. grafted vs. potted), or whether it's in stock.
 *
 * The user's actual question is usually "I want to buy a mango sapling" —
 * they want SPECIFIC seller listings with seller name, location, variant,
 * price, stock, delivery charge. They want to click straight to the
 * `SellerListingDetailPage` and add to cart. Not navigate variety →
 * seller list → variant → cart (5 clicks).
 *
 * This module implements the new `search_seller_listings` tool's backend:
 *   1. Find candidate VARIETIES via the existing `products.search_tsvector`
 *      (BM25 + trigram) — same first-pass logic as `search_catalog`.
 *   2. JOIN through `seller_listings` (visibility=public, approval=approved,
 *      seller.status=active) → `seller_listing_variants` (in-stock OR
 *      pre-order) → `sellers` (name, city, isVerified) → reviews aggregate
 *      (rating, reviewCount).
 *   3. Inflate each candidate variety into its top-N listings (default 3,
 *      max 5 per variety). Cap total listings at the `limit` parameter
 *      (default 5, max 8) so the LLM doesn't blow its token budget.
 *   4. Rank listings by:
 *        a. in-stock variants > pre-order-only listings (boolean, weight 1.0)
 *        b. exact `form` match (e.g. user said "sapling" → Sapling variants
 *           rank above Grafted) — weighted 0.8
 *        c. price asc (within optional `max_price` filter) — 0.4
 *        d. seller rating desc — 0.3
 *        e. seller isVerified = true boost — 0.2
 *        f. distance from buyer's district (if known) — 0.3
 *   5. Return a structured result the LLM can format into specific
 *      suggestions with deep-linkable chips.
 *
 * ─── Citation format ───────────────────────────────────────────────────────
 *
 * The new tool's results include `listingId` + `productId` so the AI can
 * emit the new dual-citation format:
 *
 *   [[listing:42|Alphonso Mango — 3ft sapling, 450 BDT]]
 *
 * The frontend `parseMessage.ts` extracts these and `ListingChip.tsx`
 * deep-links to `/products/:productId/seller-listings/:listingId` — the
 * `SellerListingDetailPage` route. One click to buy.
 *
 * The existing `[[Alphonso Mango]]` format is preserved for knowledge-
 * intent answers (links to the variety detail page).
 *
 * ─── Fail-safe ───────────────────────────────────────────────────────────────
 *
 * All errors are caught + logged. The function returns `{ listings: [],
 * totalCount: 0, error?: string }` on failure — the AI's existing
 * `executeTool` catch wraps this with `{ error: "Tool execution failed" }`
 * and the LLM falls back to variety-level context. Same pattern as
 * `searchCatalog`.
 *
 * @module lib/sellerListingSearch
 */

import { pool } from "@workspace/db";
import { logger } from "./logger";
// v6.1 Part 3: Haversine distance for ranking seller listings by distance
// from the buyer's district. Replaces the v1 same-district heuristic with
// a real geographic distance calculation across all 64 Bangladesh districts.
import { extractDistrictFromLocation, distanceBetweenDistricts } from "./bangladeshDistricts";
// v6.1 Part 4: when careSummary=true, the search also fetches the top KB
// entry (1 result, higher threshold, skip reranker for speed) and includes
// a 1-line care summary in the response. Used for MIXED-intent queries —
// saves a separate KB auto-inject call (~50ms + ~1500 tokens of redundant
// context per MIXED query).
import { searchKnowledgeBase } from "./kbSearch";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SellerListingVariantResult {
  variantId: number;
  form: string | null;
  rootType: string | null;
  potSize: string | null;
  age: string | null;
  height: string | null;
  condition: string | null;
  price: number; // BDT
  discountPrice: number | null;
  availableQuantity: number;
  deliveryCharge: number;
  isPreOrder: boolean;
}

export interface SellerListingResult {
  listingId: number;
  productId: number;
  productName: string;
  productSlug: string;
  sellerId: number;
  sellerName: string; // businessName
  sellerLocation: string | null; // freeform location text from sellersTable
  sellerIsVerified: boolean;
  rating: number; // 0-5, rounded to 1 decimal
  reviewCount: number;
  deliveryTimeDays: number | null;
  warrantyDays: number | null;
  paymentMethod: string; // "cod" | "advance" | "both"
  certification: string | null;
  /**
   * Representative thumbnail URL for the listing.
   *
   * v6.2 Part 4 fix (Bug 1): previously this field did not exist on the
   * tool result, so the frontend `ListingGridCard` add-to-cart path
   * hard-coded `image: ""` — the cart page then rendered a broken
   * thumbnail for any item added from the chat.
   *
   * Source priority (COALESCE in SQL):
   *   1. seller_listings.images[0]  — most specific to this listing
   *   2. products.images[0]         — fallback to the catalog image
   *
   * Both columns are `jsonb NOT NULL DEFAULT '[]'::jsonb` arrays of URL
   * strings (see lib/db/src/schema/{sellerListings,products}.ts). Postgres
   * `jsonb->>0` returns NULL when the array is empty, so COALESCE produces
   * NULL only when BOTH arrays are empty. The frontend uses an SVG leaf
   * placeholder in that case — the cart page never renders a broken img.
   */
  productImage: string | null;
  /** Top variants by price asc, capped at 3 per listing. */
  variants: SellerListingVariantResult[];
  /** True if at least one variant has availableQuantity > 0 (in-stock). */
  hasInStockVariant: boolean;
  /** True if at least one variant is pre-order (availableQuantity = 0 but isPreOrder = true). */
  hasPreOrderVariant: boolean;
  /** Cheapest variant price (after discount). Null if no variants. */
  minPrice: number | null;
}

export interface SellerListingSearchResult {
  listings: SellerListingResult[];
  totalCount: number;
  /** The query as understood by the search (post-normalization). */
  query: string;
  /** The buyer's city (for transparency in the tool response). */
  buyerCity: string | null;
  /** The buyer's district (for transparency). */
  buyerDistrict: string | null;
  /**
   * v6.2 Part 16: echoes back the `sort_by` value the LLM chose (or
   * undefined when not passed, meaning the default price_asc was used).
   *
   * The frontend FactCallout reads this to render the matching summary
   * (e.g. maturity_desc → "Most mature: <listing>") WITHOUT re-classifying
   * the user's intent via keyword matching — the LLM already did that
   * when it set sort_by on the call.
   */
  sortBy?: "price_asc" | "price_desc" | "maturity_desc" | "rating_desc";
  /**
   * v1.8.0 (Part 17/18): echoes back the deterministic filter args the
   * LLM passed (max_height, bloom_season, min_rating, max_delivery_days,
   * distinct_products) + the existing hard-filter args (max_price, form,
   * limit) for completeness. NULL when no filters were applied.
   *
   * The frontend FactCallout reads this to append a "Filtered by: <list>"
   * suffix to the callout text — industry-standard "filter chips"
   * pattern from ChatGPT Shopping + Perplexity.
   *
   * Only includes the args the LLM explicitly passed — undefined args
   * are omitted from the object (not set to undefined). This keeps the
   * object small + lets the frontend iterate only over the applied
   * filters.
   */
  filtersApplied?: {
    max_price?: number;
    form?: string;
    limit?: number;
    max_height?: number;
    bloom_season?: string;
    min_rating?: number;
    max_delivery_days?: number;
    distinct_products?: boolean;
  } | null;
  /**
   * v6.1 Part 4: 1-line KB care summary, included when careSummary=true
   * was passed to the search params. Null when:
   *   - careSummary was not requested (PURCHASE intent — no need).
   *   - The KB search returned no high-confidence matches (minScore 0.5).
   *   - The KB search itself errored (fail-safe — listings still returned).
   *
   * The LLM uses this for MIXED-intent responses — the user gets a
   * one-line "how to care for it" alongside the buyable listings, in
   * ONE tool response (no separate KB auto-inject needed).
   */
  careSummary?: {
    /** The truncated care-info text (max ~200 chars). */
    content: string;
    /** The KB entry ID (for the LLM's reference; not surfaced to the user). */
    entryId?: number;
    /** The KB source title (e.g. "Mango Sapling Care — Summer Watering"). */
    sourceTitle?: string;
  } | null;
  /** Set when the search errored gracefully. */
  error?: string;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;
const MAX_VARIANTS_PER_LISTING = 3;
const DEFAULT_FORM_MATCH_BONUS = 0.8;
const DEFAULT_PRICE_WEIGHT = 0.4;
const DEFAULT_RATING_WEIGHT = 0.3;
const DEFAULT_VERIFIED_BOOST = 0.2;
const DEFAULT_DISTANCE_WEIGHT = 0.3;
const DEFAULT_INSTOCK_WEIGHT = 1.0;

// ─── Public API ─────────────────────────────────────────────────────────────

export interface SellerListingSearchParams {
  query: string;
  max_price?: number;
  form?: string;
  limit?: number;
  /** Buyer's city (from their default address). Null for anonymous users. */
  userCity?: string | null;
  /** Buyer's district. Null for anonymous users. */
  userDistrict?: string | null;
  /**
   * v6.2 Part 16: controls the ranking weights in `rankListings`. The LLM
   * chooses this value based on the user's stated preference:
   *
   *   - undefined / "price_asc"  (default): cheapest first. Existing
   *     behavior. Used when the user is price-conscious ("cheapest",
   *     "under ৳X", "budget").
   *   - "price_desc": most expensive first. Used when the user said
   *     "most expensive", "highest price", "top-end".
   *   - "maturity_desc": largest height variant first. Used when the
   *     user signaled price-insensitivity + quality focus ("i dont
   *     care about price", "most mature", "largest", "premium"). This
   *     is the canonical "premium intent" branch.
   *   - "rating_desc": highest seller rating first. Used when the user
   *     explicitly asked about seller quality ("best quality",
   *     "highest rated", "top rated").
   *
   * The chosen value is ECHOED BACK in the result envelope so the
   * frontend can render the matching FactCallout without re-classifying
   * intent (industry standard — single source of truth is the LLM).
   */
  sortBy?: "price_asc" | "price_desc" | "maturity_desc" | "rating_desc";
  /**
   * v1.8.0 (Part 17): DETERMINISTIC filter — exclude listings whose
   * max height variant > max_height. Parsed via parseHeightToMaxValue()
   * ("4-6 ft" → 6, "1-3 ft" → 3, "mature" → 999, etc.).
   *
   * Applied POST-SQL (in JS) because parsing the height string is JS-side.
   * The SQL query returns all matching listings; this filter trims the
   * list before ranking + truncation.
   *
   * Use case: "trees under 6 ft" / "compact mango for balcony".
   */
  maxHeight?: number;
  /**
   * v1.8.0 (Part 17): DETERMINISTIC filter — only include listings whose
   * products.bloom_season contains this string (case-insensitive ILIKE).
   * NULL bloom_season is EXCLUDED (conservative — if the variety has no
   * recorded bloom season, we can't confirm it fruits in the requested
   * season).
   *
   * Applied IN SQL (in the listing_variants CTE's WHERE clause) — joins
   * to products.bloom_season which is already accessible.
   *
   * Use case: "fruits in winter" → bloom_season: "winter"
   *            "fruits in summer" → bloom_season: "summer"
   *            "fruits in December" → bloom_season: "Dec"
   */
  bloomSeason?: string;
  /**
   * v1.8.0 (Part 17): DETERMINISTIC filter — only include listings whose
   * seller rating ≥ min_rating. Rating is computed from the reviews
   * table (AVG of r.rating WHERE r.seller_listing_id = sl.id).
   *
   * Applied IN SQL (in the listing_variants CTE's WHERE clause as a
   * subquery filter).
   *
   * Use case: "rated 4.5+" → min_rating: 4.5
   *            "top-rated sellers" → min_rating: 4.0
   */
  minRating?: number;
  /**
   * v1.8.0 (Part 17): DETERMINISTIC filter — only include listings whose
   * sl.delivery_time_days ≤ max_delivery_days. NULL delivery_time_days
   * is EXCLUDED (conservative — if the seller didn't commit, we can't
   * promise delivery within the window).
   *
   * Applied IN SQL (in the listing_variants CTE's WHERE clause).
   *
   * Use case: "delivered within 3 days" → max_delivery_days: 3
   *            "fast delivery" → max_delivery_days: 5
   */
  maxDeliveryDays?: number;
  /**
   * v1.8.0 (Part 17): DETERMINISTIC filter — dedupe by productName.
   * Returns only the highest-ranked listing per distinct productName
   * value. Used when the user wants "different varieties" without
   * padding with duplicates from the same seller.
   *
   * Applied POST-SQL (in JS) — after rankListings() runs (so we keep
   * the top-ranked listing per productName), before truncation.
   *
   * Use case: "3 different grafted mango varieties" → distinct_products:
   * true + limit: 5 (broader pool, then dedupe).
   */
  distinctProducts?: boolean;
  /**
   * v6.1 Part 4: when true, the search ALSO fetches the top KB entry
   * (1 result, higher threshold 0.5, skip reranker for speed) and
   * includes it as `careSummary` in the result.
   *
   * Used by the chat route for MIXED-intent queries — the user wants
   * BOTH care info AND buyable listings. Without this flag, the chat
   * route would need TWO separate DB calls:
   *   1. getTopKbEntriesForPrompt() → 5 KB entries (~1500 tokens, ~50ms)
   *   2. searchSellerListings() → 5 listings (~500 tokens, ~30ms)
   *
   * With careSummary=true, ONE call returns:
   *   - 5 listings (~500 tokens)
   *   - 1-line care summary (~30 tokens)
   * Total: ~530 tokens (4x reduction) + ~30ms saved (no separate KB call).
   *
   * The care summary uses NON-UNIFIED retrieval params (maxResults=1,
   * minScore=0.5, skipRerank=true) — this is intentional + documented
   * (see the BUG-I1 "unified retrieval contract" comment in kbSearch.ts).
   * The unified params (5 entries, minScore 0.3, reranked) are for
   * KNOWLEDGE-intent queries where the user wants 5 detailed articles.
   * The careSummary is a DIFFERENT semantic — "give me 1 quick line to
   * accompany these listings" — so a higher threshold + 1 result is
   * appropriate. We're trading recall for precision + speed.
   */
  careSummary?: boolean;
}

// ─── v1.8.0 (Part 18): build the filtersApplied echo object ────────────────
//
// Returns the object that gets echoed back in the result envelope so the
// frontend FactCallout can render "Filtered by: <list>". Only includes
// the args the LLM EXPLICITLY passed — undefined args are omitted from
// the object (not set to undefined). Returns null when NO filters were
// applied (the frontend FactCallout skips the "Filtered by" suffix).
//
// The `validated` args (maxPrice, formFilter, limit) are passed in
// because the function `searchSellerListings` already validated them
// at the top (maxPrice is null or a number > 0; formFilter is null or
// a lowercased string; limit is the clamped value). We use these
// validated values, not the raw params, to avoid echoing invalid args.
function buildFiltersApplied(
  params: SellerListingSearchParams,
  maxPrice: number | null,
  formFilter: string | null,
  limit: number,
): Exclude<SellerListingSearchResult["filtersApplied"], null | undefined> | null {
  const result: NonNullable<
    Exclude<SellerListingSearchResult["filtersApplied"], null | undefined>
  > = {};
  if (maxPrice !== null) result.max_price = maxPrice;
  if (formFilter !== null) result.form = formFilter;
  // Echo limit only if it differs from the default (DEFAULT_LIMIT = 5).
  // If the LLM didn't pass limit, the validated `limit` is the default —
  // we don't echo it (the frontend treats undefined as default).
  if (params.limit !== undefined && limit !== DEFAULT_LIMIT) result.limit = limit;
  if (params.maxHeight !== undefined && params.maxHeight > 0) result.max_height = params.maxHeight;
  if (typeof params.bloomSeason === "string" && params.bloomSeason.trim().length > 0) {
    result.bloom_season = params.bloomSeason.trim().toLowerCase();
  }
  if (typeof params.minRating === "number" && params.minRating >= 0 && params.minRating <= 5) {
    result.min_rating = params.minRating;
  }
  if (typeof params.maxDeliveryDays === "number" && params.maxDeliveryDays > 0) {
    result.max_delivery_days = Math.floor(params.maxDeliveryDays);
  }
  if (params.distinctProducts === true) result.distinct_products = true;
  // Return null when no filters applied (saves the frontend an Object.keys check).
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Searches seller listings matching the user's query.
 *
 * Algorithm (see module doc for full rationale):
 *   1. Normalize the query (lowercase, trim, slice).
 *   2. Find candidate VARIETIES via products.search_tsvector + trigram +
 *      ILIKE fallback (same as search_catalog).
 *   3. JOIN seller_listings + seller_listing_variants + sellers + reviews
 *      in ONE big parameterized query.
 *   4. Group variants by listing, compute per-listing aggregates
 *      (hasInStockVariant, hasPreOrderVariant, minPrice).
 *   5. Rank listings by the weighted score (in-stock > form match > price
 *      > rating > verified > distance).
 *   6. Truncate to `limit` (default 5, max 8).
 *   7. Truncate variants per listing to 3 (cheapest first).
 *
 * Fail-safe: returns `{ listings: [], totalCount: 0, error: "..." }` on
 * any error. The caller's `executeTool` catch handles the rest.
 */
export async function searchSellerListings(
  params: SellerListingSearchParams,
): Promise<SellerListingSearchResult> {
  const query = (params.query ?? "").trim().toLowerCase();
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const maxPrice =
    typeof params.max_price === "number" && params.max_price > 0 ? params.max_price : null;
  const formFilter =
    typeof params.form === "string" && params.form.trim().length > 0
      ? params.form.trim().toLowerCase()
      : null;
  const buyerCity = params.userCity ?? null;
  const buyerDistrict = params.userDistrict ?? null;
  // v6.2 Part 16: sort_by picked by the LLM based on the user's stated
  // preference. Undefined falls through to the legacy price_asc default.
  const sortBy = params.sortBy;
  // v1.8.0 (Part 17): deterministic filters — picked by the LLM for
  // hard constraints the v1.7.0 post-call checks would otherwise have
  // to enforce. These compose with the existing SQL filters (max_price,
  // form) + the post-SQL ranking (sort_by).
  const maxHeight = params.maxHeight;
  const bloomSeason =
    typeof params.bloomSeason === "string" && params.bloomSeason.trim().length > 0
      ? params.bloomSeason.trim().toLowerCase()
      : null;
  const minRating =
    typeof params.minRating === "number" && params.minRating >= 0 && params.minRating <= 5
      ? params.minRating
      : null;
  const maxDeliveryDays =
    typeof params.maxDeliveryDays === "number" && params.maxDeliveryDays > 0
      ? Math.floor(params.maxDeliveryDays)
      : null;
  const distinctProducts = params.distinctProducts === true;

  if (query.length === 0) {
    return {
      listings: [],
      totalCount: 0,
      query: "",
      buyerCity,
      buyerDistrict,
      error: "empty query",
    };
  }

  // Tokens for the tsvector search (same as search_catalog: lowercase, 3+ char
  // English or 2+ char Bengali, slice 5).
  const tokens = query
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 5);

  if (tokens.length === 0) {
    return {
      listings: [],
      totalCount: 0,
      query,
      buyerCity,
      buyerDistrict,
      error: "no searchable tokens (all words too short)",
    };
  }

  // Build the tsvector search query (websearch_to_tsquery supports quoted
  // phrases + OR, which is more forgiving than plainto_tsquery).
  const tsquery = tokens.join(" | ");

  // The active-listing filter — same canonical filter as
  // routes/sellerListings.ts + aiTools.ts:searchCatalog (v6.1 fix: no
  // deleted_at, no is_active — those columns don't exist on seller_listings).
  const ACTIVE_LISTING_FILTER =
    "sl.visibility = 'public' AND sl.approval_status = 'approved' AND s.status = 'active'";

  // The variant filter: in-stock OR pre-order. Both are purchasable.
  // Matches the canonical filter in routes/products.ts:fetchMarketplaceStatsFor.
  const VARIANT_FILTER = `(slv.available_quantity > 0 OR slv.is_pre_order = true)`;

  // Price filter (optional, applied at variant level).
  const priceFilter =
    maxPrice !== null ? `AND (COALESCE(slv.discount_price, slv.price) <= ${maxPrice})` : "";

  // Form filter (optional, applied at variant level). Case-insensitive.
  const formFilterClause =
    formFilter !== null ? `AND LOWER(slv.form) = '${formFilter.replace(/'/g, "''")}'` : "";

  // v1.8.0 (Part 17): SQL-level deterministic filters. Applied in the
  // listing_variants CTE's WHERE clause. NULL params skip the filter.
  // bloom_season: filter on products.bloom_season (joined via cp).
  // min_rating: filter on the seller's review-aggregate rating.
  // max_delivery_days: filter on sl.delivery_time_days (conservative —
  //   exclude NULL since the seller didn't commit).
  //
  // maxHeight + distinctProducts are post-SQL (parsing height is JS-side;
  // dedup-by-productName needs the ranked order).
  const bloomSeasonFilter =
    bloomSeason !== null
      ? `AND cp.product_bloom_season IS NOT NULL AND LOWER(cp.product_bloom_season) LIKE '%${bloomSeason.replace(/'/g, "''")}%'`
      : "";
  const minRatingFilter =
    minRating !== null
      ? `AND (SELECT ROUND(AVG(r.rating)::numeric, 1) FROM reviews r WHERE r.seller_listing_id = sl.id) >= ${minRating}`
      : "";
  const maxDeliveryDaysFilter =
    maxDeliveryDays !== null
      ? `AND sl.delivery_time_days IS NOT NULL AND sl.delivery_time_days <= ${maxDeliveryDays}`
      : "";

  try {
    // Single big parameterized query — fetches all candidate rows
    // (product × listing × variant × seller × review aggregate) in one
    // round-trip. We do the ranking + grouping in JS because Postgres
    // can't easily express the "top 3 variants per listing" + "top N
    // listings overall" nested ranking in pure SQL without window functions
    // + a CTE (which would be harder to read + maintain).
    //
    // We pass the tsquery via $1 (parameterized, no SQL injection risk).
    // The price/form filters are inlined because they're already sanitized
    // (numeric for price, escaped + lowercased for form).
    const sqlQuery = `
      WITH candidate_products AS (
        -- Find candidate VARIETIES via products.search_tsvector (same first-
        -- pass as search_catalog). The tsvector column is maintained by
        -- trigger (migration 0006) on title + description.
        SELECT p.id AS product_id, p.name AS product_name, p.slug AS product_slug,
               p.images AS product_images,
               p.bloom_season AS product_bloom_season,
               ts_rank_cd(p.search_tsvector, websearch_to_tsquery('english', $1)) AS text_rank
        FROM products p
        WHERE p.deleted_at IS NULL
          AND p.search_tsvector @@ websearch_to_tsquery('english', $1)
        ORDER BY text_rank DESC
        LIMIT 20
      ),
      listing_variants AS (
        -- JOIN candidate products → seller_listings → seller_listing_variants.
        -- Filtered to active listings + purchasable variants (in-stock or
        -- pre-order) + optional price/form/bloom_season/min_rating/
        -- max_delivery_days filters.
        SELECT
          cp.product_id, cp.product_name, cp.product_slug, cp.product_images, cp.text_rank,
          sl.id AS listing_id, sl.seller_id, sl.delivery_time_days,
          sl.warranty_days, sl.payment_method, sl.certification, sl.images AS listing_images,
          s.business_name AS seller_name, s.location AS seller_location,
          s.is_verified AS seller_is_verified,
          slv.id AS variant_id, slv.form, slv.root_type, slv.pot_size,
          slv.age, slv.height, slv.condition, slv.price, slv.discount_price,
          slv.available_quantity, slv.delivery_charge, slv.is_pre_order
        FROM candidate_products cp
        JOIN seller_listings sl ON sl.product_id = cp.product_id
        JOIN sellers s ON s.id = sl.seller_id
        JOIN seller_listing_variants slv ON slv.seller_listing_id = sl.id
        WHERE ${ACTIVE_LISTING_FILTER}
          AND ${VARIANT_FILTER}
          ${priceFilter}
          ${formFilterClause}
          ${bloomSeasonFilter}
          ${minRatingFilter}
          ${maxDeliveryDaysFilter}
      )
      SELECT
        lv.*,
        -- v6.2 Part 4 (Bug 1 fix): representative thumbnail for the card
        -- AND for the cart page (frontend passes this through to addItem).
        -- jsonb->>0 returns NULL when the array is empty, so COALESCE picks
        -- the product image only when the listing has no images of its own.
        COALESCE(lv.listing_images->>0, lv.product_images->>0) AS product_image,
        COALESCE((SELECT ROUND(AVG(r.rating)::numeric, 1) FROM reviews r WHERE r.seller_listing_id = lv.listing_id), 0) AS rating,
        (SELECT COUNT(*) FROM reviews r WHERE r.seller_listing_id = lv.listing_id) AS review_count
      FROM listing_variants lv
      ORDER BY lv.text_rank DESC, lv.listing_id, COALESCE(lv.discount_price, lv.price) ASC
    `;

    const result = await pool.query<{
      product_id: number;
      product_name: string;
      product_slug: string;
      product_images: string[] | null; // jsonb array → driver returns it as string[]
      text_rank: string;
      listing_id: number;
      seller_id: number;
      delivery_time_days: number | null;
      warranty_days: number | null;
      payment_method: string;
      certification: string | null;
      listing_images: string[] | null;
      seller_name: string;
      seller_location: string | null;
      seller_is_verified: boolean;
      variant_id: number;
      form: string | null;
      root_type: string | null;
      pot_size: string | null;
      age: string | null;
      height: string | null;
      condition: string | null;
      price: string;
      discount_price: string | null;
      available_quantity: number;
      delivery_charge: string;
      is_pre_order: boolean;
      product_image: string | null;
      rating: string;
      review_count: string;
    }>(sqlQuery, [tsquery]);

    if (result.rows.length === 0) {
      return {
        listings: [],
        totalCount: 0,
        query,
        buyerCity,
        buyerDistrict,
      };
    }

    // Group variants by listing (one listing can have many variants).
    const listingsMap = new Map<number, SellerListingResult>();
    const listingTextRanks = new Map<number, number>();

    for (const row of result.rows) {
      const listingId = row.listing_id;
      if (!listingsMap.has(listingId)) {
        const listing: SellerListingResult = {
          listingId,
          productId: row.product_id,
          productName: row.product_name,
          productSlug: row.product_slug,
          sellerId: row.seller_id,
          sellerName: row.seller_name,
          sellerLocation: row.seller_location,
          sellerIsVerified: row.seller_is_verified,
          rating: Number(row.rating) || 0,
          reviewCount: Number(row.review_count) || 0,
          deliveryTimeDays: row.delivery_time_days,
          warrantyDays: row.warranty_days,
          paymentMethod: row.payment_method,
          certification: row.certification,
          // v6.2 Part 4 (Bug 1 fix): the COALESCE in SQL already picked
          // the seller-listing image OR the product image; we just pass
          // it through. NULL when both arrays are empty (frontend uses
          // an SVG leaf placeholder in that case).
          productImage: row.product_image,
          variants: [],
          hasInStockVariant: false,
          hasPreOrderVariant: false,
          minPrice: null,
        };
        listingsMap.set(listingId, listing);
        listingTextRanks.set(listingId, Number(row.text_rank) || 0);
      }

      const listing = listingsMap.get(listingId)!;
      const price = Number(row.price);
      const discountPrice = row.discount_price !== null ? Number(row.discount_price) : null;
      const effectivePrice = discountPrice ?? price;

      listing.variants.push({
        variantId: row.variant_id,
        form: row.form,
        rootType: row.root_type,
        potSize: row.pot_size,
        age: row.age,
        height: row.height,
        condition: row.condition,
        price,
        discountPrice,
        availableQuantity: row.available_quantity,
        deliveryCharge: Number(row.delivery_charge),
        isPreOrder: row.is_pre_order,
      });

      if (row.available_quantity > 0) {
        listing.hasInStockVariant = true;
      }
      if (row.is_pre_order) {
        listing.hasPreOrderVariant = true;
      }
      if (listing.minPrice === null || effectivePrice < listing.minPrice) {
        listing.minPrice = effectivePrice;
      }
    }

    // Rank listings (see module doc for the full algorithm).
    // v6.2 Part 16: pass sortBy through so the weight matrix picks the
    // right distribution (maturity_desc → maturity-first, etc.).
    let ranked = rankListings(
      Array.from(listingsMap.values()),
      listingTextRanks,
      formFilter,
      buyerDistrict,
      sortBy,
    );

    // v1.8.0 (Part 17): post-SQL deterministic filters.
    //   - maxHeight: filter by parsed variants[].height (JS-side parsing
    //     via parseHeightToMaxValue). Applied AFTER ranking so the order
    //     is preserved; the listings that don't match are dropped.
    //   - distinctProducts: dedupe by productName, keep highest-ranked.
    //     Applied AFTER ranking so we keep the best listing per variety.
    // Both filters compose with the SQL-level filters (bloom_season,
    // min_rating, max_delivery_days) — the SQL filters trim the candidate
    // pool, these trim the ranked list.
    if (maxHeight !== undefined && maxHeight !== null) {
      ranked = ranked.filter((l) => computeMaxHeight(l) <= maxHeight);
    }
    if (distinctProducts) {
      const seen = new Set<string>();
      ranked = ranked.filter((l) => {
        if (seen.has(l.productName)) return false;
        seen.add(l.productName);
        return true;
      });
    }

    // Truncate to `limit`.
    const truncated = ranked.slice(0, limit);

    // Truncate variants per listing to 3 (cheapest first).
    for (const listing of truncated) {
      listing.variants.sort((a, b) => {
        const aPrice = a.discountPrice ?? a.price;
        const bPrice = b.discountPrice ?? b.price;
        return aPrice - bPrice;
      });
      if (listing.variants.length > MAX_VARIANTS_PER_LISTING) {
        listing.variants = listing.variants.slice(0, MAX_VARIANTS_PER_LISTING);
      }
    }

    // ─── v6.1 Part 4: fetch care summary if requested ────────────────────
    // When careSummary=true (MIXED intent), we fetch the top KB entry
    // (1 result, higher threshold 0.5, skip reranker for speed) and
    // include it as a 1-line care summary in the result. The LLM uses
    // this to give the user "buy this + here's how to care for it" in
    // ONE response, without a separate KB auto-inject DB call.
    //
    // Fail-safe: if the KB search errors OR returns nothing, careSummary
    // is null. The listings are still returned — the LLM can fall back
    // to its training data for care info (or the user can ask a follow-up
    // KNOWLEDGE question which triggers the existing KB auto-inject path).
    let careSummary: SellerListingSearchResult["careSummary"] = null;
    if (params.careSummary === true && truncated.length > 0) {
      try {
        // Use the ORIGINAL (non-lowercased) query for KB search — the KB
        // content is in mixed case, and searchKnowledgeBase's tsvector
        // handles case normalization internally. Passing the lowercased
        // query would lose case-sensitive proper nouns (e.g. "Alphonso").
        const originalQuery = (params.query ?? "").trim();
        const kbResults = await searchKnowledgeBase({
          query: originalQuery,
          maxResults: 1,
          minScore: 0.5, // higher than UNIFIED_MIN_SCORE (0.3) — we want only high-confidence care info
          skipRerank: true, // skip the reranker (saves ~50ms) — we just need 1 entry, not the perfect one
        });
        if (kbResults.length > 0) {
          const top = kbResults[0];
          // Truncate to ~200 chars (sentence boundary preferred).
          const CARE_SUMMARY_MAX_CHARS = 200;
          let content = top.entry.content.trim();
          if (content.length > CARE_SUMMARY_MAX_CHARS) {
            // Try to cut at a sentence boundary (period + space).
            const cut = content.lastIndexOf(".", CARE_SUMMARY_MAX_CHARS);
            content =
              cut > CARE_SUMMARY_MAX_CHARS - 50
                ? content.slice(0, cut + 1)
                : content.slice(0, CARE_SUMMARY_MAX_CHARS).trim() + "…";
          }
          careSummary = {
            content,
            entryId: top.entry.id,
            sourceTitle: top.source?.title,
          };
        }
      } catch (err) {
        // Non-fatal — the listings are still returned. The LLM can fall
        // back to its training data for care info, OR the user can ask a
        // follow-up KNOWLEDGE question which triggers the existing KB path.
        logger.warn(
          { err: (err as Error)?.message ?? String(err), query: query.slice(0, 80) },
          "sellerListingSearch: careSummary KB fetch failed (non-fatal — listings still returned)",
        );
      }
    }

    return {
      listings: truncated,
      totalCount: ranked.length,
      query,
      buyerCity,
      buyerDistrict,
      // v6.2 Part 16: echo sortBy back so the frontend FactCallout can
      // render the matching summary (e.g. maturity_desc → "Most mature: ...")
      // WITHOUT re-classifying the user's intent via keyword matching.
      sortBy,
      // v1.8.0 (Part 17/18): echo filtersApplied back so the frontend
      // FactCallout can append "Filtered by: <list>" to the callout.
      // Industry-standard "filter chips" pattern from ChatGPT Shopping +
      // Perplexity. Only includes args the LLM explicitly passed.
      filtersApplied: buildFiltersApplied(params, maxPrice, formFilter, limit),
      careSummary,
    };
  } catch (err) {
    logger.error(
      { err: (err as Error)?.message ?? String(err), query },
      "sellerListingSearch: SQL query failed",
    );
    return {
      listings: [],
      totalCount: 0,
      query,
      buyerCity,
      buyerDistrict,
      error: "search failed",
    };
  }
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

// ─── v6.2 Part 16: height-string parsing helper ─────────────────────────────
//
// Parses seller_listing_variants.height strings into a numeric "max height"
// for the maturity score. Examples (from real production data):
//   "1-3 ft"    -> 3   (range, max)
//   "4-6 ft"    -> 6
//   "8-12 m"    -> 12  (meters, treated same as ft — we only compare
//                       within the same unit implicitly; the data is
//                       consistently ft for mango trees)
//   "3 ft"      -> 3   (single value)
//   "mature"    -> 999 (word "mature" always ranks highest — implies
//                       the largest possible size)
//   "" / null   -> 0   (unrankable)
//   "sapling"   -> 0   (a sapling is the smallest form)
//
// The number returned is used ONLY for relative ranking within the same
// search call — it's not surfaced to the user. So we tolerate the
// unit ambiguity (ft vs m) because all variants of the same product
// type typically use the same unit.
//
// Industry standard: this is a deterministic, locale-aware parser. No
// LLM call needed for parsing — too expensive + too slow for a ranking
// signal. The model already DECIDED to use maturity_desc; we just need
// to execute that decision deterministically.
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
 */
function computeMaxHeight(listing: SellerListingResult): number {
  if (!listing.variants || listing.variants.length === 0) return 0;
  let max = 0;
  for (const v of listing.variants) {
    const h = parseHeightToMaxValue(v.height);
    if (h > max) max = h;
  }
  return max;
}

/**
 * Ranks listings by the weighted composite score.
 *
 * Score components (weights are documented at the top of this file):
 *   - in-stock bonus (DEFAULT_INSTOCK_WEIGHT = 1.0)
 *   - form match bonus (DEFAULT_FORM_MATCH_BONUS = 0.8) — only when the
 *     user explicitly asked for a specific form (e.g. "sapling")
 *   - price score (DEFAULT_PRICE_WEIGHT = 0.4) — lower price = higher score
 *   - rating score (DEFAULT_RATING_WEIGHT = 0.3) — higher rating = higher score
 *   - verified boost (DEFAULT_VERIFIED_BOOST = 0.2)
 *   - distance score (DEFAULT_DISTANCE_WEIGHT = 0.3) — Haversine distance
 *     from buyer's district to seller's district (Part 3).
 *
 * The score is normalized to [0, 1] for each component (except the boolean
 * bonuses). Final score = sum of normalized components. Higher = better.
 *
 * v6.1 Part 3: distance scoring now uses the full Haversine formula via
 * lib/bangladeshDistricts.ts. The buyer's district is resolved to lat/lng,
 * the seller's freeform location is parsed to extract their district, and
 * the great-circle distance is computed. Sellers in the buyer's district
 * get a 1.0 distance score; sellers 500+km away get a 0.0 score; the
 * range is linearly interpolated.
 *
 * When the buyer's district is unknown (anonymous user, or no default
 * address), distance scoring is skipped (no penalty for far-away sellers).
 *
 * v6.2 Part 16: `sortBy` controls the weight distribution. The LLM picks
 * the value based on the user's stated preference ("i dont care about
 * price" → maturity_desc, "best quality" → rating_desc, etc.). The
 * weight matrix is:
 *
 *   sortBy         | price | maturity | rating | distance | in-stock | form
 *   ---------------+-------+----------+--------+----------+----------+-----
 *   price_asc      | 0.4 ↓ | 0        | 0.3    | 0.3      | 1.0      | 0.8
 *   price_desc     | 0.4 ↑ | 0        | 0.3    | 0.3      | 1.0      | 0.8
 *   maturity_desc  | 0     | 0.4 ↑    | 0.3    | 0.2      | 1.0      | 0.8
 *   rating_desc    | 0     | 0        | 0.7    | 0.2      | 1.0      | 0.8
 *
 *   ↑ = higher value = higher score (positive direction)
 *   ↓ = lower value = higher score (inverted)
 *
 * Design notes:
 *   - In-stock + form-match bonuses are INVARIANT across sortBy — they're
 *     hard constraints (an out-of-stock listing is always worse; a form
 *     match is always better). Only the SOFT signals (price, maturity,
 *     rating, distance) get re-weighted.
 *   - When `sortBy === undefined` or "price_asc", behavior is IDENTICAL to
 *     pre-Part-16 (zero-risk backward compatibility).
 *   - Distance weight is reduced (not zeroed) for non-price sorts because
 *     proximity still matters — a 4-6 ft tree 500km away is still worse
 *     than one in the buyer's district, even when prioritizing maturity.
 *   - Text-relevance weight (the BM25 score from the first-pass tsvector
 *     search) is fixed at 0.5 across all sort modes — we never want
 *     irrelevant listings to rank high regardless of the sort preference.
 */
function rankListings(
  listings: SellerListingResult[],
  textRanks: Map<number, number>,
  formFilter: string | null,
  buyerDistrict: string | null,
  sortBy: "price_asc" | "price_desc" | "maturity_desc" | "rating_desc" | undefined,
): SellerListingResult[] {
  if (listings.length === 0) return [];

  // Pre-compute max/min for normalization.
  let maxPrice = -Infinity;
  let minPrice = Infinity;
  let maxRating = -Infinity;
  let minRating = Infinity;
  let maxTextRank = -Infinity;
  let minTextRank = Infinity;
  let maxHeight = -Infinity;
  let minHeight = Infinity;

  for (const l of listings) {
    if (l.minPrice !== null) {
      if (l.minPrice > maxPrice) maxPrice = l.minPrice;
      if (l.minPrice < minPrice) minPrice = l.minPrice;
    }
    if (l.rating > maxRating) maxRating = l.rating;
    if (l.rating < minRating) minRating = l.rating;
    const tr = textRanks.get(l.listingId) ?? 0;
    if (tr > maxTextRank) maxTextRank = tr;
    if (tr < minTextRank) minTextRank = tr;
    // v6.2 Part 16: pre-compute maturity range for maturity_desc sort.
    const mh = computeMaxHeight(l);
    if (mh > maxHeight) maxHeight = mh;
    if (mh < minHeight) minHeight = mh;
  }

  // Avoid divide-by-zero.
  const priceRange = maxPrice - minPrice || 1;
  const ratingRange = maxRating - minRating || 1;
  const textRankRange = maxTextRank - minTextRank || 1;
  const heightRange = maxHeight - minHeight || 1;

  // v6.2 Part 16: pick the weight matrix based on sortBy. The matrix is
  // documented in the function header above. `undefined` and "price_asc"
  // both use the legacy default (zero behavior change for existing callers).
  const weights = (() => {
    switch (sortBy) {
      case "price_desc":
        return {
          price: DEFAULT_PRICE_WEIGHT, // higher price = higher score (non-inverted below)
          maturity: 0,
          rating: DEFAULT_RATING_WEIGHT,
          distance: DEFAULT_DISTANCE_WEIGHT,
          priceInverted: false, // false = higher price wins
        };
      case "maturity_desc":
        return {
          price: 0,
          maturity: DEFAULT_PRICE_WEIGHT, // re-use 0.4 weight slot
          rating: DEFAULT_RATING_WEIGHT,
          distance: 0.2,
          priceInverted: true,
        };
      case "rating_desc":
        return {
          price: 0,
          maturity: 0,
          rating: 0.7, // boosted from 0.3 to 0.7 — primary signal
          distance: 0.2,
          priceInverted: true,
        };
      case "price_asc":
      default:
        return {
          price: DEFAULT_PRICE_WEIGHT,
          maturity: 0,
          rating: DEFAULT_RATING_WEIGHT,
          distance: DEFAULT_DISTANCE_WEIGHT,
          priceInverted: true, // true = lower price wins (legacy behavior)
        };
    }
  })();

  // v6.1 Part 3: pre-compute seller district + distance from buyer.
  // This avoids re-computing the Haversine for each scoring pass.
  // Sellers whose location can't be parsed to a district get distance =
  // Infinity (effectively excluded from distance sort, but still ranked
  // by other factors).
  const DISTANCE_MAX_KM = 500; // 500km = 0.0 distance score; 0km = 1.0.
  const distancesByListingId = new Map<number, number>();
  if (buyerDistrict !== null) {
    for (const l of listings) {
      const sellerDistrict = extractDistrictFromLocation(l.sellerLocation);
      if (sellerDistrict) {
        const dist = distanceBetweenDistricts(buyerDistrict, sellerDistrict.name);
        distancesByListingId.set(l.listingId, dist);
      } else {
        distancesByListingId.set(l.listingId, Infinity);
      }
    }
  }

  const scored = listings.map((l) => {
    let score = 0;

    // Text relevance (from the first-pass tsvector search). Weight = 0.5
    // (high — we want the most relevant varieties first). INVARIANT across
    // sortBy — we never want irrelevant listings to rank high.
    const tr = textRanks.get(l.listingId) ?? 0;
    score += 0.5 * ((tr - minTextRank) / textRankRange);

    // In-stock bonus. INVARIANT across sortBy.
    if (l.hasInStockVariant) {
      score += DEFAULT_INSTOCK_WEIGHT;
    }

    // Form match bonus (only when the user asked for a specific form).
    // INVARIANT across sortBy.
    if (formFilter !== null) {
      const hasFormMatch = l.variants.some(
        (v) => v.form !== null && v.form.toLowerCase() === formFilter,
      );
      if (hasFormMatch) {
        score += DEFAULT_FORM_MATCH_BONUS;
      }
    }

    // Price score. Direction depends on sortBy:
    //   - price_asc  → lower price wins (inverted: 1 - normalized)
    //   - price_desc → higher price wins (non-inverted: normalized)
    //   - maturity_desc / rating_desc → price weight = 0 (skip entirely)
    if (weights.price > 0 && l.minPrice !== null) {
      const normalizedPrice = (l.minPrice - minPrice) / priceRange;
      const priceScore = weights.priceInverted ? 1 - normalizedPrice : normalizedPrice;
      score += weights.price * priceScore;
    }

    // v6.2 Part 16: Maturity score (largest height variant). Only active
    // when sortBy === "maturity_desc". Higher height wins (non-inverted).
    if (weights.maturity > 0) {
      const h = computeMaxHeight(l);
      const maturityScore = (h - minHeight) / heightRange;
      score += weights.maturity * maturityScore;
    }

    // Rating score. Weight is 0.3 for price_asc / price_desc / maturity_desc,
    // boosted to 0.7 for rating_desc.
    const ratingScore = (l.rating - minRating) / ratingRange;
    score += weights.rating * ratingScore;

    // Verified seller boost. INVARIANT across sortBy.
    if (l.sellerIsVerified) {
      score += DEFAULT_VERIFIED_BOOST;
    }

    // Distance score (v6.1 Part 3: Haversine). Weight is 0.3 for the
    // price_asc default, reduced to 0.2 for non-price sorts (proximity
    // still matters but isn't the primary signal).
    if (weights.distance > 0 && buyerDistrict !== null) {
      const dist = distancesByListingId.get(l.listingId) ?? Infinity;
      if (Number.isFinite(dist)) {
        const distanceScore = Math.max(0, 1 - dist / DISTANCE_MAX_KM);
        score += weights.distance * distanceScore;
      }
      // Infinity (unknown seller district) → no distance bonus. The
      // listing still ranks by other factors (rating, price, etc.).
    }

    return { listing: l, score };
  });

  // Sort by score DESC. Tie-break depends on sortBy so the tie-break is
  // consistent with the user's intent (e.g. maturity_desc ties broken by
  // larger height; price_asc ties broken by lower price).
  const tieBreakDirection = sortBy === "price_desc" ? -1 : sortBy === "maturity_desc" ? -1 : 1;
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Price tie-break (default direction = lower price first = +1).
    const aPrice = a.listing.minPrice ?? Number.MAX_SAFE_INTEGER;
    const bPrice = b.listing.minPrice ?? Number.MAX_SAFE_INTEGER;
    return tieBreakDirection * (aPrice - bPrice);
  });

  return scored.map((s) => s.listing);
}
