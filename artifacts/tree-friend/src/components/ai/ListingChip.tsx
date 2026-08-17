/**
 * ListingChips — clickable seller-listing mentions below AI replies.
 *
 * v6.1 (Part 2): created alongside the new search_seller_listings tool.
 * Distinct from ProductChips — these deep-link to the SellerListingDetailPage
 * (one click to the buyable listing → add to cart), not the variety catalog
 * search.
 *
 * UX:
 *   - Green accent (matches ProductChips but slightly different shade to
 *     visually distinguish purchase-intent chips from knowledge-intent ones).
 *   - Shows the AI-written display text (e.g. "Alphonso Mango — 3ft sapling, 450 BDT").
 *   - Hover lift + shopping-bag icon (vs. ProductChips' external-link icon).
 *   - Responsive max-width (BUG-I6 pattern — no hardcoded pixel magic numbers).
 *
 * Behavior:
 *   - Fetches the productId for each listingId via GET /api/ai/listings-by-ids
 *     (batched — one request for up to 10 chips). The productId is needed
 *     to build the deep-link URL /products/:productId/listings/:listingId.
 *   - If a listingId can't be resolved (deleted, hidden, rejected after the
 *     AI cited it), the chip renders disabled with a tooltip explaining why.
 *   - If a listing has no qualifying variant (out of stock + no pre-order),
 *     the chip renders with a "sold out" badge but still links (the detail
 *     page shows the seller's contact info for restock notifications).
 *
 * Industry standard: OpenAI's "function result" chips, Vercel AI SDK's
 * tool-call renderers. The pattern is: parse the citation, fetch minimal
 * metadata, render a clickable chip that deep-links to the relevant page.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ShoppingBag, AlertCircle } from "lucide-react";
import type { ListingMention } from "./parseMessage";

interface ListingChipsProps {
  /** Mentions extracted via extractListingMentions(). */
  mentions: ListingMention[];
  /** Optional callback to close the parent panel on navigation. */
  onClose?: () => void;
}

interface ListingMeta {
  id: number;
  productId: number;
  productName: string;
  productSlug: string;
  sellerName: string;
  price: string | null;
  currency: string;
  image: string | null;
  hasQualifyingVariant: boolean;
}

/**
 * Fetches listing metadata for a batch of listing IDs.
 *
 * Single request for up to 10 IDs — the backend hard-caps at 10 to prevent
 * abuse. The request is fire-and-forget (best-effort) — any error returns
 * an empty map so chips render as disabled rather than crashing the chat.
 */
async function fetchListingMeta(ids: number[], apiBase: string): Promise<Map<number, ListingMeta>> {
  if (ids.length === 0) return new Map();
  try {
    const res = await fetch(`${apiBase}/api/ai/listings-by-ids?ids=${ids.join(",")}`);
    if (!res.ok) return new Map();
    const data = (await res.json()) as { listings: ListingMeta[] };
    return new Map(data.listings.map((l) => [l.id, l]));
  } catch {
    // Network error / endpoint unavailable (older deployment). Chips will
    // fall back to a disabled state with a tooltip.
    return new Map();
  }
}

export function ListingChips({ mentions, onClose }: ListingChipsProps) {
  const [, navigate] = useLocation();
  const [metaMap, setMetaMap] = useState<Map<number, ListingMeta>>(new Map());

  const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

  // Dedupe mentions by listingId (defensive — extractListingMentions already
  // dedupes, but if a parent passes un-deduped mentions we still want to
  // avoid duplicate fetches + chips).
  const uniqueMentions = useMemo(() => {
    const seen = new Set<number>();
    const out: ListingMention[] = [];
    for (const m of mentions) {
      if (!seen.has(m.listingId)) {
        seen.add(m.listingId);
        out.push(m);
      }
    }
    return out;
  }, [mentions]);

  // Fetch listing metadata in one batched request when mentions change.
  useEffect(() => {
    if (uniqueMentions.length === 0) return;
    let cancelled = false;
    fetchListingMeta(
      uniqueMentions.map((m) => m.listingId),
      apiBase,
    ).then((map) => {
      if (!cancelled) setMetaMap(map);
    });
    return () => {
      cancelled = true;
    };
  }, [uniqueMentions, apiBase]);

  if (uniqueMentions.length === 0) return null;

  const handleClick = (mention: ListingMention) => {
    const meta = metaMap.get(mention.listingId);
    if (!meta) {
      // Listing not resolved yet (still loading) or not found (deleted/hidden).
      // Don't navigate — let the user see the disabled state.
      return;
    }
    onClose?.();
    // Deep-link to the SellerListingDetailPage route:
    //   /products/:productId/listings/:listingId
    navigate(`/products/${meta.productId}/listings/${mention.listingId}`);
  };

  return (
    <div className="flex flex-wrap gap-1.5 mt-2.5">
      {uniqueMentions.map((mention) => {
        const meta = metaMap.get(mention.listingId);
        const isLoading = !meta && metaMap.size === 0;
        const isNotFound = !meta && metaMap.size > 0;
        const isSoldOut = meta && !meta.hasQualifyingVariant;
        // Buyable = meta exists + has qualifying variant. Disabled otherwise.
        const isDisabled = !meta || isSoldOut;

        return (
          <button
            key={mention.listingId}
            type="button"
            onClick={() => handleClick(mention)}
            disabled={isDisabled}
            className={`group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium transition-all ${
              isDisabled
                ? "bg-muted/30 border-muted/20 text-muted-foreground cursor-not-allowed"
                : "bg-success/5 hover:bg-success/10 border-success/30 hover:border-success/50 text-success hover:shadow-sm"
            }`}
            title={
              isLoading
                ? "Loading listing details..."
                : isNotFound
                  ? "This listing is no longer available (deleted or hidden by the seller)."
                  : isSoldOut
                    ? "Sold out — visit the listing page to set a stock alert."
                    : `View this listing on TreeFriend`
            }
          >
            {isSoldOut ? (
              <AlertCircle className="h-3 w-3 opacity-70" />
            ) : (
              <ShoppingBag
                className={`h-3 w-3 ${isLoading ? "animate-pulse" : "opacity-70 group-hover:opacity-100"} transition-opacity`}
              />
            )}
            {/* Responsive max-width (BUG-I6 pattern). */}
            <span className="max-w-[160px] sm:max-w-[220px] truncate">{mention.display}</span>
            {isSoldOut && (
              <span className="text-[9px] uppercase tracking-wide bg-muted/50 rounded px-1 py-0.5">
                sold out
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
