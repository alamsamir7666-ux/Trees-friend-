import { useState } from "react";
import { useParams, Link } from "wouter";
import { useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSellerListing, useAddToCart, getGetCartQueryKey,
  type SellerListingVariant,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Star, MapPin, Truck, ShoppingBag, Heart,
  LogIn, ChevronLeft, ChevronDown, PackageX, Ship, AlertTriangle, RefreshCw,
  Sprout, Ruler, FlaskConical, Sprout as PotIcon, Award, Tag, Eye, Minus, Plus, Store as StoreIcon,
} from "lucide-react";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { useToast } from "@/hooks/use-toast";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";
import { useWishlist } from "@/contexts/WishlistContext";

/**
 * Buyer-facing detail page for ONE seller's listing (Phase 3b Part 3).
 * Reached via "See details" on a seller card in SellerListingsSection.tsx.
 * Shows everything the seller card can't fit: every variant (not just the
 * cheapest), all listing images (not just the first), video, description,
 * offer text, certification, delivery/warranty/return terms, and seller
 * info.
 *
 * Data comes from the new GET /seller-listings/:id route (Part 0/backend)
 * -- no existing buyer-facing endpoint served "one listing by id, publicly,
 * nested variants", so this phase added one (see handoff for details).
 *
 * Each variant row gets its own action: "Add to Bag" if it has stock
 * (availableQuantity > 0), "Pre-Order" if it's marked isPreOrder (a variant
 * can be both out of stock AND pre-orderable at the same time -- these are
 * independent flags on sellerListingVariantsTable, not mutually exclusive
 * states), or a plain "Out of stock" disabled state if neither applies.
 * This is the per-variant purchase surface Part 4 needed for pre-order to
 * become variant-aware -- see PreOrderCheckoutPage.tsx for where the link
 * below leads.
 */
