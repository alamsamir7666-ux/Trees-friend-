import { useState } from "react";
import { useParams, Link } from "wouter";
import { useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSellerListing, useAddToCart, getGetCartQueryKey,
  type SellerListingVariant,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Star, MapPin, Sprout, Truck, ShieldCheck, RotateCcw, Award, ShoppingBag,
  LogIn, ChevronLeft, PackageX, Ship,
} from "lucide-react";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { useToast } from "@/hooks/use-toast";

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
  const [activeImg, setActiveImg] = useState(0);
  const [addingVariantId, setAddingVariantId] = useState<number | null>(null);

  const { data: card, isLoading } = useGetSellerListing(listingId, {
    query: { enabled: !!listingId, queryKey: ["seller-listing", listingId] },
  });
  const images = card && card.listing.images.length > 0
    ? card.listing.images
    : ["https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=600&q=80&fm=webp"];

  function handleAddToBag(variant: SellerListingVariant) {
    if (!user) {
      toast({ title: "Sign in required", description: "Please sign in to buy from marketplace sellers.", variant: "destructive" });
      return;
    }
    setAddingVariantId(variant.id);
    addToCart.mutate(
      { data: { productId, sellerListingVariantId: variant.id, quantity: 1 } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetCartQueryKey() });
          toast({ title: "Added to bag" });
        },
        onError: (err: any) => {
          toast({ title: "Couldn't add to bag", description: err?.message ?? "Please try again.", variant: "destructive" });
        },
        onSettled: () => setAddingVariantId(null),
      }
    );
  }

  function preOrderHref(variant: SellerListingVariant) {
    const price = variant.discountPrice ?? variant.price;
    const image = encodeURIComponent(images[0] ?? "");
    return `/pre-order-checkout?productId=${productId}&sellerListingVariantId=${variant.id}&name=${encodeURIComponent(variantLabel(variant))}&image=${image}&price=${price}&deliveryCharge=${variant.deliveryCharge}`;
  }

  function variantLabel(v: SellerListingVariant): string {
    return [v.form, v.height, v.potSize, v.age].filter(Boolean).join(" · ") || `Option #${v.id}`;
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

  if (!card) {
    return (
      <div className="py-20 text-center text-muted-foreground">
        Listing not found.
        <div className="mt-4">
          <Link href="/products"><Button variant="outline">Back to shop</Button></Link>
        </div>
      </div>
    );
  }

  const { listing, seller, rating, reviewCount } = card;

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8">
        <PageBreadcrumb
          crumbs={[
            { label: "Products", href: "/products", icon: <ShoppingBag className="h-3 w-3" /> },
            { label: "Listing" },
          ]}
          className="mb-4"
        />
        <Link href={`/products/${productId}`}>
          <Button variant="ghost" size="sm" className="mb-6 gap-1 text-muted-foreground">
            <ChevronLeft className="h-4 w-4" /> Back to product
          </Button>
        </Link>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 mb-10">
          {/* Images + video */}
          <div className="space-y-4">
            <div className="aspect-square rounded-2xl overflow-hidden bg-muted/20 border">
              <img src={images[activeImg]} alt={seller.nurseryName} className="w-full h-full object-cover" />
            </div>
            {images.length > 1 && (
              <div className="flex gap-3 flex-wrap">
                {images.map((img, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveImg(i)}
                    className={`w-16 h-16 rounded-xl overflow-hidden border-2 transition-colors ${activeImg === i ? "border-primary" : "border-transparent"}`}
                  >
                    <img src={img} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
            {listing.videoUrl && (
              <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
                <iframe
                  className="absolute top-0 left-0 w-full h-full rounded-xl"
                  src={listing.videoUrl.replace("watch?v=", "embed/")}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            )}
          </div>

          {/* Seller info + listing terms */}
          <div className="flex flex-col">
            <p className="font-medium text-lg flex items-center gap-1.5">
              <Sprout className="h-4 w-4 text-accent shrink-0" /> {seller.nurseryName}
            </p>
            <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
              <MapPin className="h-3.5 w-3.5" /> {seller.location}
            </p>
            {reviewCount > 0 && (
              <div className="flex items-center gap-1 text-sm font-medium mt-2 bg-amber-50 text-amber-700 px-2.5 py-1 rounded-full w-fit">
                <Star className="h-3.5 w-3.5 fill-amber-500 text-amber-500" /> {rating.toFixed(1)}
                <span className="text-amber-600/70">({reviewCount} review{reviewCount !== 1 ? "s" : ""})</span>
              </div>
            )}

            {listing.description && (
              <p className="text-sm text-muted-foreground leading-relaxed mt-4">{listing.description}</p>
            )}

            {listing.offerText && (
              <p className="text-sm text-accent font-medium mt-3">{listing.offerText}</p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-5">
              {listing.deliveryTimeDays != null && (
                <div className="flex items-center gap-2 text-sm bg-muted/30 rounded-lg px-3 py-2">
                  <Truck className="h-4 w-4 text-accent shrink-0" /> {listing.deliveryTimeDays}-day delivery
                </div>
              )}
              {listing.warrantyDays != null && (
                <div className="flex items-center gap-2 text-sm bg-muted/30 rounded-lg px-3 py-2">
                  <ShieldCheck className="h-4 w-4 text-accent shrink-0" /> {listing.warrantyDays}-day warranty
                </div>
              )}
              {listing.certification && (
                <div className="flex items-center gap-2 text-sm bg-muted/30 rounded-lg px-3 py-2">
                  <Award className="h-4 w-4 text-accent shrink-0" /> {listing.certification}
                </div>
              )}
              <div className="flex items-center gap-2 text-sm bg-muted/30 rounded-lg px-3 py-2">
                <Badge variant="secondary" className="text-xs capitalize">{listing.paymentMethod === "cod" ? "Cash on delivery" : listing.paymentMethod === "advance" ? "Advance payment" : "COD or advance"}</Badge>
              </div>
            </div>

            {listing.returnPolicyText && (
              <div className="flex items-start gap-2 text-sm text-muted-foreground bg-muted/30 rounded-xl px-4 py-3 mt-4">
                <RotateCcw className="h-4 w-4 mt-0.5 shrink-0 text-accent" />
                <div>
                  <p className="font-medium text-foreground mb-0.5">Return Policy</p>
                  <p>{listing.returnPolicyText}</p>
                </div>
              </div>
            )}

            {listing.tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-4">
                {listing.tags.map((t, i) => (
                  <span key={i} className="bg-accent/10 text-accent border border-accent/20 rounded-full px-3 py-1 text-xs font-medium">{t}</span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Variants */}
        <section className="border-t pt-10">
          <h2 className="font-serif text-2xl font-medium mb-6">Available Options</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {listing.variants.map((v) => {
              const inStock = v.availableQuantity > 0;
              const isAdding = addingVariantId === v.id && addToCart.isPending;
              const price = v.discountPrice ?? v.price;
              return (
                <div key={v.id} className="border rounded-2xl p-4 bg-card flex flex-col">
                  <p className="font-medium text-sm mb-1">{variantLabel(v)}</p>
                  {v.condition && <p className="text-xs text-muted-foreground mb-2">{v.condition}</p>}
                  <div className="flex items-baseline gap-2 mb-2">
                    <span className="font-serif text-xl font-medium">Tk{price.toLocaleString()}</span>
                    {v.discountPrice != null && (
                      <span className="text-sm text-muted-foreground line-through">Tk{v.price.toLocaleString()}</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">
                    {inStock ? `${v.availableQuantity} in stock` : "Out of stock"}
                    {v.deliveryCharge > 0 && ` · Tk${v.deliveryCharge} delivery`}
                  </p>

                  <div className="mt-auto">
                    {inStock ? (
                      <Button
                        className="w-full rounded-full"
                        size="sm"
                        disabled={isAdding}
                        onClick={() => handleAddToBag(v)}
                      >
                        {!user ? (
                          <><LogIn className="mr-1.5 h-3.5 w-3.5" /> Sign in to buy</>
                        ) : (
                          <><ShoppingBag className="mr-1.5 h-3.5 w-3.5" /> {isAdding ? "Adding…" : "Add to Bag"}</>
                        )}
                      </Button>
                    ) : v.isPreOrder ? (
                      <Link href={preOrderHref(v)}>
                        <Button className="w-full rounded-full bg-blue-500 text-white hover:bg-blue-600" size="sm">
                          <Ship className="mr-1.5 h-3.5 w-3.5" /> Pre-Order Now
                        </Button>
                      </Link>
                    ) : (
                      <Button className="w-full rounded-full" size="sm" disabled>
                        <PackageX className="mr-1.5 h-3.5 w-3.5" /> Out of Stock
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
