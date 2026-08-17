import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Star, Truck, MapPin, ArrowUpDown, ShoppingBag, LogIn, Eye, BadgeCheck, ImageOff, Package } from "lucide-react";
import {
  useListProductSellerListings, ListProductSellerListingsSort,
  useAddToCart, getGetCartQueryKey,
  type SellerListingVariant,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { SellerListingVariantPickerDialog } from "@/components/ui/SellerListingVariantPickerDialog";

const SORT_OPTIONS = [
  { value: ListProductSellerListingsSort.price_asc, label: "Price: Low to High" },
  { value: ListProductSellerListingsSort.price_desc, label: "Price: High to Low" },
  { value: ListProductSellerListingsSort.delivery_time, label: "Fastest Delivery" },
  { value: ListProductSellerListingsSort.rating, label: "Highest Rated" },
];

/**
 * Buyer-facing "seller cards" for a variety detail page (plan doc §6):
 * "When multiple sellers list the same variety... show a list/grid of
 * seller cards below the main product info." Each card is one seller's
 * listing against this variety -- price, delivery time, rating, and a
 * per-card summary -- NOT the single-seller buy box above (Phase 3b Part 1
 * removed that admin-variant buy box entirely; this section is now the
 * real purchase surface for this page, per the original design: variety
 * page = discovery/care info, seller cards = where you actually buy).
 *
 * Only renders once the API returns at least one card; if a variety
 * currently has zero seller_listings, this section renders nothing rather
 * than an empty-state block, so the page doesn't show a confusing "no
 * sellers" message for every product that simply hasn't been listed by a
 * marketplace seller yet.
 *
 * Add to Bag here requires sign-in. Guest checkout (routes/orders.ts POST
 * /orders/guest) is admin-direct-only by design -- a guest has no account
 * to attach a seller-scoped order to, so letting a guest add a
 * seller-listing item to their bag would only fail later at checkout.
 * Gating it here means the failure is immediate and the reason is clear.
 *
 * Phase 3b Part 2: add-to-cart now addresses a specific VARIANT
 * (sellerListingVariantId), not just the listing -- cart.ts's real
 * validation requires exactly one of variantId/sellerListingVariantId, and
 * sellerListingId alone (the old call) is silently ignored server-side
 * (PHASE3A_HANDOFF.md §6). If a card has exactly one qualifying
 * (in-stock) variant, Add to Bag proceeds directly with it -- no picker,
 * no added friction where there's no ambiguity. If a card has multiple
 * qualifying variants, Add to Bag opens SellerListingVariantPickerDialog
 * so the buyer picks which one before it's added.
 */
export function SellerListingsSection({ productId }: { productId: number }) {
  const [sort, setSort] = useState<ListProductSellerListingsSort>(ListProductSellerListingsSort.price_asc);
  const { data: cards, isLoading } = useListProductSellerListings(productId, { sort });
  const { user } = useUser();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const addToCart = useAddToCart();
  const [addingId, setAddingId] = useState<number | null>(null);
  const [pickerListingId, setPickerListingId] = useState<number | null>(null);

  function addVariantToBag(variant: SellerListingVariant, listingId: number, nurseryName: string) {
    setAddingId(listingId);
    addToCart.mutate(
      { data: { productId, sellerListingVariantId: variant.id, quantity: 1 } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetCartQueryKey() });
          toast({ title: "Added to bag", description: `From ${nurseryName}` });
        },
        onError: (err: any) => {
          toast({ title: "Couldn't add to bag", description: err?.message ?? "Please try again.", variant: "destructive" });
        },
        onSettled: () => setAddingId(null),
      }
    );
  }

  function handleAddToBag(listingId: number, nurseryName: string, qualifyingVariants: SellerListingVariant[]) {
    if (!user) {
      toast({ title: "Sign in required", description: "Please sign in to buy from marketplace sellers.", variant: "destructive" });
      setLocation("/sign-in");
      return;
    }
    if (qualifyingVariants.length === 1) {
      addVariantToBag(qualifyingVariants[0], listingId, nurseryName);
      return;
    }
    // Multiple qualifying variants -- ask which one before adding.
    setPickerListingId(listingId);
  }

  if (isLoading) {
    return (
      <section className="border-t pt-12 mb-12">
        <div className="h-7 w-64 bg-muted rounded-lg animate-pulse mb-6" />
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <div key={i} className="h-48 rounded-2xl bg-muted animate-pulse" />)}
        </div>
      </section>
    );
  }

  if (!cards || cards.length === 0) return null;

  const pickerCard = cards.find((c) => c.listing.id === pickerListingId);
  const pickerQualifying = pickerCard ? pickerCard.listing.variants.filter((v) => v.availableQuantity > 0) : [];

  return (
    <section className="border-t pt-12 mb-12">
      <div className="flex items-end justify-between mb-6 flex-wrap gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.15em] text-accent-text mb-2 font-medium">Compare Nurseries</p>
          <h2 className="font-serif text-3xl font-medium">Available From {cards.length} Seller{cards.length !== 1 ? "s" : ""}</h2>
        </div>
        <div className="relative">
          <ArrowUpDown className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as ListProductSellerListingsSort)}
            className="pl-9 pr-8 h-9 rounded-full border border-input bg-background text-sm appearance-none cursor-pointer"
          >
            {SORT_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
          </select>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((card) => {
          // price/stock live on a nested `variants` array. This buyer-facing
          // card can only show one headline price, so -- mirroring the same
          // "cheapest qualifying (in-stock) variant wins" rule the backend
          // itself already uses for sort=price_asc (see
          // PHASE2_HANDOFF.md §7) -- pick the cheapest variant with
          // availableQuantity > 0, falling back to the cheapest variant
          // overall if every variant happens to be sold out (so the card
          // still shows a price rather than crashing on an empty array).
          const qualifying = card.listing.variants.filter((v) => v.availableQuantity > 0);
          const pricedVariant = [...(qualifying.length > 0 ? qualifying : card.listing.variants)].sort(
            (a, b) => (a.discountPrice ?? a.price) - (b.discountPrice ?? b.price),
          )[0];
          const outOfStock = qualifying.length === 0;
          const totalStock = card.listing.variants.reduce((sum, v) => sum + v.stock, 0);
          const isAdding = addingId === card.listing.id && addToCart.isPending;
          const img = card.listing.images?.[0] || null;
          const discountPct = pricedVariant?.discountPrice != null
            ? Math.round((1 - pricedVariant.discountPrice / pricedVariant.price) * 100)
            : null;
          return (
            <div key={card.listing.id} className="border rounded-2xl p-4 bg-card flex flex-col gap-4">
              <div className="flex gap-3">
                <div className="h-24 w-20 sm:h-28 sm:w-24 rounded-xl overflow-hidden bg-muted/30 shrink-0 flex items-center justify-center">
                  {img ? (
                    <img src={img} alt={card.seller.nurseryName} className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="flex flex-col items-center gap-1 text-muted-foreground/60">
                      <ImageOff className="h-5 w-5" />
                      <span className="text-[10px]">No image</span>
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm truncate flex items-center gap-1.5">
                    {card.seller.nurseryName}
                    {card.seller.isVerified && (
                      <BadgeCheck className="h-4 w-4 text-success-foreground shrink-0" aria-label="Verified seller" />
                    )}
                  </p>

                  {card.reviewCount > 0 && (
                    <div className="flex items-center gap-1 text-xs mt-1">
                      <Star className="h-3.5 w-3.5 fill-warning-foreground text-warning-foreground" />
                      <span className="font-semibold">{card.rating.toFixed(1)}</span>
                      <span className="text-muted-foreground">({card.reviewCount})</span>
                    </div>
                  )}

                  <div className="flex flex-col gap-0.5 text-xs text-muted-foreground mt-1.5">
                    {card.listing.deliveryTimeDays != null && (
                      <span className="flex items-center gap-1"><Truck className="h-3 w-3 shrink-0" /> {card.listing.deliveryTimeDays}-day delivery</span>
                    )}
                    <span className="flex items-center gap-1"><MapPin className="h-3 w-3 shrink-0" /> {card.seller.location}</span>
                  </div>
                </div>
              </div>

              <div>
                <div className="flex items-baseline gap-2 flex-wrap">
                  {pricedVariant && (
                    <>
                      <span className="font-serif text-xl font-bold text-primary">Tk{pricedVariant.discountPrice ?? pricedVariant.price}</span>
                      {pricedVariant.discountPrice != null && pricedVariant.discountPrice > 0 && pricedVariant.discountPrice < pricedVariant.price && (
                        <>
                          <span className="text-sm text-muted-foreground line-through">Tk{pricedVariant.price}</span>
                          {discountPct != null && discountPct > 0 && (
                            <span className="text-xs font-semibold text-destructive bg-destructive/10 rounded-md px-1.5 py-0.5">{discountPct}% OFF</span>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1.5">
                  <Package className="h-3.5 w-3.5" />
                  {totalStock > 0 ? `In Stock (${totalStock})` : "Out of stock"}
                </p>
              </div>

              {card.listing.offerText && (
                <p className="text-xs text-accent font-medium -mt-2">{card.listing.offerText}</p>
              )}

              <div className="flex gap-2 mt-auto">
                <Link href={`/products/${productId}/listings/${card.listing.id}`} className="flex-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full rounded-lg border-primary text-primary hover:bg-primary/5 hover:text-primary gap-1.5"
                  >
                    <Eye className="h-3.5 w-3.5" /> View Details
                  </Button>
                </Link>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 rounded-lg border-primary text-primary hover:bg-primary/5 hover:text-primary gap-1.5"
                  disabled={outOfStock || isAdding}
                  onClick={() => handleAddToBag(card.listing.id, card.seller.nurseryName, qualifying)}
                >
                  {!user ? (
                    <><LogIn className="h-3.5 w-3.5" /> Sign in</>
                  ) : outOfStock ? (
                    "Out of stock"
                  ) : (
                    <><ShoppingBag className="h-3.5 w-3.5" /> {isAdding ? "Adding…" : "Add to Bag"}</>
                  )}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {pickerCard && (
        <SellerListingVariantPickerDialog
          open={pickerListingId != null}
          onOpenChange={(o) => { if (!o) setPickerListingId(null); }}
          sellerName={pickerCard.seller.nurseryName}
          variants={pickerQualifying}
          onConfirm={(variant) => addVariantToBag(variant, pickerCard.listing.id, pickerCard.seller.nurseryName)}
        />
      )}
    </section>
  );
}
