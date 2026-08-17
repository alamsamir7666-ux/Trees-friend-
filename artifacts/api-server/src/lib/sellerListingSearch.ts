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
        -- pre-order) + optional price/form filters.
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
    const ranked = rankListings(
      Array.from(listingsMap.values()),
      listingTextRanks,
      formFilter,
      buyerDistrict,
    );

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
 */
function rankListings(
  listings: SellerListingResult[],
  textRanks: Map<number, number>,
  formFilter: string | null,
  buyerDistrict: string | null,
): SellerListingResult[] {
  if (listings.length === 0) return [];

  // Pre-compute max/min for normalization.
  let maxPrice = -Infinity;
  let minPrice = Infinity;
  let maxRating = -Infinity;
  let minRating = Infinity;
  let maxTextRank = -Infinity;
  let minTextRank = Infinity;

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
  }

  // Avoid divide-by-zero.
  const priceRange = maxPrice - minPrice || 1;
  const ratingRange = maxRating - minRating || 1;
  const textRankRange = maxTextRank - minTextRank || 1;

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
    // (high — we want the most relevant varieties first).
    const tr = textRanks.get(l.listingId) ?? 0;
    score += 0.5 * ((tr - minTextRank) / textRankRange);

    // In-stock bonus.
    if (l.hasInStockVariant) {
      score += DEFAULT_INSTOCK_WEIGHT;
    }

    // Form match bonus (only when the user asked for a specific form).
    if (formFilter !== null) {
      const hasFormMatch = l.variants.some(
        (v) => v.form !== null && v.form.toLowerCase() === formFilter,
      );
      if (hasFormMatch) {
        score += DEFAULT_FORM_MATCH_BONUS;
      }
    }

    // Price score (lower price = higher score). Inverted.
    if (l.minPrice !== null) {
      const priceScore = 1 - (l.minPrice - minPrice) / priceRange;
      score += DEFAULT_PRICE_WEIGHT * priceScore;
    }

    // Rating score.
    const ratingScore = (l.rating - minRating) / ratingRange;
    score += DEFAULT_RATING_WEIGHT * ratingScore;

    // Verified seller boost.
    if (l.sellerIsVerified) {
      score += DEFAULT_VERIFIED_BOOST;
    }

    // Distance score (v6.1 Part 3: Haversine).
    // Linear scale: 0km = 1.0 (full bonus), DISTANCE_MAX_KM = 0.0 (no bonus).
    // > DISTANCE_MAX_KM or Infinity (unknown district) = 0.0.
    if (buyerDistrict !== null) {
      const dist = distancesByListingId.get(l.listingId) ?? Infinity;
      if (Number.isFinite(dist)) {
        const distanceScore = Math.max(0, 1 - dist / DISTANCE_MAX_KM);
        score += DEFAULT_DISTANCE_WEIGHT * distanceScore;
      }
      // Infinity (unknown seller district) → no distance bonus. The
      // listing still ranks by other factors (rating, price, etc.).
    }

    return { listing: l, score };
  });

  // Sort by score DESC. Tie-break by minPrice ASC (cheaper first when
  // scores are equal).
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aPrice = a.listing.minPrice ?? Number.MAX_SAFE_INTEGER;
    const bPrice = b.listing.minPrice ?? Number.MAX_SAFE_INTEGER;
    return aPrice - bPrice;
  });

  return scored.map((s) => s.listing);
}
