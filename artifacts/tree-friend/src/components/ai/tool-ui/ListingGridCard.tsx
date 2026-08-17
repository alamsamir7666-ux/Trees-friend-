/**
 * ListingGridCard — rich inline UI for search_seller_listings tool results.
 *
 * v6.2 Part 2: renders 3-5 seller listings as a grid of compact cards —
 * seller name, location, price, variant info, rating, in-stock badge,
 * and a deep-link button to the SellerListingDetailPage.
 *
 * v6.2 Part 3: added a "Cart" button next to "View" on each card.
 *
 * v6.2 Part 4 (this revision): Bug 1 + Bug 2 industry-standard fixes.
 *
 *   Bug 1 (image="" hard-coded) — the backend now returns `productImage`
 *   (seller-listing image with product-image fallback, NULL when both
 *   arrays are empty). We pass it through to the cart AND render it as
 *   a 56×56 thumbnail in the card header. When NULL, we use a small
 *   inline SVG leaf as a data-URI placeholder — the cart page never
 *   renders a broken <img>.
 *
 *   Bug 2 (signed-in users get silent failure) — signed-in users now go
 *   through the server cart via the generated `useAddToCart` mutation
 *   (POST /api/cart/items). On success we invalidate `getGetCartQueryKey()`
 *   so the navbar badge + cart page refresh immediately. On error we
 *   surface the server's message in a destructive toast. The button is
 *   disabled + shows a spinner while pending (prevents double-clicks),
 *   and shows a ✓ check for 1.5s after success (Amazon/Daraz pattern).
 *   Guest users keep the localStorage cart path (no behavior change).
 *
 * Data shape (from sellerListingSearch.ts via executeTool):
 *   { listings: SellerListingResult[], totalCount, query, buyerCity,
 *     buyerDistrict, careSummary?, error? }
 *
 * Each listing:
 *   { listingId, productId, productName, productSlug, sellerName,
 *     sellerLocation, sellerIsVerified, rating, reviewCount,
 *     deliveryTimeDays, warrantyDays, paymentMethod, certification,
 *     productImage (string | null), variants: [...], hasInStockVariant,
 *     hasPreOrderVariant, minPrice }
 */
import { useState, useMemo } from "react";
import { ShoppingBag, MapPin, Star, BadgeCheck, Truck, Plus, Check, Loader2 } from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { useAddToCart, getGetCartQueryKey } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useGuestCart } from "@/hooks/useGuestCart";
import {
  ChatVariantPickerDialog,
  shouldShowVariantPicker,
  type ChatListingVariant,
} from "./ChatVariantPickerDialog";

