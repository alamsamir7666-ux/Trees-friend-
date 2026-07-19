import { useState } from "react";
import { useLocation } from "wouter";
import { Star, Truck, MapPin, ShieldCheck, ArrowUpDown, Sprout, ShoppingBag, LogIn } from "lucide-react";
import {
  useListProductSellerListings, ListProductSellerListingsSort,
  useAddToCart, getGetCartQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

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
 * per-card summary -- NOT the single-seller buy box above, which is
 * unrelated and untouched by this section.
 *
 * Only renders once the API returns at least one card; if a variety
 * currently has zero seller_listings (the common case right after this
 * phase 2 migration, before sellers have populated inventory), this
 * section renders nothing rather than an empty-state block, so the page
 * doesn't show a confusing "no sellers" message for every product that
 * simply hasn't been listed by a marketplace seller yet -- the existing
 * single-seller buy box above already covers that product.
 *
 * Add to Bag here requires sign-in, unlike the buy box above. Guest
 * checkout (routes/orders.ts POST /orders/guest) is admin-direct-only by
 * design -- a guest has no account to attach a seller-scoped order to, so
 * letting a guest add a seller-listing item to their bag would only fail
 * later at checkout. Gating it here means the failure is immediate and
 * the reason is clear, instead of a guest filling out an entire shipping
 * form before discovering their bag item is unbuyable as a guest.
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

  function handleAddToBag(listingId: number, nurseryName: string) {
    if (!user) {
      toast({ title: "Sign in required", description: "Please sign in to buy from marketplace sellers.", variant: "destructive" });
      setLocation("/sign-in");
      return;
    }
    setAddingId(listingId);
    addToCart.mutate(
      { data: { productId, sellerListingId: listingId, quantity: 1 } },
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
          const outOfStock = card.listing.stock <= 0;
          const isAdding = addingId === card.listing.id && addToCart.isPending;
          return (
            <div key={card.listing.id} className="border rounded-2xl p-4 bg-card flex flex-col">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate flex items-center gap-1.5">
                    <Sprout className="h-3.5 w-3.5 text-accent shrink-0" />
                    {card.seller.nurseryName}
                  </p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                    <MapPin className="h-3 w-3" /> {card.seller.location}
                  </p>
                </div>
                {card.reviewCount > 0 && (
                  <div className="flex items-center gap-1 text-xs font-medium shrink-0 bg-amber-50 text-amber-700 px-2 py-1 rounded-full">
                    <Star className="h-3 w-3 fill-amber-500 text-amber-500" /> {card.rating.toFixed(1)}
                    <span className="text-amber-600/70">({card.reviewCount})</span>
                  </div>
                )}
              </div>

              <div className="flex items-baseline gap-2 mb-2">
                <span className="font-serif text-xl font-medium">Tk{card.listing.discountPrice ?? card.listing.price}</span>
                {card.listing.discountPrice && (
                  <span className="text-sm text-muted-foreground line-through">Tk{card.listing.price}</span>
                )}
              </div>

              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground mb-3">
                {card.listing.deliveryTimeDays != null && (
                  <span className="flex items-center gap-1"><Truck className="h-3 w-3" /> {card.listing.deliveryTimeDays}-day delivery</span>
                )}
                {card.listing.warrantyDays != null && (
                  <span className="flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> {card.listing.warrantyDays}-day warranty</span>
                )}
                <span>{card.listing.stock > 0 ? `${card.listing.stock} in stock` : "Out of stock"}</span>
              </div>

              {card.listing.offerText && (
                <p className="text-xs text-accent font-medium mb-3">{card.listing.offerText}</p>
              )}

              <div className="mt-auto pt-1">
                <Button
                  className="w-full rounded-full"
                  size="sm"
                  disabled={outOfStock || isAdding}
                  onClick={() => handleAddToBag(card.listing.id, card.seller.nurseryName)}
                >
                  {!user ? (
                    <><LogIn className="mr-1.5 h-3.5 w-3.5" /> Sign in to buy</>
                  ) : outOfStock ? (
                    "Out of stock"
                  ) : (
                    <><ShoppingBag className="mr-1.5 h-3.5 w-3.5" /> {isAdding ? "Adding…" : "Add to Bag"}</>
                  )}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