export function SellerListingDetailPage() {
  const params = useParams<{ productId: string; listingId: string }>();
  const productId = parseInt(params.productId ?? "0");
  const listingId = parseInt(params.listingId ?? "0");
  const { user } = useUser();
  const qc = useQueryClient();
  const { toast } = useToast();
  const addToCart = useAddToCart();
  const { isWishlisted: isWishlistedFn, toggle: toggleWishlist } = useWishlist();
  const [activeImg, setActiveImg] = useState(0);
  const [isAdding, setIsAdding] = useState(false);
  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [descExpanded, setDescExpanded] = useState(false);

  const { data: card, isLoading, isError, refetch, isRefetching } = useGetSellerListing(listingId, {
    query: { enabled: !!listingId, queryKey: ["seller-listing", listingId] },
  });
  const images = card ? card.listing.images : [];

  // First variant is selected by default ("First Available Option" in the
  // design); once the person picks a pill, that choice sticks even if it's
  // technically out of stock -- the Add to Bag button itself reflects
  // stock state, rather than silently reassigning their selection.
  const selectedVariant = card
    ? card.listing.variants.find((v) => v.id === selectedVariantId) ?? card.listing.variants[0]
    : null;

  function handleAddToBag() {
    if (!card || !selectedVariant) return;
    if (!user) {
      toast({ title: "Sign in required", description: "Please sign in to buy from marketplace sellers.", variant: "destructive" });
      return;
    }
    setIsAdding(true);
    addToCart.mutate(
      { data: { productId, sellerListingVariantId: selectedVariant.id, quantity } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetCartQueryKey() });
          toast({ title: "Added to bag" });
        },
        onError: (err: any) => {
          toast({ title: "Couldn't add to bag", description: err?.message ?? "Please try again.", variant: "destructive" });
        },
        onSettled: () => setIsAdding(false),
      }
    );
  }

  function handleWishlistToggle() {
    if (!card) return;
    const price = selectedVariant ? (selectedVariant.discountPrice ?? selectedVariant.price) : 0;
    toggleWishlist({
      productId,
      name: card.seller.nurseryName,
      slug: String(productId),
      price,
      discountPrice: null,
      image: images[0] || "",
      scientificName: null,
      categoryId: null,
    });
  }

  function preOrderHref(variant: SellerListingVariant) {
    const price = variant.discountPrice ?? variant.price;
    const image = encodeURIComponent(images[0] ?? "");
    return `/pre-order-checkout?productId=${productId}&sellerListingVariantId=${variant.id}&name=${encodeURIComponent(variantLabel(variant))}&image=${image}&price=${price}&deliveryCharge=${variant.deliveryCharge}`;
  }

  function variantLabel(v: SellerListingVariant): string {
    return v.form || v.rootType || `Option #${v.id}`;
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-10">
          <Skeleton className="h-4 w-36 mb-8" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
            <Skeleton className="aspect-square w-full rounded-2xl" />
            <div className="space-y-4 pt-2">
              <Skeleton className="h-7 w-3/5" />
              <Skeleton className="h-5 w-2/5" />
              <Skeleton className="h-24 w-full rounded-xl" />
              <Skeleton className="h-24 w-full rounded-xl" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-20 text-center text-muted-foreground">
          <AlertTriangle className="h-8 w-8 mx-auto mb-3 text-destructive" />
          <p className="font-medium text-foreground">Couldn't load this listing</p>
          <p className="text-sm mt-1">Something went wrong on our end. Please try again.</p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button variant="outline" onClick={() => refetch()} disabled={isRefetching}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isRefetching ? "animate-spin" : ""}`} /> {isRefetching ? "Retrying…" : "Try again"}
            </Button>
            <Link href="/products"><Button variant="ghost">Back to shop</Button></Link>
          </div>
        </div>
      </div>
    );
  }

  if (!card) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-20 text-center text-muted-foreground">
          <PackageX className="h-8 w-8 mx-auto mb-3" />
          Listing not found.
          <div className="mt-4">
            <Link href="/products"><Button variant="outline">Back to shop</Button></Link>
          </div>
        </div>
      </div>
    );
  }

  const { listing, seller, rating, reviewCount } = card;
  const wishlisted = isWishlistedFn(productId);
  const price = selectedVariant ? (selectedVariant.discountPrice ?? selectedVariant.price) : 0;
  const originalPrice = selectedVariant?.price ?? 0;
  const discountPct = selectedVariant?.discountPrice != null
    ? Math.round((1 - selectedVariant.discountPrice / selectedVariant.price) * 100)
    : null;
  const inStock = (selectedVariant?.availableQuantity ?? 0) > 0;
  const addDisabled = !inStock && !selectedVariant?.isPreOrder;

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8 max-w-2xl">
        <PageBreadcrumb
          crumbs={[
            { label: "Products", href: "/products", icon: <ShoppingBag className="h-3 w-3" /> },
            { label: "Listing" },
          ]}
          className="mb-4"
        />
        <Link href={`/products/${productId}`}>
          <Button variant="ghost" size="sm" className="mb-4 gap-1 text-muted-foreground">
            <ChevronLeft className="h-4 w-4" /> Back to product
          </Button>
        </Link>

        <div className="space-y-4">
          {/* Seller byline */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="h-9 w-9 rounded-full border border-border overflow-hidden shrink-0 bg-muted/30 flex items-center justify-center">
                {seller.logoUrl ? (
                  <img src={seller.logoUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <Sprout className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-sm flex items-center gap-1.5 truncate">
                  {seller.nurseryName}
                  {seller.isVerified && (
                    <Award className="h-3.5 w-3.5 text-primary shrink-0" aria-label="Verified seller" />
                  )}
                </p>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <MapPin className="h-3 w-3 shrink-0" /> {seller.location}
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" className="shrink-0 text-xs h-8 rounded-full" disabled title="Coming soon">
              <StoreIcon className="h-3 w-3 mr-1" /> View Store
            </Button>
          </div>

          {/* Hero image, full-bleed with floating price badge */}
          <div className="relative -mx-4 sm:mx-0 mb-3">
            <div className="aspect-[4/3] sm:rounded-2xl overflow-hidden bg-muted/20">
              {images.length > 0 ? (
                <img src={images[activeImg]} alt={seller.nurseryName} className="w-full h-full object-cover" />
              ) : (
                <NoImagePlaceholder />
              )}
            </div>

            {reviewCount > 0 && (
              <div className="absolute top-3 left-3 flex items-center gap-1 bg-background/90 backdrop-blur-sm rounded-full pl-2 pr-2.5 py-1 shadow-sm">
                <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                <span className="text-xs font-bold">{rating.toFixed(1)}</span>
                <span className="text-xs text-muted-foreground">({reviewCount})</span>
              </div>
            )}

            <button
              onClick={handleWishlistToggle}
              className="absolute top-3 right-3 h-9 w-9 rounded-full bg-background/90 backdrop-blur-sm shadow-sm flex items-center justify-center"
              aria-label={wishlisted ? "Remove from wishlist" : "Add to wishlist"}
            >
              <Heart className={`h-4 w-4 ${wishlisted ? "fill-rose-500 stroke-rose-500" : "stroke-foreground"}`} />
            </button>

            {/* Price tag, overlapping the bottom edge of the photo */}
            <div className="absolute -bottom-5 left-4 sm:left-5 bg-primary text-primary-foreground rounded-2xl px-4 py-2.5 shadow-lg flex items-baseline gap-2">
              <span className="font-serif text-2xl font-bold">Tk{price.toLocaleString()}</span>
              {selectedVariant?.discountPrice != null && (
                <span className="text-xs text-primary-foreground/70 line-through">Tk{originalPrice.toLocaleString()}</span>
              )}
              {discountPct != null && discountPct > 0 && (
                <span className="text-[11px] font-semibold bg-primary-foreground/15 rounded-full px-2 py-0.5">{discountPct}% OFF</span>
              )}
            </div>
          </div>

          {/* Thumbnails */}
          {images.length > 1 && (
            <div className="flex gap-2">
              {images.map((img, i) => (
                <button
                  key={i}
                  onClick={() => setActiveImg(i)}
                  className={`w-14 h-14 rounded-xl overflow-hidden border-2 transition-colors shrink-0 ${activeImg === i ? "border-primary" : "border-transparent opacity-60 hover:opacity-100"}`}
                >
                  <img src={img} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}

          {listing.videoUrl && (
            <div className="relative w-full rounded-2xl overflow-hidden" style={{ paddingBottom: "56.25%" }}>
              <iframe
                className="absolute top-0 left-0 w-full h-full"
                src={listing.videoUrl.replace("watch?v=", "embed/")}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          )}

          {/* Purchase panel */}
          <div className="border rounded-2xl bg-card p-4 space-y-4">
            {listing.variants.length > 1 && (
              <div>
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Choose an option</h2>
                <div className="flex gap-2 overflow-x-auto -mx-1 px-1 pb-1">
                  {listing.variants.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => setSelectedVariantId(v.id)}
                      className={`shrink-0 h-9 px-3.5 rounded-full text-xs font-semibold border transition-colors whitespace-nowrap ${
                        selectedVariant?.id === v.id
                          ? "border-primary text-primary-foreground bg-primary"
                          : "border-border text-muted-foreground bg-background hover:bg-muted/30"
                      }`}
                    >
                      {variantLabel(v)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Specs, inline and unboxed */}
            {selectedVariant && (
              <div className="flex flex-wrap gap-x-5 gap-y-2.5 text-xs">
                {[
                  { icon: Sprout, title: "Age", value: selectedVariant.age },
                  { icon: Ruler, title: "Height", value: selectedVariant.height },
                  { icon: PotIcon, title: "Pot size", value: selectedVariant.potSize },
                  { icon: FlaskConical, title: "Root type", value: selectedVariant.rootType },
                  { icon: RefreshCw, title: "Returns", value: listing.returnPolicyText || "No return policy" },
                ].filter((s) => s.value).map((s, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-muted-foreground">
                    <s.icon className="h-3.5 w-3.5 text-accent shrink-0" />
                    <span>{s.title}: <span className="font-medium text-foreground">{s.value}</span></span>
                  </div>
                ))}
              </div>
            )}

            <div className="h-px bg-border" />

            {/* Stock + delivery, plain text row */}
            {selectedVariant && (
              <div className="flex items-center justify-between text-sm">
                <span className={`font-medium ${inStock ? "text-primary" : "text-destructive"}`}>
                  {inStock ? `${selectedVariant.availableQuantity} in stock` : "Out of stock"}
                </span>
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Truck className="h-3.5 w-3.5" />
                  {selectedVariant.deliveryCharge > 0 ? `Tk${selectedVariant.deliveryCharge} delivery` : "Free delivery"}
                  {listing.deliveryTimeDays != null && ` · ${listing.deliveryTimeDays} days`}
                </span>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 pt-1">
              {addDisabled ? (
                selectedVariant?.isPreOrder ? (
                  <Link href={selectedVariant ? preOrderHref(selectedVariant) : "#"} className="flex-1">
                    <Button className="w-full rounded-xl h-11 bg-blue-500 text-white hover:bg-blue-600">
                      <Ship className="mr-1.5 h-4 w-4" /> Pre-Order Now
                    </Button>
                  </Link>
                ) : (
                  <Button className="flex-1 rounded-xl h-11" disabled>
                    <PackageX className="mr-1.5 h-4 w-4" /> Out of Stock
                  </Button>
                )
              ) : (
                <Button className="flex-1 rounded-xl h-11" disabled={isAdding} onClick={handleAddToBag}>
                  {!user ? (
                    <><LogIn className="mr-1.5 h-4 w-4" /> Sign in to buy</>
                  ) : (
                    <><ShoppingBag className="mr-1.5 h-4 w-4" /> {isAdding ? "Adding…" : "Add to Bag"}</>
                  )}
                </Button>
              )}

              <div className="flex items-center border rounded-xl h-11 px-1 shrink-0">
                <button
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  className="h-9 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30"
                  disabled={quantity <= 1}
                  aria-label="Decrease quantity"
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
                <span className="w-6 text-center text-sm font-semibold">{quantity}</span>
                <button
                  onClick={() => setQuantity((q) => q + 1)}
                  className="h-9 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground"
                  aria-label="Increase quantity"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Description + info */}
          <div className="border rounded-2xl bg-card overflow-hidden">
            {listing.description && (
              <div className="p-4">
                <h4 className="font-semibold text-sm mb-1.5">Description</h4>
                <p className={`text-sm text-muted-foreground leading-relaxed ${!descExpanded ? "line-clamp-3" : ""}`}>
                  {listing.description}
                </p>
                {listing.description.length > 140 && (
                  <button
                    onClick={() => setDescExpanded((v) => !v)}
                    className="text-sm font-semibold text-primary flex items-center gap-1 mt-1.5"
                  >
                    {descExpanded ? "Show Less" : "Read More"}
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${descExpanded ? "rotate-180" : ""}`} />
                  </button>
                )}
              </div>
            )}

            {listing.offerText && (
              <p className="text-sm text-accent font-medium px-4 pb-3">{listing.offerText}</p>
            )}

            {listing.certification && (
              <div className="flex items-center justify-between px-4 py-3.5 border-t">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <Award className="h-4 w-4 text-muted-foreground" /> Certification
                </span>
                <span className="flex items-center gap-1 text-sm font-semibold text-primary">
                  {listing.certification} <Award className="h-3.5 w-3.5" />
                </span>
              </div>
            )}

            {listing.tags.length > 0 && (
              <div className="flex items-center gap-2 px-4 py-3.5 border-t">
                <Tag className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex gap-1.5 overflow-x-auto">
                  {listing.tags.map((t, i) => (
                    <span key={i} className="bg-primary/10 text-primary rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap">{t}</span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between px-4 py-3.5 border-t">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Eye className="h-4 w-4 text-muted-foreground" /> Visibility
              </span>
              <span className="text-sm text-muted-foreground capitalize">{listing.visibility}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
