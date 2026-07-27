import { useState } from "react";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { Link, useLocation } from "wouter";
import {
  useGetWishlist, useRemoveFromWishlist, useAddToCart, getGetWishlistQueryKey, getGetCartQueryKey,
  useRemoveSellerListingVariantFromWishlist,
  listProductSellerListings, ListProductSellerListingsSort,
  useListCategories, getListCategoriesQueryKey,
  type SellerListingCard, type SellerListingVariant,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Heart, ShoppingBag, Trash2, Loader2, ChevronRight, Store } from "lucide-react";
import { useGuestWishlist } from "@/hooks/useGuestWishlist";
import { useToast } from "@/hooks/use-toast";
import { SellerListingPickerDialog } from "@/components/ui/SellerListingPickerDialog";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";

// Same category badge icon used on HomepageProductCard.tsx, for visual
// consistency between the homepage cards and this page.
const CATEGORY_ICON =
  "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1784963644/cropped-8e9b0a45-dd2d-4fad-9149-ee5858cbc4ca_zskxxe_au7ckt.svg";

// Normalized "product variety" wishlist line -- a plain product the person
// saved with no seller chosen yet. wishlist.ts's price/inStock fields (see
// PHASE2_HANDOFF.md §5) are a single "best available number" computed
// server-side -- no listing/variant ids are exposed there. These cards
// intentionally have no Add to Bag action (see the two-section split
// below): picking a seller is what SellerListingPickerDialog exists for,
// and that flow now lives entirely under the Seller Listings section.
type WishlistLine = {
  id: number;
  productId: number;
  name: string;
  slug: string;
  image: string;
  price: number;
  discountPrice: number | null;
  scientificName: string | null;
  categoryId: number | null;
};

// Normalized "seller listing" wishlist line -- the person hearted one
// specific seller's variant (e.g. from SellerListingDetailPage), not the
// product in general. Distinct from WishlistLine above: several of these
// can share the same productId (different sellers/variants of one
// product), and each has its own Add to Bag action since the seller/
// variant is already resolved -- no picker needed.
type SellerListingWishlistLine = {
  id: number;
  productId: number;
  sellerListingVariantId: number;
  productName: string;
  image: string;
  sellerName: string;
  price: number;
  discountPrice: number | null;
  variantLabel: string;
  availableQuantity: number | null; // null for guests -- see note below
};

