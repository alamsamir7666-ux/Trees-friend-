/**
 * ListingGridCard — rich inline UI for search_seller_listings tool results.
 *
 * v6.2 Part 2: renders 3-5 seller listings as a grid of compact cards —
 * seller name, location, price, variant info, rating, in-stock badge,
 * and a deep-link button to the SellerListingDetailPage.
 *
 * Data shape (from sellerListingSearch.ts via executeTool):
 *   { listings: SellerListingResult[], totalCount, query, buyerCity,
 *     buyerDistrict, careSummary?, error? }
 *
 * Each listing:
 *   { listingId, productId, productName, productSlug, sellerName,
 *     sellerLocation, sellerIsVerified, rating, reviewCount,
 *     deliveryTimeDays, warrantyDays, paymentMethod, certification,
 *     variants: [{ variantId, form, height, price, discountPrice,
 *       availableQuantity, isPreOrder }], hasInStockVariant,
 *     hasPreOrderVariant, minPrice }
 */
import { ShoppingBag, MapPin, Star, BadgeCheck, Truck } from "lucide-react";
import { useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface ListingVariant {
  variantId: number;
  form: string | null;
  height: string | null;
  price: number;
  discountPrice: number | null;
  availableQuantity: number;
  isPreOrder: boolean;
}

interface ListingData {
  listingId: number;
  productId: number;
  productName: string;
  productSlug: string;
  sellerName: string;
  sellerLocation: string | null;
  sellerIsVerified: boolean;
  rating: number;
  reviewCount: number;
  deliveryTimeDays: number | null;
  warrantyDays: number | null;
  paymentMethod: string;
  certification: string | null;
  variants: ListingVariant[];
  hasInStockVariant: boolean;
  hasPreOrderVariant: boolean;
  minPrice: number | null;
}

interface SearchResult {
  listings: ListingData[];
  totalCount: number;
  query: string;
  buyerCity: string | null;
  buyerDistrict: string | null;
  careSummary?: { content: string; sourceTitle?: string } | null;
  error?: string;
}

function formatPrice(price: number | null): string {
  if (price === null || price === undefined) return "—";
  return `৳${price.toLocaleString()}`;
}

function formatStock(listing: ListingData): string {
  if (listing.hasInStockVariant && listing.hasPreOrderVariant) return "In stock + pre-order";
  if (listing.hasInStockVariant) return "In stock";
  if (listing.hasPreOrderVariant) return "Pre-order";
  return "Out of stock";
}

function ListingCard({ listing, onClose }: { listing: ListingData; onClose?: () => void }) {
  const [, navigate] = useLocation();
  const topVariant = listing.variants?.[0];
  const effectivePrice = topVariant?.discountPrice ?? topVariant?.price ?? listing.minPrice;

  return (
    <div className="border rounded-lg p-3 bg-card hover:shadow-md transition-shadow">
      {/* ─── Seller info ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-medium truncate">{listing.sellerName}</span>
          {listing.sellerIsVerified && (
            <BadgeCheck className="h-3.5 w-3.5 text-primary flex-shrink-0" />
          )}
        </div>
        <Badge
          variant="outline"
          className={`text-[9px] flex-shrink-0 ${
            listing.hasInStockVariant
              ? "bg-success/10 text-success border-success/20"
              : "bg-muted text-muted-foreground border-muted/20"
          }`}
        >
          {formatStock(listing)}
        </Badge>
      </div>

      {/* ─── Location + rating ──────────────────────────────────── */}
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground mb-2">
        {listing.sellerLocation && (
          <span className="flex items-center gap-0.5">
            <MapPin className="h-2.5 w-2.5" />
            {listing.sellerLocation}
          </span>
        )}
        {listing.reviewCount > 0 && (
          <span className="flex items-center gap-0.5">
            <Star className="h-2.5 w-2.5 fill-yellow-400 text-yellow-400" />
            {listing.rating.toFixed(1)} ({listing.reviewCount})
          </span>
        )}
        {listing.deliveryTimeDays !== null && (
          <span className="flex items-center gap-0.5">
            <Truck className="h-2.5 w-2.5" />
            {listing.deliveryTimeDays}d
          </span>
        )}
      </div>

      {/* ─── Variant info ──────────────────────────────────────── */}
      {topVariant && (
        <div className="text-xs text-muted-foreground mb-2">
          {topVariant.form && <span className="font-medium">{topVariant.form}</span>}
          {topVariant.height && <span> · {topVariant.height}</span>}
          {topVariant.isPreOrder && <span className="text-warning"> · pre-order</span>}
        </div>
      )}

      {/* ─── Price + button ────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <span className="text-base font-bold">{formatPrice(effectivePrice)}</span>
          {topVariant?.discountPrice !== null && topVariant?.discountPrice !== undefined && (
            <span className="text-[10px] text-muted-foreground line-through ml-1">
              {formatPrice(topVariant.price)}
            </span>
          )}
        </div>
        <Button
          variant="default"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            onClose?.();
            navigate(`/products/${listing.productId}/listings/${listing.listingId}`);
          }}
        >
          <ShoppingBag className="h-3 w-3 mr-1" />
          View
        </Button>
      </div>
    </div>
  );
}

export function ListingGridCard({ data, onClose }: { data: unknown; onClose?: () => void }) {
  const result = data as SearchResult;

  if (!result || !result.listings || result.listings.length === 0) {
    return (
      <div className="border rounded-lg p-3 bg-muted/30 text-xs text-muted-foreground text-center">
        No listings found for "{result?.query ?? "your search"}". Try browsing the{" "}
        <a href="/products" className="text-primary hover:underline">
          catalog
        </a>
        .
      </div>
    );
  }

  return (
    <div className="space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* ─── Care summary (if present — MIXED intent) ─────────────── */}
      {result.careSummary?.content && (
        <div className="border-l-2 border-success/40 pl-3 py-1 text-xs text-muted-foreground">
          <span className="text-success font-medium">💡 Care tip: </span>
          {result.careSummary.content}
        </div>
      )}

      {/* ─── Listing grid ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {result.listings.slice(0, 5).map((listing) => (
          <ListingCard key={listing.listingId} listing={listing} onClose={onClose} />
        ))}
      </div>

      {/* ─── Summary bar ────────────────────────────────────────── */}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground px-1">
        <span>
          {result.listings.length} of {result.totalCount} listings
          {result.buyerDistrict && ` near ${result.buyerDistrict}`}
        </span>
        <a href="/products" className="text-primary hover:underline">
          Browse all
        </a>
      </div>
    </div>
  );
}
