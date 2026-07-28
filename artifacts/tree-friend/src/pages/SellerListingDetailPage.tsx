import { useState, type CSSProperties } from "react";
import { useParams, Link } from "wouter";
import { useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSellerListing, useAddToCart, getGetCartQueryKey, useGetProduct,
  type SellerListingVariant,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Star, MapPin, ShoppingBag, Heart,
  LogIn, ChevronLeft, ChevronDown, PackageX, Ship,
  Tag, Eye, Minus, Plus,
  AlertTriangle, RefreshCw,
} from "lucide-react";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { useToast } from "@/hooks/use-toast";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";
import { useWishlist } from "@/contexts/WishlistContext";
import { SellerListingReviews } from "@/components/ui/SellerListingReviews";
import { SellerListingQA } from "@/components/ui/SellerListingQA";

// Exact icon URLs from the approved design HTML -- used as-is rather than
// substituted with Lucide equivalents, so the icons themselves match
// pixel-for-pixel, not just the general idea of "an age icon".
const ICON_AGE = "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1785064361/Screenshot_2026-07-26-17-07-39-05-removebg-preview_1_i6gaeo.svg";
const ICON_HEIGHT = "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1785063950/gemini-svg_s3wmuj.svg";
const ICON_POT_SIZE = "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1784038665/3ea78cc9-20bd-4046-afa6-bc9a3727f8e5_fsj5gg.svg";
const ICON_ROOT_TYPE = "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1784964253/cropped-3202ecfd-40ba-4eab-8ecc-6407723adfe1_zu9mta.svg";
const ICON_DELIVERY = "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1784964252/cropped-2ff97d73-edfc-4404-b2ea-6682be7fab47_hmwjx9.svg";
const ICON_STOCK = "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1784964252/cropped-5f31b56a-2207-4587-9c06-d3fad4d6a781_yvdmdu.svg";
const ICON_VERIFIED = "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1785076114/0731e6a0-0e45-481d-bfab-5d82aac4e9d7_1_jas2kb.svg";
const ICON_CERTIFICATION = "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1785076114/714f4f94-8cc6-4a33-a9a5-d41a473420b3_1_qa2y34.svg";
const ICON_CERT_CHECK = "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1785076114/ed56757c-1dbc-410f-8afd-6aa8a79b9837_1_lafxow.svg";
const ICON_GRAFTED = "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1784964252/cropped-8a860daf-2b7c-47df-bbb7-32935c65b173_f388pi.svg";

