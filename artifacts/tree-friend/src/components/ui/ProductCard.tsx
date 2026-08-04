import { memo } from "react";
import { Link } from "wouter";
import { Heart, Star, Users, ChevronRight, BarChart2 } from "lucide-react";
import { type Product } from "@workspace/api-client-react";
import { useComparison } from "@/components/ui/ProductComparison";
import { useWishlist } from "@/contexts/WishlistContext";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";

/**
 * Product card with vertical layout: tall image on top, seller count badge,
 * large product title, star rating, and a full-width "View details" CTA
 * button. Used across browse, products, wishlist, and detail pages.
 *
 * The card displays `listingCount` as "Available seller N" — in the
 * marketplace model, products don't have a single price; each seller's
 * listing variant has its own. The CTA navigates to the product detail
 * page where the buyer picks a seller and variant.
 */
function ProductCardInner({
  product,
  backContext,
  priority = false,
}: {
  product: Product;
  backContext?: string;
  priority?: boolean;
}) {
  const { isWishlisted: isWishlistedFn, toggle: toggleWishlist } = useWishlist();
  const { addToCompare, removeFromCompare, isInCompare } = useComparison();
  const inCompare = isInCompare(product.id);
  const isWishlisted = isWishlistedFn(product.id);

  const hasListings = product.listingCount > 0 && product.listingMinPrice != null;
  const sellerCount = product.listingCount ?? 0;

  function handleWishlist(e: React.MouseEvent) {
    e.preventDefault();
    toggleWishlist({
      productId: product.id,
      name: product.name,
      slug: product.slug,
      price: product.listingMinPrice ?? 0,
      discountPrice: null,
      image: product.images?.[0] || "",
      scientificName: product.scientificName,
      categoryId: product.categoryId,
    });
  }

  function handleCompare(e: React.MouseEvent) {
    e.preventDefault();
    inCompare ? removeFromCompare(product.id) : addToCompare(product.id);
  }

  // Larger Cloudinary transform for the taller image area
  const rawImg = product.images[0] || null;
  const img = rawImg && rawImg.includes("res.cloudinary.com")
    ? rawImg.replace("/upload/", "/upload/w_500,h_650,c_fill,f_webp,q_80/")
    : rawImg;

  const href = backContext
    ? "/products/" + product.id + "?from=" + encodeURIComponent(backContext)
    : "/products/" + product.id;

  return (
    <Link href={href}>
      <article
        className="group relative bg-card border border-border rounded-3xl overflow-hidden transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5 cursor-pointer flex flex-col h-full"
        aria-label={product.name + (hasListings ? ` - ${sellerCount} seller${sellerCount !== 1 ? "s" : ""} available` : " - no sellers available")}
      >
        {/* ── Image area (3:4 portrait ratio) ──────────────────────────── */}
        <div className="relative aspect-[3/4] overflow-hidden bg-muted/30">
          {img ? (
            <img
              src={img}
              alt={product.name}
              className={
                "w-full h-full object-cover transition-transform duration-500 group-hover:scale-105 " +
                (!hasListings ? "opacity-50 grayscale" : "")
              }
              loading={priority ? "eager" : "lazy"}
              decoding="async"
              width="500"
              height="650"
            />
          ) : (
            <NoImagePlaceholder />
          )}

          {/* ── Seller count badge (top-left, pill-shaped) ─────────────── */}
          <div className="absolute top-3 left-3 right-3 flex justify-start">
            <span
              className={
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold shadow-sm backdrop-blur-sm " +
                (hasListings
                  ? "bg-white/95 text-emerald-700"
                  : "bg-white/95 text-muted-foreground")
              }
            >
              <Users className="h-4 w-4" />
              <span>Available seller {sellerCount}</span>
            </span>
          </div>

          {/* ── Wishlist button (top-right) ────────────────────────────── */}
          <button
            onClick={handleWishlist}
            className={
              "absolute top-3 right-3 p-2 rounded-full bg-background/85 backdrop-blur-sm shadow-sm transition-all duration-200 hover:scale-110 " +
              (isWishlisted ? "text-destructive opacity-100" : "text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive")
            }
            aria-label={isWishlisted ? "Remove from wishlist" : "Add to wishlist"}
          >
            <Heart className={"h-4 w-4 " + (isWishlisted ? "fill-current" : "")} />
          </button>

          {/* ── Compare button (bottom-left, on hover) ─────────────────── */}
          <button
            onClick={handleCompare}
            className={
              "absolute bottom-3 left-3 p-2 rounded-full bg-background/85 backdrop-blur-sm shadow-sm transition-all duration-200 hover:scale-110 " +
              (inCompare ? "text-accent opacity-100" : "text-muted-foreground opacity-0 group-hover:opacity-100")
            }
            aria-label={inCompare ? "Remove from comparison" : "Add to comparison"}
          >
            <BarChart2 className={"h-4 w-4 " + (inCompare ? "fill-current" : "")} />
          </button>
        </div>

        {/* ── Content area ─────────────────────────────────────────────── */}
        <div className="p-5 pt-4 flex flex-col flex-1 gap-3">
          {/* Product title — large, bold */}
          <h3 className="font-bold text-xl leading-tight line-clamp-2">
            {product.name}
          </h3>

          {/* Star rating — larger icons */}
          <div className="flex items-center gap-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star
                key={i}
                className={
                  "h-4 w-4 " +
                  (i < Math.round(product.averageRating)
                    ? "fill-amber-400 text-amber-400"
                    : "text-muted-foreground/40")
                }
                aria-hidden="true"
              />
            ))}
            {product.reviewCount > 0 && (
              <span className="text-sm text-muted-foreground ml-1">
                ({product.reviewCount})
              </span>
            )}
          </div>

          {/* ── View details CTA button (full-width, forest green) ─────── */}
          <div className="mt-auto pt-1">
            <span
              className={
                "flex items-center justify-between w-full px-5 py-3 rounded-full text-white font-semibold text-sm transition-colors " +
                (hasListings
                  ? "bg-emerald-700 group-hover:bg-emerald-800"
                  : "bg-muted-foreground/30 group-hover:bg-muted-foreground/40")
              }
            >
              <span>View details</span>
              <ChevronRight className="h-4 w-4" />
            </span>
          </div>
        </div>
      </article>
    </Link>
  );
}

export const ProductCard = memo(ProductCardInner);
