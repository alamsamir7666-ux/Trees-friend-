import { useState } from "react";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { Link, useLocation } from "wouter";
import {
  useGetWishlist, useRemoveFromWishlist, useAddToCart, getGetWishlistQueryKey, getGetCartQueryKey,
  listProductSellerListings, ListProductSellerListingsSort,
  useListCategories, getListCategoriesQueryKey,
  type SellerListingCard, type SellerListingVariant,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Heart, ShoppingBag, Trash2, Loader2, ChevronRight } from "lucide-react";
import { useGuestWishlist } from "@/hooks/useGuestWishlist";
import { useToast } from "@/hooks/use-toast";
import { SellerListingVariantPickerDialog } from "@/components/ui/SellerListingVariantPickerDialog";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";

// Same category badge icon used on HomepageProductCard.tsx, for visual
// consistency between the homepage cards and this page.
const CATEGORY_ICON =
  "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1784963644/cropped-8e9b0a45-dd2d-4fad-9149-ee5858cbc4ca_zskxxe_au7ckt.svg";

// Normalized wishlist line. wishlist.ts's price/inStock fields (see
// PHASE2_HANDOFF.md §5) are a single "best available number" computed
// server-side -- no listing/variant ids are exposed there, since that
// endpoint never needed them before Add to Bag existed on this page. Real
// listing/variant data for a given product is fetched on demand (see
// handleAddToCart) rather than eagerly per card, both because wishlist.ts
// doesn't return it and to avoid an extra request per card on page load.
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

export function WishlistPage() {
  const qc = useQueryClient();
  const { user, isLoaded } = useUser();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const isGuest = isLoaded && !user;
  const guestWishlist = useGuestWishlist();

  // Phase 4: the picker is scoped to ONE listing (mirrors
  // SellerListingsSection.tsx's single-listing picker), chosen as the
  // cheapest qualifying listing for the product just clicked -- see
  // handleAddToCart for why "cheapest listing, then variant within it" is
  // the right two-step reduction for a wishlist card, which (unlike
  // SellerListingsSection.tsx) has no per-seller card UI of its own to
  // let the buyer pick a seller first.
  const [pickerState, setPickerState] = useState<{
    item: WishlistLine;
    sellerName: string;
    variants: SellerListingVariant[];
  } | null>(null);
  const [loadingItemId, setLoadingItemId] = useState<number | null>(null);

  const { data: wishlistData, isLoading: wishlistLoading } = useGetWishlist({
    query: { enabled: !isGuest, queryKey: getGetWishlistQueryKey() },
  });
  const removeFromWishlist = useRemoveFromWishlist();
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
    : (wishlistData ?? []).map((w: { id: number; productId: number; product: { name: string; slug: string; images?: string[] | null; startingPrice?: number | null; scientificName?: string | null; categoryId?: number | null } }) => ({
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

  function handleRemove(productId: number) {
    if (isGuest) {
      guestWishlist.removeItem(productId);
      return;
    }
    removeFromWishlist.mutate({ productId }, {
      onSuccess: () => qc.invalidateQueries({ queryKey: getGetWishlistQueryKey() }),
    });
  }

  function addVariantToCart(item: WishlistLine, variant: SellerListingVariant) {
    addToCart.mutate(
      { data: { productId: item.productId, sellerListingVariantId: variant.id, quantity: 1 } },
      {
        onSuccess: () => qc.invalidateQueries({ queryKey: getGetCartQueryKey() }),
        onError: (err: any) => {
          toast({ title: "Couldn't add to bag", description: err?.message ?? "Please try again.", variant: "destructive" });
        },
      },
    );
  }

  // Phase 4: this used to read item.product.variants (the frozen admin
  // ProductVariant[], permanently empty since Phase 2) and either silently
  // no-op or open the old admin VariantPickerDialog -- both broken, and
  // the picker was the wrong one besides (VariantPickerDialog/
  // VariantSelector are shaped around admin ProductVariant, not
  // SellerListingVariant, same reason Phase 3b built a fresh
  // SellerListingVariantPickerDialog rather than reusing them -- see
  // PHASE3B_HANDOFF.md Part 2). Rewired rather than removed: unlike
  // ComparisonDrawer (this phase, see ProductComparison.tsx), buying
  // directly from a saved item is core to what a wishlist page is for, and
  // the data needed to do it for real (GET /products/:id/seller-listings)
  // already exists and needs no backend change -- removing the button here
  // would be a real feature regression, not just a display cleanup.
  //
  // "Cheapest listing, then variant within it" -- sort=price_asc and take
  // the first card -- mirrors the same "cheapest qualifying option wins"
  // rule used sitewide (PHASE2_HANDOFF.md §7, ProductCard.tsx's price,
  // SellerListingsSection.tsx's per-card price). A wishlist card has no
  // per-seller UI of its own to let the buyer choose a seller first the
  // way SellerListingsSection.tsx's cards do, so defaulting to the
  // cheapest seller and asking only if THAT seller has more than one
  // qualifying variant is the closest one-click equivalent.
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
      if (cards.length === 0) {
        toast({ title: "No longer available", description: `${item.name} currently has no seller listings.`, variant: "destructive" });
        return;
      }
      const cheapest = cards[0];
      const qualifying = cheapest.listing.variants.filter((v) => v.availableQuantity > 0);
      if (qualifying.length === 0) {
        toast({ title: "Out of stock", description: `${item.name} is currently out of stock from all sellers.`, variant: "destructive" });
        return;
      }
      if (qualifying.length === 1) {
        addVariantToCart(item, qualifying[0]);
        return;
      }
      setPickerState({ item, sellerName: cheapest.seller.businessName, variants: qualifying });
    } catch {
      toast({ title: "Couldn't add to bag", description: "Please try again.", variant: "destructive" });
    } finally {
      setLoadingItemId(null);
    }
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

  if (!items || items.length === 0) {
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
          <p className="text-muted-foreground mt-1 text-sm">{items.length} saved item{items.length !== 1 ? "s" : ""}</p>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8">
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
                  <div className="flex flex-col gap-2">
                    <Link href={`/products/${item.productId}`}>
                      <Button size="sm" variant="outline" className="w-full text-xs border-primary text-primary hover:bg-primary/5 hover:text-primary">
                        View Details
                        <ChevronRight className="h-3.5 w-3.5 ml-1" />
                      </Button>
                    </Link>
                    {isGuest ? (
                      <Link href={`/products/${item.productId}`}>
                        <Button size="sm" className="w-full text-xs">
                          <ShoppingBag className="h-3.5 w-3.5 mr-1.5" />
                          Add to Bag
                        </Button>
                      </Link>
                    ) : (
                      <Button
                        size="sm"
                        className="w-full text-xs"
                        disabled={isAdding}
                        onClick={() => handleAddToCart(item)}
                      >
                        {isAdding ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                        ) : (
                          <ShoppingBag className="h-3.5 w-3.5 mr-1.5" />
                        )}
                        Add to Bag
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {pickerState && (
        <SellerListingVariantPickerDialog
          open={!!pickerState}
          onOpenChange={(o) => { if (!o) setPickerState(null); }}
          sellerName={pickerState.sellerName}
          variants={pickerState.variants}
          onConfirm={(variant) => addVariantToCart(pickerState.item, variant)}
        />
      )}
    </div>
  );
}
