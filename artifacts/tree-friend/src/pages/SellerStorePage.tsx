import { useState } from "react";
import { useParams, Link } from "wouter";
import { useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetPublicSeller,
  useGetSellerFollowStatus,
  useFollowSeller,
  useUnfollowSeller,
  getGetSellerFollowStatusQueryKey,
  getGetPublicSellerQueryKey,
  useListSellerListings,
  useListSellerReviews,
  getListSellerListingsQueryKey,
  getListSellerReviewsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";
import { useCurrency } from "@/lib/currency";
import { useToast } from "@/hooks/use-toast";
import {
  Star, MapPin, Package, Headset,
  ShieldCheck as ShieldIcon,
} from "lucide-react";

const ICON_VERIFIED =
  "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1785076114/0731e6a0-0e45-481d-bfab-5d82aac4e9d7_1_jas2kb.svg";

function StarRow({ rating, size = "h-3.5 w-3.5" }: { rating: number; size?: string }) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={`${size} ${i < Math.round(rating) ? "fill-accent text-accent" : "text-muted"}`}
        />
      ))}
    </div>
  );
}

/**
 * Buyer-facing Seller Store Page, reached via "View Store" on
 * SellerListingDetailPage.tsx. Layout follows the approved design
 * (hero + floating store card, stats row, About Store, All Products grid,
 * Customer Reviews with rating breakdown) but rebuilt with this codebase's
 * existing visual language (ProductCard.tsx's star/price treatment,
 * NoImagePlaceholder, useCurrency, Skeleton loading states) rather than
 * the raw HTML/CSS, and wired to real endpoints end-to-end.
 *
 * Messaging is intentionally out of scope for this pass (per product
 * decision) -- the design's Message button is not included here.
 * Delivery/Shipping Time footer is also omitted: those are per-listing
 * fields (deliveryTimeDays/deliveryCharge live on each variant), not a
 * single seller-level value the design's footer assumed.
 */