export function WishlistPage() {
  const qc = useQueryClient();
  const { user, isLoaded } = useUser();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const isGuest = isLoaded && !user;
  const guestWishlist = useGuestWishlist();

  // Shows a seller-picker whenever a product has more than one qualifying
  // seller listing (a real choice -- price/delivery/location all differ),
  // rather than silently auto-picking the cheapest seller. Only reduces
  // straight to the (single-seller) variant picker, or straight to the
  // cart, when there's truly nothing left to choose. See handleAddToCart.
  const [pickerState, setPickerState] = useState<{
    item: WishlistLine;
    cards: SellerListingCard[];
  } | null>(null);
  const [loadingItemId, setLoadingItemId] = useState<number | null>(null);
  const [loadingListingLineId, setLoadingListingLineId] = useState<number | null>(null);

  const { data: wishlistData, isLoading: wishlistLoading } = useGetWishlist({
    query: { enabled: !isGuest, queryKey: getGetWishlistQueryKey() },
  });
  const removeFromWishlist = useRemoveFromWishlist();
  const removeSellerListingVariant = useRemoveSellerListingVariantFromWishlist();
  const addToCart = useAddToCart();

  // Cards show a category badge (e.g. "Fruit Trees"); items only carry
  // categoryId, so look the name up here once, same approach as
  // HomePage.tsx's HomepageProductCard usage.
  const { data: wishlistCategories = [] } = useListCategories({
    query: { staleTime: 60_000, queryKey: getListCategoriesQueryKey() },
  });
  const categoryNameById = new Map<number, string>(
    wishlistCategories.map((c: { id: number; name: string }) => [c.id, c.name])
  );

  const isLoading = !isLoaded || (!isGuest && wishlistLoading);

  const items: WishlistLine[] = isGuest
    ? guestWishlist.items.map((g) => ({
        id: g.productId,
        productId: g.productId,
        name: g.name,
        slug: g.slug,
        image: g.image,
        price: g.price,
        discountPrice: g.discountPrice,
        scientificName: g.scientificName ?? null,
        categoryId: g.categoryId ?? null,
      }))
    : (wishlistData?.products ?? []).map((w: { id: number; productId: number; product: { name: string; slug: string; images?: string[] | null; startingPrice?: number | null; scientificName?: string | null; categoryId?: number | null } }) => ({
        id: w.id,
        productId: w.productId,
        name: w.product.name,
        slug: w.product.slug,
        image: w.product.images?.[0] ?? "",
        // startingPrice here is wishlist.ts's own custom field (falls back
        // to the cheapest qualifying marketplace price when no legacy admin
        // price exists) -- NOT the generated Product type's startingPrice,
        // which is permanently null post-Phase-2. Confirmed by reading
        // wishlist.ts directly; see PHASE2_HANDOFF.md §5 and this phase's
        // handoff doc for the full trace. No fix needed here, this was
        // already reading the correctly-computed value.
        price: w.product.startingPrice ?? 0,
        discountPrice: null,
        scientificName: w.product.scientificName ?? null,
        categoryId: w.product.categoryId ?? null,
      }));

  // availableQuantity is only known server-side (from the joined variant
  // row); guests only ever stored what SellerListingDetailPage's toggle
  // captured at heart-click time, which doesn't include live stock. Guest
  // cards fall back to always showing Add to Bag and letting the mutation
  // itself surface an out-of-stock error, same as this page already did
  // for guest product cards before this change.
  const sellerListingItems: SellerListingWishlistLine[] = isGuest
    ? guestWishlist.sellerListingItems.map((g) => ({
        id: g.sellerListingVariantId,
        productId: g.productId,
        sellerListingVariantId: g.sellerListingVariantId,
        productName: g.productName,
        image: g.image,
        sellerName: g.sellerName,
        price: g.price,
        discountPrice: g.discountPrice,
        variantLabel: g.variantLabel,
        availableQuantity: null,
      }))
    : (wishlistData?.sellerListings ?? []).map((w) => ({
        id: w.id,
        productId: w.productId,
        sellerListingVariantId: w.sellerListingVariantId,
        productName: w.product.name,
        image: w.listing.images?.[0] ?? w.product.images?.[0] ?? "",
        sellerName: w.seller.nurseryName,
        price: w.variant.discountPrice ?? w.variant.price,
        discountPrice: null,
        variantLabel: w.variant.form || w.variant.rootType || `Option #${w.variant.id}`,
        availableQuantity: w.variant.availableQuantity,
      }));

  const totalCount = items.length + sellerListingItems.length;

  function handleRemove(productId: number) {
    if (isGuest) {
      guestWishlist.removeItem(productId);
      return;
    }
    removeFromWishlist.mutate({ productId }, {
      onSuccess: () => qc.invalidateQueries({ queryKey: getGetWishlistQueryKey() }),
    });
  }

  function handleRemoveSellerListing(sellerListingVariantId: number) {
    if (isGuest) {
      guestWishlist.removeSellerListingItem(sellerListingVariantId);
      return;
    }
    removeSellerListingVariant.mutate({ variantId: sellerListingVariantId }, {
      onSuccess: () => qc.invalidateQueries({ queryKey: getGetWishlistQueryKey() }),
    });
  }

  function addVariantToCart(productId: number, variant: SellerListingVariant) {
    addToCart.mutate(
      { data: { productId, sellerListingVariantId: variant.id, quantity: 1 } },
      {
        onSuccess: () => qc.invalidateQueries({ queryKey: getGetCartQueryKey() }),
        onError: (err: any) => {
          toast({ title: "Couldn't add to bag", description: err?.message ?? "Please try again.", variant: "destructive" });
        },
      },
    );
  }

  // Industry-standard marketplace pattern (Amazon/Daraz "choose a seller"):
  // when a product has more than one seller with in-stock listings, that's
  // a real choice for the buyer (price, delivery time, location all
  // differ), not an implementation detail to auto-resolve. So this only
  // skips straight to the cart when there is truly nothing left to pick --
  // one qualifying seller AND that seller has exactly one qualifying
  // variant. Otherwise it opens SellerListingPickerDialog, which itself
  // skips its own seller-choice step if only one seller qualifies.
  //
  // Only used by the Product Varieties section below -- Seller Listings
  // cards already have a specific variant resolved and add straight to
  // cart via handleAddSellerListingToCart instead.
  async function handleAddToCart(item: WishlistLine) {
    if (!user) {
      toast({ title: "Sign in required", description: "Please sign in to buy from marketplace sellers.", variant: "destructive" });
      setLocation("/sign-in");
      return;
    }
    setLoadingItemId(item.productId);
    try {
      const cards: SellerListingCard[] = await listProductSellerListings(item.productId, {
        sort: ListProductSellerListingsSort.price_asc,
      });
      const qualifyingCards = cards.filter((c) => c.listing.variants.some((v) => v.availableQuantity > 0));
      if (qualifyingCards.length === 0) {
        toast({ title: "No longer available", description: `${item.name} currently has no in-stock seller listings.`, variant: "destructive" });
        return;
      }
      if (qualifyingCards.length === 1) {
        const onlyQualifying = qualifyingCards[0].listing.variants.filter((v) => v.availableQuantity > 0);
        if (onlyQualifying.length === 1) {
          addVariantToCart(item.productId, onlyQualifying[0]);
          return;
        }
      }
      setPickerState({ item, cards: qualifyingCards });
    } catch {
      toast({ title: "Couldn't add to bag", description: "Please try again.", variant: "destructive" });
    } finally {
      setLoadingItemId(null);
    }
  }

  function handleAddSellerListingToCart(line: SellerListingWishlistLine) {
    if (!user) {
      toast({ title: "Sign in required", description: "Please sign in to buy from marketplace sellers.", variant: "destructive" });
      setLocation("/sign-in");
      return;
    }
    setLoadingListingLineId(line.sellerListingVariantId);
    addToCart.mutate(
      { data: { productId: line.productId, sellerListingVariantId: line.sellerListingVariantId, quantity: 1 } },
      {
        onSuccess: () => qc.invalidateQueries({ queryKey: getGetCartQueryKey() }),
        onError: (err: any) => {
          toast({ title: "Couldn't add to bag", description: err?.message ?? "Please try again.", variant: "destructive" });
        },
        onSettled: () => setLoadingListingLineId(null),
      },
    );
  }

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-10">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (totalCount === 0) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
        <div className="h-20 w-20 rounded-full bg-muted flex items-center justify-center mb-6">
          <Heart className="h-9 w-9 text-muted-foreground" />
        </div>
        <h2 className="font-serif text-2xl font-medium mb-2">Your wishlist is empty</h2>
        <p className="text-muted-foreground text-sm mb-6">Save products you love and come back to them anytime.</p>
        <Link href="/products"><Button className="rounded-full px-8">Explore Products</Button></Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="bg-muted/30 border-b py-10">
        <div className="container mx-auto px-4">
          <PageBreadcrumb crumbs={[{ label: "Wishlist", icon: <Heart className="h-3 w-3" /> }]} className="mb-3" />
          <h1 className="font-serif text-4xl font-medium">Wishlist</h1>
          <p className="text-muted-foreground mt-1 text-sm">{totalCount} saved item{totalCount !== 1 ? "s" : ""}</p>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8 space-y-10">
        {items.length > 0 && (
          <section>
            <h2 className="font-serif text-xl font-medium mb-4 flex items-center gap-2">
              <Heart className="h-4 w-4 text-muted-foreground" />
              Product Varieties
              <span className="text-sm font-normal text-muted-foreground">({items.length})</span>
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
              {items.map((item) => {
                const img = item.image || null;
                const categoryName = item.categoryId != null ? categoryNameById.get(item.categoryId) : undefined;
                const isAdding = loadingItemId === item.productId;
                return (
                  <div key={item.id} className="group bg-card border rounded-xl overflow-hidden">
                    <Link href={`/products/${item.productId}`}>
                      <div className="relative aspect-square overflow-hidden bg-muted/20 cursor-pointer">
                        {img ? (
                          <img src={img} alt={item.name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                        ) : (
                          <NoImagePlaceholder />
                        )}
                        <button
                          onClick={(e) => { e.preventDefault(); handleRemove(item.productId); }}
                          className="absolute top-3 right-3 p-2 rounded-full bg-background/80 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity hover:text-destructive text-muted-foreground"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </Link>
                    <div className="p-3">
                      <Link href={`/products/${item.productId}`}>
                        <p className="font-medium text-sm leading-snug cursor-pointer hover:text-accent">{item.name}</p>
                      </Link>
                      {item.scientificName && (
                        <p className="text-xs italic text-muted-foreground mt-0.5">{item.scientificName}</p>
                      )}
                      {categoryName && (
                        <span className="inline-flex items-center gap-1 bg-primary/10 text-primary px-2.5 py-1 rounded-full text-xs font-medium mt-2">
                          <img src={CATEGORY_ICON} alt="" aria-hidden="true" className="h-3.5 w-3.5" />
                          {categoryName}
                        </span>
                      )}
                      <hr className="border-border mt-3 mb-3" />
                      {/* Product-variety cards: View Details only. No
                          seller has been chosen for these yet, so there's
                          nothing to "add to bag" -- that choice now
                          belongs to the Seller Listings section below,
                          or to picking a seller from the product page. */}
                      <Link href={`/products/${item.productId}`}>
                        <Button size="sm" variant="outline" className="w-full text-xs border-primary text-primary hover:bg-primary/5 hover:text-primary">
                          View Details
                          <ChevronRight className="h-3.5 w-3.5 ml-1" />
                        </Button>
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {sellerListingItems.length > 0 && (
          <section>
            <h2 className="font-serif text-xl font-medium mb-4 flex items-center gap-2">
              <Store className="h-4 w-4 text-muted-foreground" />
              Seller Listings
              <span className="text-sm font-normal text-muted-foreground">({sellerListingItems.length})</span>
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
              {sellerListingItems.map((line) => {
                const img = line.image || null;
                const isAdding = loadingListingLineId === line.sellerListingVariantId;
                const outOfStock = line.availableQuantity != null && line.availableQuantity <= 0;
                const detailHref = `/products/${line.productId}/listings/${line.id}`;
                return (
                  <div key={line.id} className="group bg-card border rounded-xl overflow-hidden">
                    <Link href={detailHref}>
                      <div className="relative aspect-square overflow-hidden bg-muted/20 cursor-pointer">
                        {img ? (
                          <img src={img} alt={line.productName} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                        ) : (
                          <NoImagePlaceholder />
                        )}
                        <button
                          onClick={(e) => { e.preventDefault(); handleRemoveSellerListing(line.sellerListingVariantId); }}
                          className="absolute top-3 right-3 p-2 rounded-full bg-background/80 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity hover:text-destructive text-muted-foreground"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </Link>
                    <div className="p-3">
                      <Link href={detailHref}>
                        <p className="font-medium text-sm leading-snug cursor-pointer hover:text-accent">{line.productName}</p>
                      </Link>
                      <p className="text-xs text-muted-foreground mt-0.5">{line.variantLabel}</p>
                      <span className="inline-flex items-center gap-1 bg-primary/10 text-primary px-2.5 py-1 rounded-full text-xs font-medium mt-2">
                        <Store className="h-3 w-3" />
                        {line.sellerName}
                      </span>
                      <hr className="border-border mt-3 mb-3" />
                      <div className="flex flex-col gap-2">
                        <Link href={detailHref}>
                          <Button size="sm" variant="outline" className="w-full text-xs border-primary text-primary hover:bg-primary/5 hover:text-primary">
                            View Details
                            <ChevronRight className="h-3.5 w-3.5 ml-1" />
                          </Button>
                        </Link>
                        <Button
                          size="sm"
                          className="w-full text-xs"
                          disabled={isAdding || outOfStock}
                          onClick={() => handleAddSellerListingToCart(line)}
                        >
                          {isAdding ? (
                            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          ) : (
                            <ShoppingBag className="h-3.5 w-3.5 mr-1.5" />
                          )}
                          {outOfStock ? "Out of stock" : "Add to Bag"}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {pickerState && (
        <SellerListingPickerDialog
          open={!!pickerState}
          onOpenChange={(o) => { if (!o) setPickerState(null); }}
          productName={pickerState.item.name}
          cards={pickerState.cards}
          onConfirm={(_card, variant) => addVariantToCart(pickerState.item.productId, variant)}
        />
      )}
    </div>
  );
}