// The design's Return Policy spec-tile icon is a plain inline SVG (not a
// Cloudinary asset) -- reproduced verbatim from the HTML rather than
// substituted with a different icon.
function ReturnPolicyIcon({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} style={style}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

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
  const { isSellerListingWishlisted, toggleSellerListing } = useWishlist();
  const [activeImg, setActiveImg] = useState(0);
  const [isAdding, setIsAdding] = useState(false);
  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [descExpanded, setDescExpanded] = useState(false);

  const { data: card, isLoading, isError, refetch, isRefetching } = useGetSellerListing(listingId, {
    query: { enabled: !!listingId, queryKey: ["seller-listing", listingId] },
  });
  // Only needed for the guest-side wishlist item's productName field (see
  // handleWishlistToggle) -- logged-in users get the real product name
  // from the server's GET /wishlist response instead, so this fetch is
  // wasted for them but harmless (cached under the same key ProductDetailPage
  // uses, so it's likely already warm from browsing).
  const { data: product } = useGetProduct(productId, { query: { enabled: !!productId, queryKey: ["product", productId] } });
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
    if (!card || !selectedVariant) return;
    toggleSellerListing({
      sellerListingVariantId: selectedVariant.id,
      sellerListingId: card.listing.id,
      productId,
      productName: product?.name ?? "Listing",
      image: images[0] || "",
      sellerName: card.seller.nurseryName,
      price: selectedVariant.discountPrice ?? selectedVariant.price,
      discountPrice: null,
      variantLabel: variantLabel(selectedVariant),
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
  const wishlisted = selectedVariant ? isSellerListingWishlisted(selectedVariant.id) : false;
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

        <div className="space-y-3">
          {/* Store header -- Tailwind arbitrary-value classes carrying the
              exact px values from the approved design HTML (.store-card /
              .store-logo / .store-details h3 / etc.), so this stays
              consistent with the rest of the codebase instead of raw
              inline styles, while still matching pixel-for-pixel. */}
          <div className="border rounded-2xl bg-card flex items-center justify-between gap-3 p-[14px_16px]">
            <div className="flex items-center gap-3 min-w-0">
              <div className="shrink-0 overflow-hidden border bg-muted/30 flex items-center justify-center w-[42px] h-[42px] rounded-[10px]">
                {seller.logoUrl ? (
                  <img src={seller.logoUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <img src={ICON_GRAFTED} alt="" className="w-5 h-5 opacity-40" />
                )}
              </div>
              <div className="min-w-0 flex flex-col gap-0.5">
                <h3 className="flex items-center gap-1.5 truncate text-[13px] font-bold text-[#111827]">
                  {seller.nurseryName}
                  {seller.isVerified && (
                    <img src={ICON_VERIFIED} alt="Verified" className="w-4 h-4 shrink-0" />
                  )}
                </h3>
                <div className="flex items-center gap-1">
                  <MapPin className="w-3 h-3 text-[#9CA3AF] shrink-0" strokeWidth={1.5} />
                  <span className="text-[10px] font-medium text-[#6B7280] leading-[1.2]">{seller.location}</span>
                </div>
              </div>
            </div>
            <button
              disabled
              title="Coming soon"
              className="border bg-white shrink-0 h-7 px-[10px] rounded-md text-[11px] font-semibold text-[#111827] opacity-60"
            >
              View Store
            </button>
          </div>

          {/* Images */}
          <div className="border rounded-2xl bg-card p-3">
            <div className="aspect-square rounded-xl overflow-hidden bg-muted/20">
              {images.length > 0 ? (
                <img src={images[activeImg]} alt={seller.nurseryName} className="w-full h-full object-cover" />
              ) : (
                <NoImagePlaceholder />
              )}
            </div>
            {images.length > 1 && (
              <div className="flex gap-2 flex-wrap mt-3">
                {images.map((img, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveImg(i)}
                    className={`w-14 h-14 rounded-lg overflow-hidden border-2 transition-colors ${activeImg === i ? "border-primary" : "border-transparent"}`}
                  >
                    <img src={img} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
            {listing.videoUrl && (
              <div className="relative w-full mt-3" style={{ paddingBottom: "56.25%" }}>
                <iframe
                  className="absolute top-0 left-0 w-full h-full rounded-xl"
                  src={listing.videoUrl.replace("watch?v=", "embed/")}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            )}
          </div>

          {/* Options + price + actions */}
          <div className="border rounded-2xl bg-card flex flex-col gap-[14px] p-[14px]">
            <h2 className="text-[14px] font-bold text-[#111827]">
              Available Option{listing.variants.length > 1 ? "s" : ""}
            </h2>

            <div className="flex gap-[10px] overflow-x-auto [scrollbar-width:none]">
              {listing.variants.map((v) => {
                const active = selectedVariant?.id === v.id;
                return (
                  <button
                    key={v.id}
                    onClick={() => setSelectedVariantId(v.id)}
                    className={`shrink-0 flex items-center justify-center gap-1 whitespace-nowrap min-w-[80px] h-8 rounded-md text-xs font-semibold border ${
                      active ? "border-[#15803D] text-[#15803D] bg-[#DCFCE7]" : "border-[#E5E7EB] text-[#6B7280] bg-white"
                    }`}
                  >
                    {v.form === "grafted" && <img src={ICON_GRAFTED} alt="" className="w-3.5 h-3.5" />}
                    {variantLabel(v)}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between flex-wrap gap-2">
              {reviewCount > 0 && (
                <div className="flex items-center gap-1">
                  <Star className="w-4 h-4 fill-[#15803D] text-[#15803D]" />
                  <span className="text-[15px] font-bold text-[#15803D]">{rating.toFixed(1)}</span>
                  <span className="text-[13px] font-medium text-[#6B7280]">({reviewCount} review{reviewCount !== 1 ? "s" : ""})</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-[19px] font-bold text-[#15803D]">৳{price.toLocaleString()}</span>
                {selectedVariant?.discountPrice != null && (
                  <>
                    <span className="text-[13px] font-medium text-[#9CA3AF] line-through">৳{originalPrice.toLocaleString()}</span>
                    {discountPct != null && discountPct > 0 && (
                      <span className="bg-[#DCFCE7] text-[#15803D] text-[11px] font-semibold px-[6px] py-[3px] rounded">{discountPct}% OFF</span>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              {addDisabled ? (
                selectedVariant?.isPreOrder ? (
                  <Link href={selectedVariant ? preOrderHref(selectedVariant) : "#"} className="flex-1">
                    <Button className="w-full rounded-lg bg-blue-500 text-white hover:bg-blue-600">
                      <Ship className="mr-1.5 h-4 w-4" /> Pre-Order Now
                    </Button>
                  </Link>
                ) : (
                  <Button className="flex-1 rounded-lg" disabled>
                    <PackageX className="mr-1.5 h-4 w-4" /> Out of Stock
                  </Button>
                )
              ) : (
                <button
                  onClick={handleAddToBag}
                  disabled={isAdding}
                  className="flex-1 flex items-center justify-center gap-1.5 h-10 bg-[#15803D] text-white border-none rounded-lg text-sm font-semibold"
                >
                  {!user ? (
                    <><LogIn className="w-4 h-4" /> Sign in to buy</>
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                        <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
                        <line x1="3" y1="6" x2="21" y2="6"></line>
                        <path d="M16 10a4 4 0 0 1-8 0"></path>
                      </svg>
                      {isAdding ? "Adding…" : "Add to Bag"}
                    </>
                  )}
                </button>
              )}

              <div className="flex items-center justify-between shrink-0 w-24 h-10 border border-[#E5E7EB] rounded-lg px-3">
                <button
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  disabled={quantity <= 1}
                  className="flex items-center bg-transparent border-none text-[#6B7280] disabled:opacity-30"
                  aria-label="Decrease quantity"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <span className="text-sm font-semibold text-[#111827]">{quantity}</span>
                <button
                  onClick={() => setQuantity((q) => q + 1)}
                  className="flex items-center bg-transparent border-none text-[#6B7280]"
                  aria-label="Increase quantity"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>

              <button
                onClick={handleWishlistToggle}
                className="shrink-0 flex items-center justify-center w-10 h-10 border border-[#E5E7EB] rounded-lg bg-white"
                aria-label={wishlisted ? "Remove from wishlist" : "Add to wishlist"}
              >
                <Heart className={`w-5 h-5 ${wishlisted ? "fill-rose-500 stroke-rose-500" : "stroke-[#111827] fill-none"}`} />
              </button>
            </div>

            {/* Specs grid -- Tailwind arbitrary values from the design
                HTML's .specs-box / .spec-item rules */}
            {selectedVariant && (
              <div className="border border-[#E5E7EB] rounded-lg grid grid-cols-3 overflow-hidden">
                {[
                  { icon: ICON_AGE, title: "Age", value: selectedVariant.age },
                  { icon: ICON_HEIGHT, title: "Height", value: selectedVariant.height },
                  { icon: ICON_POT_SIZE, title: "Pot Size", value: selectedVariant.potSize },
                  { icon: ICON_ROOT_TYPE, title: "Root Type", value: selectedVariant.rootType },
                  { icon: ICON_DELIVERY, title: "Delivery Time", value: listing.deliveryTimeDays != null ? `${listing.deliveryTimeDays} Days` : null },
                  { icon: null, title: "Return Policy", value: listing.returnPolicyText || "No Return Policy" },
                ].filter((s) => s.value).map((s, i, arr) => (
                  <div
                    key={i}
                    className="flex flex-col items-center justify-center text-center gap-1.5 p-[12px_4px] min-h-[62px]"
                    style={{
                      borderRight: (i + 1) % 3 !== 0 ? "1px solid #E5E7EB" : "none",
                      borderBottom: i < arr.length - 3 ? "1px solid #E5E7EB" : "none",
                    }}
                  >
                    {s.icon ? (
                      <img src={s.icon} alt={s.title} className="w-7 h-7 object-contain" />
                    ) : (
                      <ReturnPolicyIcon className="w-7 h-7 text-[#111827]" />
                    )}
                    <span className="text-xs font-semibold text-[#111827]">{s.title}</span>
                    <span className="text-[11px] font-medium text-[#6B7280] leading-[1.3]">{s.value}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Stock + delivery -- Tailwind arbitrary values from
                .stock-delivery-box */}
            {selectedVariant && (
              <div className="flex h-[38px] border border-[#E5E7EB] rounded-lg overflow-hidden">
                <div className="flex items-center justify-center flex-1 gap-1.5 text-[13px] font-semibold text-[#111827] border-r border-[#E5E7EB]">
                  <img src={ICON_STOCK} alt="" className="w-5 h-5" />
                  {inStock ? `${selectedVariant.availableQuantity} in stock` : "Out of stock"}
                </div>
                <div className="flex items-center justify-center flex-1 gap-1.5 text-[13px] font-semibold text-[#111827]">
                  <img src={ICON_DELIVERY} alt="" className="w-5 h-5" />
                  {selectedVariant.deliveryCharge > 0 ? `৳${selectedVariant.deliveryCharge} delivery` : "Free delivery"}
                </div>
              </div>
            )}
          </div>

          {/* Description + info -- exact px values from .description-box / .list-item */}
          <div className="border rounded-2xl bg-card overflow-hidden">
            {listing.description && (
              <div className="p-4">
                <h4 className="text-sm font-bold text-[#111827] mb-2">Description</h4>
                <p
                  className={`text-[13px] font-normal leading-[1.5] text-[#6B7280] mb-2 ${!descExpanded ? "line-clamp-3" : ""}`}
                >
                  {listing.description}
                </p>
                {listing.description.length > 140 && (
                  <button
                    onClick={() => setDescExpanded((v) => !v)}
                    className="flex items-center gap-1 text-[13px] font-semibold text-[#15803D] bg-transparent border-none"
                  >
                    {descExpanded ? "Show Less" : "Read More"}
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${descExpanded ? "rotate-180" : ""}`} />
                  </button>
                )}
              </div>
            )}

            {listing.offerText && (
              <p className="text-[13px] text-[#15803D] font-medium px-4 pb-3">{listing.offerText}</p>
            )}

            {listing.certification && (
              <div className="flex items-center justify-between p-[14px_12px] border-t border-[#E5E7EB]">
                <span className="flex items-center gap-[5px] text-xs font-semibold text-[#111827]">
                  <img src={ICON_CERTIFICATION} alt="" className="w-7 h-7 object-contain" />
                  Certification
                </span>
                <span className="flex items-center gap-1 text-xs font-semibold text-[#111827]">
                  {listing.certification}
                  <img src={ICON_CERT_CHECK} alt="" className="w-3 h-3 object-contain" />
                </span>
              </div>
            )}

            {listing.tags.length > 0 && (
              <div className="flex items-center gap-[5px] p-[14px_12px] border-t border-[#E5E7EB]">
                <Tag className="w-4 h-4 text-[#111827] shrink-0" strokeWidth={1.5} />
                <span className="text-xs font-semibold text-[#111827]">Tags</span>
                <div className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
                  {listing.tags.map((t, i) => (
                    <span key={i} className="bg-[#DCFCE7] text-[#15803D] px-2 py-0.5 rounded text-[10px] font-medium whitespace-nowrap">{t}</span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between p-[14px_12px] border-t border-[#E5E7EB]">
              <span className="flex items-center gap-[5px] text-xs font-semibold text-[#111827]">
                <Eye className="w-4 h-4 text-[#111827]" strokeWidth={1.5} /> Visibility
              </span>
              <span className="text-xs font-medium text-[#6B7280] capitalize">{listing.visibility}</span>
            </div>
          </div>
        </div>

        <SellerListingReviews sellerListingId={listing.id} productId={productId} />
        <SellerListingQA sellerListingId={listing.id} ownerSellerId={seller.id} />
      </div>
    </div>
  );
}