export function SellerStorePage() {
  const { sellerId } = useParams<{ sellerId: string }>();
  const id = parseInt(sellerId ?? "", 10);
  const { user } = useUser();
  const qc = useQueryClient();
  const { format } = useCurrency();
  const { toast } = useToast();

  const [reviewPage, setReviewPage] = useState(1);

  const { data: seller, isLoading: sellerLoading, isError: sellerError } = useGetPublicSeller(id, {
    query: { enabled: !!id, queryKey: getGetPublicSellerQueryKey(id) },
  });

  const { data: followStatus } = useGetSellerFollowStatus(id, {
    query: {
      enabled: !!id && !!user,
      queryKey: getGetSellerFollowStatusQueryKey(id),
    },
  });

  const followSeller = useFollowSeller();
  const unfollowSeller = useUnfollowSeller();

  const { data: products, isLoading: productsLoading } = useListSellerListings(id, undefined, {
    query: { enabled: !!id, queryKey: getListSellerListingsQueryKey(id) },
  });

  const { data: reviewsPage, isLoading: reviewsLoading } = useListSellerReviews(
    id,
    { page: reviewPage, limit: 10 },
    { query: { enabled: !!id, queryKey: getListSellerReviewsQueryKey(id, { page: reviewPage, limit: 10 }) } },
  );

  const isFollowing = followStatus?.isFollowing ?? false;
  const followPending = followSeller.isPending || unfollowSeller.isPending;

  function handleFollowToggle() {
    if (!user) {
      toast({ title: "Sign in to follow this store", description: "Create a free account to follow sellers and get updates." });
      return;
    }
    if (isFollowing) {
      unfollowSeller.mutate({ id }, {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetSellerFollowStatusQueryKey(id) });
          qc.invalidateQueries({ queryKey: getGetPublicSellerQueryKey(id) });
        },
      });
    } else {
      followSeller.mutate({ id }, {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetSellerFollowStatusQueryKey(id) });
          qc.invalidateQueries({ queryKey: getGetPublicSellerQueryKey(id) });
        },
      });
    }
  }

  if (sellerError) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-16 text-center">
        <h1 className="font-serif text-2xl font-medium mb-2">Store not found</h1>
        <p className="text-muted-foreground mb-6">This seller isn't available right now.</p>
        <Link href="/products"><Button>Browse Products</Button></Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 pt-4 pb-16">
      <PageBreadcrumb
        crumbs={[
          { label: "Products", href: "/products" },
          { label: seller?.nurseryName ?? "Store" },
        ]}
        className="mb-4"
      />

      {/* Hero */}
      <div className="h-40 sm:h-48 rounded-2xl bg-gradient-to-br from-accent/20 via-muted to-accent/10 mb-[-56px]" />

      {/* Store card */}
      <div className="relative bg-card border border-border rounded-2xl shadow-sm p-4 sm:p-5">
        {sellerLoading ? (
          <div className="flex items-center gap-3">
            <Skeleton className="w-14 h-14 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-28" />
            </div>
          </div>
        ) : seller ? (
          <>
            <div className="flex items-start gap-3">
              <div className="w-14 h-14 rounded-full overflow-hidden border shrink-0 bg-muted/30">
                {seller.logoUrl ? (
                  <img src={seller.logoUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <NoImagePlaceholder compact />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <h1 className="font-bold text-sm truncate">{seller.nurseryName}</h1>
                  {seller.isVerified && (
                    <img src={ICON_VERIFIED} alt="Verified" className="w-4 h-4 shrink-0" />
                  )}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <MapPin className="w-3 h-3 text-muted-foreground shrink-0" strokeWidth={1.5} />
                  <span className="text-[11px] text-muted-foreground">{seller.location}</span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Member since {new Date(seller.createdAt).toLocaleDateString(undefined, { month: "short", year: "numeric" })}
                </p>
              </div>
              <Button
                size="sm"
                variant={isFollowing ? "secondary" : "default"}
                disabled={followPending}
                onClick={handleFollowToggle}
                className="shrink-0"
              >
                {isFollowing ? "Following" : "Follow"}
              </Button>
            </div>

            <div className="grid grid-cols-4 border-t border-border mt-4 pt-3">
              {[
                { label: "Products", value: seller.productCount.toLocaleString() },
                { label: "Rating", value: seller.rating > 0 ? seller.rating.toFixed(1) : "–", star: true },
                { label: "Reviews", value: seller.reviewCount.toLocaleString() },
                { label: "Followers", value: seller.followerCount.toLocaleString() },
              ].map((stat, i) => (
                <div key={stat.label} className={`text-center ${i !== 0 ? "border-l border-border" : ""}`}>
                  <div className="flex items-center justify-center gap-1 font-bold text-sm">
                    {stat.star && <Star className="w-3.5 h-3.5 fill-accent text-accent" />}
                    {stat.value}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{stat.label}</div>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>

      {/* About Store */}
      {seller?.description && (
        <section className="mt-8">
          <h2 className="font-serif text-lg font-medium mb-2">About Store</h2>
          <p className="text-sm text-muted-foreground leading-relaxed mb-4">{seller.description}</p>
          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col items-center text-center gap-1.5 p-2">
              <ShieldIcon className="w-6 h-6 text-accent" strokeWidth={1.5} />
              <span className="text-[11px] font-semibold">Healthy Plants</span>
              <span className="text-[10px] text-muted-foreground">100% healthy</span>
            </div>
            <div className="flex flex-col items-center text-center gap-1.5 p-2">
              <Package className="w-6 h-6 text-accent" strokeWidth={1.5} />
              <span className="text-[11px] font-semibold">Secure Packaging</span>
              <span className="text-[10px] text-muted-foreground">Safe delivery</span>
            </div>
            <div className="flex flex-col items-center text-center gap-1.5 p-2">
              <Headset className="w-6 h-6 text-accent" strokeWidth={1.5} />
              <span className="text-[11px] font-semibold">Customer Support</span>
              <span className="text-[10px] text-muted-foreground">Always here to help</span>
            </div>
          </div>
        </section>
      )}

      {/* All Products */}
      <section className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-serif text-lg font-medium">All Products</h2>
          {(products?.length ?? 0) > 0 && (
            <span className="text-xs text-muted-foreground">{products!.length} listed</span>
          )}
        </div>
        {productsLoading ? (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="w-[130px] h-[190px] rounded-2xl shrink-0" />
            ))}
          </div>
        ) : (products?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center bg-muted/30 rounded-xl">
            This seller doesn't have any products listed right now.
          </p>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0">
            {products!.map((card) => {
              const variants = card.listing.variants;
              const inStock = variants.filter((v) => v.availableQuantity > 0);
              const cheapest = inStock.reduce<typeof inStock[number] | null>((min, v) => {
                const price = v.discountPrice ?? v.price;
                const minPrice = min ? (min.discountPrice ?? min.price) : Infinity;
                return price < minPrice ? v : min;
              }, null);
              const hasDiscount = cheapest?.discountPrice != null;
              const pctOff = hasDiscount
                ? Math.round(((cheapest!.price - cheapest!.discountPrice!) / cheapest!.price) * 100)
                : 0;
              const img = card.listing.images[0];

              return (
                <Link
                  key={card.listing.id}
                  href={`/products/${card.product.id}/listings/${card.listing.id}`}
                  className="shrink-0 w-[130px]"
                >
                  <article className="border border-border rounded-2xl p-2.5 h-full flex flex-col bg-card hover:shadow-md transition-shadow">
                    <div className="w-full aspect-square rounded-lg overflow-hidden bg-muted/30 mb-2">
                      {img ? (
                        <img src={img} alt={card.product.name} className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                        <NoImagePlaceholder />
                      )}
                    </div>
                    <h3 className="text-xs font-semibold leading-snug line-clamp-2 mb-1">{card.product.name}</h3>
                    {cheapest && (
                      <div className="flex items-center flex-wrap gap-1 mb-1">
                        <span className="text-sm font-bold text-accent">{format(cheapest.discountPrice ?? cheapest.price)}</span>
                        {hasDiscount && (
                          <>
                            <span className="text-[10px] text-muted-foreground line-through">{format(cheapest.price)}</span>
                            <span className="text-[9px] font-bold bg-accent/10 text-accent px-1 py-0.5 rounded">{pctOff}% OFF</span>
                          </>
                        )}
                      </div>
                    )}
                    <div className="flex items-center gap-1 mt-auto">
                      <StarRow rating={card.rating} size="h-2.5 w-2.5" />
                      {card.reviewCount > 0 && (
                        <span className="text-[10px] text-muted-foreground">({card.reviewCount})</span>
                      )}
                    </div>
                  </article>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Customer Reviews */}
      <section className="mt-8">
        <h2 className="font-serif text-lg font-medium mb-3">Customer Reviews</h2>
        {reviewsLoading ? (
          <Skeleton className="h-24 w-full rounded-xl" />
        ) : (
          <>
            {reviewsPage && reviewsPage.total > 0 && (
              <div className="flex items-center gap-6 mb-5">
                <div className="text-center shrink-0">
                  <div className="flex items-center gap-1 font-bold text-3xl">
                    {reviewsPage.averageRating.toFixed(1)}
                    <Star className="w-5 h-5 fill-accent text-accent" />
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">({reviewsPage.total} reviews)</div>
                </div>
                <div className="flex-1 flex flex-col gap-1">
                  {([5, 4, 3, 2, 1] as const).map((star) => {
                    const count = reviewsPage.ratingBreakdown[String(star) as "1" | "2" | "3" | "4" | "5"];
                    const pct = reviewsPage.total > 0 ? (count / reviewsPage.total) * 100 : 0;
                    return (
                      <div key={star} className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="w-8 shrink-0">{star} star</span>
                        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className="h-full bg-accent rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="w-6 text-right shrink-0">{count}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {(reviewsPage?.reviews.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center bg-muted/30 rounded-xl">
                No reviews yet for this seller.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {reviewsPage!.reviews.map((r) => (
                  <div key={r.id} className="border border-border rounded-xl p-3 flex gap-3">
                    <div className="w-9 h-9 rounded-full bg-muted shrink-0 flex items-center justify-center text-xs font-semibold text-muted-foreground">
                      {r.userName.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold">{r.userName}</p>
                          <p className="text-[10px] text-muted-foreground">{new Date(r.createdAt).toLocaleDateString()}</p>
                        </div>
                        <StarRow rating={r.rating} size="h-3 w-3" />
                      </div>
                      <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{r.comment}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {reviewsPage && reviewsPage.total > reviewsPage.limit && (
              <div className="flex items-center justify-center gap-3 mt-4">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={reviewPage <= 1}
                  onClick={() => setReviewPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                  Page {reviewsPage.page} of {Math.ceil(reviewsPage.total / reviewsPage.limit)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={reviewPage >= Math.ceil(reviewsPage.total / reviewsPage.limit)}
                  onClick={() => setReviewPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