interface ListingVariant {
  variantId: number;
  form: string | null;
  height: string | null;
  price: number;
  discountPrice: number | null;
  availableQuantity: number;
  deliveryCharge: number;
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
  /**
   * v6.2 Part 4 (Bug 1 fix): representative thumbnail URL, or NULL when
   * both the seller-listing and product image arrays are empty. In the
   * NULL case we render an SVG leaf placeholder (FALLBACK_THUMBNAIL).
   */
  productImage?: string | null;
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

/**
 * Inline SVG leaf placeholder used when a listing has no images.
 *
 * Why a data URI instead of a remote URL:
 *   - Works offline (PWA / service worker).
 *   - No extra HTTP request — instant render.
 *   - Survives CDN outages.
 *   - The cart page receives the same string via `addItem.image`, so a
 *     broken-image icon never appears in /cart either.
 *
 * Color: muted green to match the brand. Sized 200×200 — the card
 * renders it at 56×56 via `object-cover`; the cart renders it smaller.
 */
const FALLBACK_THUMBNAIL =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="none">` +
      `<rect width="200" height="200" fill="#f1f5f9"/>` +
      `<path d="M100 30 C 60 60, 60 120, 100 170 C 140 120, 140 60, 100 30 Z" ` +
      `fill="#86efac" stroke="#16a34a" stroke-width="3"/>` +
      `<path d="M100 30 L 100 170" stroke="#15803d" stroke-width="2"/>` +
      `</svg>`,
  );

/**
 * Per-card "add to cart" status. Drives the button label/icon:
 *   idle    → "Cart" with Plus icon
 *   pending → spinner (disabled)
 *   added   → ✓ check (disabled, reverts to idle after 1.5s)
 *
 * This is per-card state (not global) so each listing card tracks its own
 * add-status independently — multiple cards can be in different states
 * simultaneously, which matches user mental models ("the mango one is
 * added, the guava one is loading").
 */
type AddStatus = "idle" | "pending" | "added";

function ListingCard({ listing, onClose }: { listing: ListingData; onClose?: () => void }) {
  const [, navigate] = useLocation();
  const guestCart = useGuestCart();
  const qc = useQueryClient();

  // v6.2 Part 4 (Bug 2 fix): use Clerk's `useAuth().isSignedIn` as the
  // gate. It's a `boolean` (no undefined) — Clerk hydrates from its own
  // store on first render, so the gate is reliable from the first paint.
  // We do NOT use `useMe().data` here because that triggers an extra
  // GET /api/users/me round-trip — we only need the boolean, and the
  // generated `useAddToCart` mutation will attach the bearer token via
  // the global `setAuthTokenGetter` (registered in App.tsx).
  const { isSignedIn } = useAuth();

  const [addStatus, setAddStatus] = useState<AddStatus>("idle");

  // v6.2 Part 5 (Bug 4 fix): picker state for multi-variant listings.
  // When the buyer clicks Cart on a listing with 2+ selectable variants,
  // we open the ChatVariantPickerDialog. On confirm, the chosen variant
  // flows through `doAddToCart(variant)` — same path as a direct add.
  const [pickerOpen, setPickerOpen] = useState(false);

  // The generated mutation. `useAddToCart` returns a standard TanStack
  // Query mutation — we wire onSuccess/onError here so the UI feedback
  // (toast, checkmark, invalidation) lives next to the trigger.
  //
  // The mutation is created unconditionally (Rules of Hooks), but only
  // `.mutate()` is called when isSignedIn === true. TanStack Query keeps
  // the mutation instance cached, so this doesn't waste resources.
  const addToCartMutation = useAddToCart({
    mutation: {
      onSuccess: () => {
        // Industry-standard (Shopify/Amazon): invalidate the cart query
        // so the navbar badge + cart page reflect the new line instantly.
        // The query key is exported from the generated client
        // (`getGetCartQueryKey`) so it stays in sync with the OpenAPI spec.
        qc.invalidateQueries({ queryKey: getGetCartQueryKey() });
        setAddStatus("added");
        toast.success(`${listing.productName} added to cart`, {
          description: `${lastAddedVariant?.form ?? "Variant"} · ${formatPrice(lastAddedVariant?.discountPrice ?? lastAddedVariant?.price ?? effectivePrice)}`,
          action: {
            label: "View cart",
            onClick: () => navigate("/cart"),
          },
        });
        // Revert the ✓ checkmark after 1.5s — Amazon/Daraz pattern.
        // Long enough to register visually, short enough that the user
        // can immediately add another item without confusion.
        window.setTimeout(() => setAddStatus("idle"), 1500);
      },
      onError: (err: unknown) => {
        setAddStatus("idle");
        // The generated client throws `ApiError` (from custom-fetch.ts)
        // which carries `.status`, `.statusText`, and the server's JSON
        // error body. Its `.message` is already a friendly string like
        // "HTTP 400 Bad Request: Cart is full (max 50 lines)".
        const message =
          err instanceof Error
            ? err.message.replace(/^HTTP \d+[^:]*:\s*/, "")
            : "Couldn't add to cart";
        toast.error("Couldn't add to cart", { description: message });
      },
    },
  });

  const topVariant = listing.variants?.[0];
  const effectivePrice = topVariant?.discountPrice ?? topVariant?.price ?? listing.minPrice;
  // Safety: require topVariant to actually exist (not just the boolean
  // flags). A data-shape bug where hasInStockVariant=true but variants=[]
  // would otherwise render a button that silently no-ops on click.
  const canAddToCart = !!topVariant && (listing.hasInStockVariant || listing.hasPreOrderVariant);

  // v6.2 Part 5 (Bug 4 fix): if there are 2+ selectable variants, the
  // Cart button opens the picker instead of adding directly. The buyer
  // must choose which variant (Sapling vs Grafted vs Potted, etc.) —
  // silently adding variants[0] is a UX regression (the buyer may want
  // a different size/price).
  const showPicker = shouldShowVariantPicker(listing.variants as ChatListingVariant[]);

  // Track the most recently added variant so the success toast shows
  // the right variant label + price (not always topVariant — could be
  // any variant the buyer picked in the dialog).
  const [lastAddedVariant, setLastAddedVariant] = useState<ListingVariant | null>(null);

  // The image to render in the card thumbnail AND pass to the cart. NULL
  // image (both backend arrays empty) → SVG leaf placeholder so the cart
  // page never shows a broken-image icon.
  const thumbnail = listing.productImage || FALLBACK_THUMBNAIL;

  // ─── Core add-to-cart implementation (shared by direct + picker paths) ──
  // Extracted so the picker's onConfirm and the direct Cart click share
  // the exact same logic — no risk of drift between the two paths.
  const doAddToCart = (variant: ListingVariant) => {
    setLastAddedVariant(variant);
    const variantEffectivePrice = variant.discountPrice ?? variant.price;

    if (isSignedIn) {
      // ─── Signed-in path: server cart via POST /api/cart/items ─────────
      setAddStatus("pending");
      addToCartMutation.mutate({
        data: {
          productId: listing.productId,
          // Marketplace variant — the backend derives sellerListingId
          // from the variant's own FK (see AddToCartBody Zod schema).
          sellerListingVariantId: variant.variantId,
          quantity: 1,
        },
      });
      return;
    }

    // ─── Guest path: localStorage cart ────────────────────────────────────
    // Bug 1 fix: pass the real thumbnail URL (or SVG fallback) so the
    // cart page can render an <img> for this line.
    guestCart.addItem({
      productId: listing.productId,
      sellerListingVariantId: variant.variantId,
      quantity: 1,
      name: listing.productName,
      price: variant.price,
      discountPrice: variant.discountPrice,
      image: thumbnail,
      deliveryCharge: variant.deliveryCharge,
    });
    setAddStatus("added");
    toast.success(`${listing.productName} added to cart`, {
      description: `${variant.form ?? "Variant"} · ${formatPrice(variantEffectivePrice)}`,
      action: {
        label: "View cart",
        onClick: () => navigate("/cart"),
      },
    });
    window.setTimeout(() => setAddStatus("idle"), 1500);
  };

  // Stable click handler — only the body changes between guest/signed-in.
  // stopPropagation prevents the card's own onClick (currently none, but
  // defensive) from also firing when the button is clicked.
  const handleAddToCart = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!topVariant) return;
    if (addStatus === "pending" || addToCartMutation.isPending) return;

    // v6.2 Part 5 (Bug 4 fix): multi-variant listing → open picker.
    // Single-variant (or single-selectable-variant) listing → direct add.
    if (showPicker) {
      setPickerOpen(true);
      return;
    }

    doAddToCart(topVariant);
  };

  // Picker confirm handler — called by ChatVariantPickerDialog when the
  // buyer picks a variant + clicks "Add to Bag".
  const handlePickerConfirm = (variant: ChatListingVariant) => {
    // Re-find the variant from listing.variants (not the picker's copy)
    // so we use the canonical ListingVariant shape (in case the picker's
    // ChatListingVariant type drifts from ListingVariant in the future).
    const found = listing.variants.find((v) => v.variantId === variant.variantId);
    if (!found) return;
    doAddToCart(found);
  };

  // Button label/icon depends on status — keeps the button affordance
  // consistent with what's happening (idle=ready, pending=loading,
  // added=confirmed).
  const buttonContent = useMemo(() => {
    if (addStatus === "pending" || addToCartMutation.isPending) {
      return <Loader2 className="h-3 w-3 mr-0.5 animate-spin" />;
    }
    if (addStatus === "added") {
      return <Check className="h-3 w-3 mr-0.5" />;
    }
    return <Plus className="h-3 w-3 mr-0.5" />;
  }, [addStatus, addToCartMutation.isPending]);

  const buttonLabel = addStatus === "added" ? "Added" : "Cart";
  const isPending = addStatus === "pending" || addToCartMutation.isPending;

  return (
    <>
      <div className="border rounded-lg p-3 bg-card hover:shadow-md transition-shadow">
        {/* ─── Top row: thumbnail + seller + stock badge ──────────────────── */}
        <div className="flex items-start gap-2 mb-2">
          <img
            src={thumbnail}
            alt={listing.productName}
            loading="lazy"
            className="h-12 w-12 rounded-md object-cover flex-shrink-0 bg-muted"
            // Hide broken-image icon if the URL fails to load (e.g.
            // Cloudinary returns 404 for a deleted asset). We swap to the
            // SVG fallback via onError. This is the industry-standard
            // pattern (Amazon, Shopify) — they all replace 404 images
            // with a placeholder rather than showing the broken icon.
            onError={(e) => {
              const img = e.currentTarget;
              if (img.src !== FALLBACK_THUMBNAIL) {
                img.src = FALLBACK_THUMBNAIL;
              }
            }}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium truncate">{listing.sellerName}</span>
              {listing.sellerIsVerified && (
                <BadgeCheck className="h-3.5 w-3.5 text-primary flex-shrink-0" />
              )}
            </div>
            {/* Product name — primary identifier. Was missing in v6.2 P3
                (only seller was shown); adds clarity without crowding. */}
            <p className="text-xs text-muted-foreground truncate">{listing.productName}</p>
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

        {/* ─── Location + rating ──────────────────────────────────────────── */}
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

        {/* ─── Variant info ──────────────────────────────────────────────── */}
        {topVariant && (
          <div className="text-xs text-muted-foreground mb-2">
            {topVariant.form && <span className="font-medium">{topVariant.form}</span>}
            {topVariant.height && <span> · {topVariant.height}</span>}
            {topVariant.isPreOrder && <span className="text-warning"> · pre-order</span>}
            {/* v6.2 Part 5 (Bug 4 fix): if multiple variants exist, show
                a "+N more" hint so the buyer knows the Cart button opens
                a picker (not a direct add). */}
            {showPicker && listing.variants.length > 1 && (
              <span className="text-primary/70"> · +{listing.variants.length - 1} more</span>
            )}
          </div>
        )}

        {/* ─── Price + buttons ──────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="text-base font-bold">{formatPrice(effectivePrice)}</span>
            {/* v6.2 Part 4 fix: only show the strikethrough when there's an
                actual discount (discountPrice != null AND < price). The old
                check `!== null && !== undefined` showed a strikethrough even
                when discountPrice was 0 (a "free" item) or equal to price. */}
            {topVariant?.discountPrice != null &&
              topVariant.discountPrice > 0 &&
              topVariant.discountPrice < topVariant.price && (
                <span className="text-[10px] text-muted-foreground line-through ml-1">
                  {formatPrice(topVariant.price)}
                </span>
              )}
          </div>
          <div className="flex gap-1.5 flex-shrink-0">
            {canAddToCart && (
              <Button
                variant="default"
                size="sm"
                className="h-7 text-xs"
                // Disable during pending + briefly during the ✓ flash.
                // Prevents double-clicks from creating duplicate cart lines
                // (industry-standard: Amazon, Shopify, Daraz all do this).
                disabled={isPending || addStatus === "added"}
                onClick={handleAddToCart}
                // Announce the state change to screen readers.
                aria-label={
                  showPicker
                    ? `Choose a variant for ${listing.productName}`
                    : `Add ${listing.productName} to cart`
                }
                aria-busy={isPending}
              >
                {buttonContent}
                {buttonLabel}
              </Button>
            )}
            <Button
              variant="outline"
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
      </div>

      {/* v6.2 Part 5 (Bug 4 fix): variant picker for multi-variant listings.
          Rendered as a sibling (not inside the card) so the Dialog's portal
          isn't affected by the card's overflow/transform. */}
      {showPicker && (
        <ChatVariantPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          productName={listing.productName}
          sellerName={listing.sellerName}
          variants={listing.variants as ChatListingVariant[]}
          onConfirm={handlePickerConfirm}
        />
      )}
    </>
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
      {/* ─── Care summary (if present — MIXED intent) ─────────────────── */}
      {result.careSummary?.content && (
        <div className="border-l-2 border-success/40 pl-3 py-1 text-xs text-muted-foreground">
          <span className="text-success font-medium">💡 Care tip: </span>
          {result.careSummary.content}
        </div>
      )}

      {/* ─── Listing grid ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {result.listings.slice(0, 5).map((listing) => (
          <ListingCard key={listing.listingId} listing={listing} onClose={onClose} />
        ))}
      </div>

      {/* ─── Summary bar ──────────────────────────────────────────────── */}
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
