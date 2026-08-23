import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import {
  Star, Truck, MapPin, ArrowUpDown, ShoppingBag, Eye,
  BadgeCheck, ImageOff, Package, ArrowLeft, Loader2,
} from "lucide-react";
import {
  useGetProduct,
  useListProductSellerListings,
  ListProductSellerListingsSort,
  useAddToCart, getGetCartQueryKey,
  type SellerListingVariant,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { useGuestCart } from "@/hooks/useGuestCart";
import { useGuestSession } from "@/hooks/useGuestSession";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { useToast } from "@/hooks/use-toast";
import { SellerListingVariantPickerDialog } from "@/components/ui/SellerListingVariantPickerDialog";
import { updateSEO } from "@/lib/seo";

const SORT_OPTIONS = [
  { value: ListProductSellerListingsSort.price_asc, label: "Price: Low to High" },
  { value: ListProductSellerListingsSort.price_desc, label: "Price: High to Low" },
  { value: ListProductSellerListingsSort.delivery_time, label: "Fastest Delivery" },
  { value: ListProductSellerListingsSort.rating, label: "Highest Rated" },
];

/**
 * Standalone page that shows ALL seller listings for a single product, in a
 * responsive 2-per-row grid. Reached from the "View Listing" button inside
 * the search autocomplete dropdown, where the previous "From Tk{price}" text
 * was redundant with the product detail page's price anyway.
 *
 * Uses the same GET /products/:productId/seller-listings endpoint as
 * SellerListingsSection on the product detail page (so backend behaviour,
 * sort options, and card shape are identical), but renders in a page-shell
 * with breadcrumb + sort + 2-col grid instead of an inline section.
 */
export function ProductSellerListingsPage() {
  const params = useParams<{ id: string }>();
  const productId = Number(params.id);

  const [sort, setSort] = useState<ListProductSellerListingsSort>(ListProductSellerListingsSort.price_asc);
  const { data: product, isLoading: productLoading } = useGetProduct(productId);
  const { data: cards, isLoading: cardsLoading } = useListProductSellerListings(productId, { sort });

  const { user } = useUser();
  const { isVerified } = useGuestSession();
  const guestCart = useGuestCart();
  const qc = useQueryClient();
  const { toast } = useToast();
  const addToCart = useAddToCart();
  const [addingId, setAddingId] = useState<number | null>(null);
  const [pickerListingId, setPickerListingId] = useState<number | null>(null);

  // Authenticated users AND phone-verified guests use the server cart
  // (useAddToCart → POST /cart/items with their JWT). Unverified guests
  // use the localStorage cart (useGuestCart) — they'll merge to the
  // server cart when they verify their phone at checkout.
  const useServerCart = !!user || isVerified;

  // ── SEO ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    updateSEO({
      title: product ? `Seller Listings — ${product.name}` : "Seller Listings",
      description: product
        ? `Compare all marketplace sellers offering ${product.name}. Choose by price, delivery time, or rating.`
        : "Compare marketplace seller listings.",
    });
  }, [product]);

  function addVariantToBag(variant: SellerListingVariant, listingId: number, nurseryName: string, productName: string, productImage: string) {
    if (useServerCart) {
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
        },
      );
    } else {
      guestCart.addItem({
        productId,
        sellerListingVariantId: variant.id,
        variantId: null,
        quantity: 1,
        name: productName,
        price: Number(variant.price),
        discountPrice: variant.discountPrice != null ? Number(variant.discountPrice) : null,
        image: productImage,
        deliveryCharge: Number(variant.deliveryCharge ?? 0),
        stock: variant.availableQuantity,
        addedAt: Date.now(),
      });
      toast({ title: "Added to bag", description: `From ${nurseryName}` });
    }
  }

  function handleAddToBag(listingId: number, nurseryName: string, qualifyingVariants: SellerListingVariant[], productName: string, productImage: string) {
    if (qualifyingVariants.length === 1) {
      addVariantToBag(qualifyingVariants[0], listingId, nurseryName, productName, productImage);
      return;
    }
    setPickerListingId(listingId);
  }

  const loading = productLoading || cardsLoading;
  const breadcrumb = product
    ? [
        { label: "Home", href: "/" },
        { label: "Products", href: "/products" },
        { label: product.name, href: `/products/${product.id}` },
        { label: "Seller Listings" },
      ]
    : [{ label: "Home", href: "/" }, { label: "Seller Listings" }];

  const pickerCard = cards?.find((c) => c.listing.id === pickerListingId);
  const pickerQualifying = pickerCard
    ? pickerCard.listing.variants.filter((v) => v.availableQuantity > 0)
    : [];

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10">
        {/* Breadcrumb + back link */}
        <div className="flex items-center gap-3 mb-6">
          <Link href={product ? `/products/${product.id}` : "/products"}>
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
          </Link>
        </div>
        <PageBreadcrumb crumbs={breadcrumb} />

        {/* Page header */}
        <header className="mt-4 mb-8">
          {productLoading ? (
            <>
              <Skeleton className="h-9 w-72 mb-2" />
              <Skeleton className="h-4 w-56" />
            </>
          ) : (
            <>
              <p className="text-xs uppercase tracking-[0.15em] text-accent-text mb-2 font-medium">
                Compare Sellers
              </p>
              <h1 className="font-serif text-3xl md:text-4xl font-medium leading-tight">
                {product?.name ?? "Seller Listings"}
              </h1>
              <p className="text-sm text-muted-foreground mt-2">
                {cards && cards.length > 0
                  ? `${cards.length} seller${cards.length !== 1 ? "s" : ""} offering this product — choose by price, delivery time, or rating.`
                  : "All marketplace sellers offering this product in one place."}
              </p>
            </>
          )}
        </header>

        {/* Sort dropdown */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <p className="text-sm text-muted-foreground">
            {loading ? "Loading listings…" : cards && cards.length > 0 ? `Showing ${cards.length} listing${cards.length !== 1 ? "s" : ""}` : "No listings yet"}
          </p>
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

        {/* Loading state */}
        {loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-56 rounded-2xl bg-muted animate-pulse" />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && (!cards || cards.length === 0) && (
          <div className="border rounded-2xl p-12 text-center bg-card">
            <Package className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <h3 className="font-serif text-xl font-medium mb-1">No seller listings yet</h3>
            <p className="text-sm text-muted-foreground mb-5">
              No marketplace sellers are currently offering this product. Please check back later.
            </p>
            <Link href={product ? `/products/${product.id}` : "/products"}>
              <Button variant="outline">Back to product</Button>
            </Link>
          </div>
        )}

        {/* 2-per-row grid of seller listing cards */}
        {!loading && cards && cards.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {cards.map((card) => {
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
                <div key={card.listing.id} className="border rounded-2xl p-4 bg-card flex flex-col gap-4 shadow-sm hover:shadow-md transition-shadow">
                  {/* Top: seller identity */}
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
                          <BadgeCheck className="h-4 w-4 text-emerald-500 shrink-0" aria-label="Verified seller" />
                        )}
                      </p>
                      {card.reviewCount > 0 && (
                        <div className="flex items-center gap-1 text-xs mt-1">
                          <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
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

                  {/* Pricing */}
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
                      {totalStock > 0 ? <><span className="text-emerald-600 font-medium">In Stock</span> ({totalStock})</> : "Out of stock"}
                    </p>
                  </div>

                  {card.listing.offerText && (
                    <p className="text-xs text-accent font-medium -mt-2">{card.listing.offerText}</p>
                  )}

                  {/* Action buttons */}
                  <div className="flex gap-2 mt-auto">
                    <Link href={`/products/${productId}/listings/${card.listing.id}`} className="flex-1">
                      <Button variant="outline" size="sm" className="w-full rounded-lg border-primary text-primary hover:bg-primary/5 hover:text-primary gap-1.5">
                        <Eye className="h-3.5 w-3.5" /> View Details
                      </Button>
                    </Link>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 rounded-lg border-primary text-primary hover:bg-primary/5 hover:text-primary gap-1.5"
                      disabled={outOfStock || isAdding}
                      onClick={() => handleAddToBag(card.listing.id, card.seller.nurseryName, qualifying, product?.name ?? "", img ?? "")}
                    >
                      {outOfStock ? (
                        "Out of stock"
                      ) : isAdding ? (
                        <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding…</>
                      ) : (
                        <><ShoppingBag className="h-3.5 w-3.5" /> Add to Bag</>
                      )}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Variant picker for cards with multiple qualifying variants */}
        {pickerCard && (
          <SellerListingVariantPickerDialog
            open={pickerListingId != null}
            onOpenChange={(o) => { if (!o) setPickerListingId(null); }}
            sellerName={pickerCard.seller.nurseryName}
            variants={pickerQualifying}
            onConfirm={(variant) => addVariantToBag(variant, pickerCard.listing.id, pickerCard.seller.nurseryName, product?.name ?? "", pickerCard.listing.images?.[0] ?? "")}
          />
        )}
      </div>
    </div>
  );
}
