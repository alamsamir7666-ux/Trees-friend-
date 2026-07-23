import { memo } from "react";
import { Link } from "wouter";
import { Heart, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { type Product } from "@workspace/api-client-react";
import { useComparison } from "@/components/ui/ProductComparison";
import { useWishlist } from "@/contexts/WishlistContext";
import { BarChart2 } from "lucide-react";

const FALLBACK_IMG =
  "https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=400&q=80&fm=webp";

/**
 * Phase 3b Part 5: this card is a browse/discovery surface, not a purchase
 * surface anymore -- Add to Bag and Pre-Order Now are both gone. Neither
 * concept applies at the PRODUCT level in the marketplace model: buying
 * requires picking one seller's listing and (often) one variant of that
 * listing, and this card doesn't know which seller the shopper wants. That
 * choice happens on the product detail page's seller cards
 * (SellerListingsSection.tsx) or the listing detail page
 * (SellerListingDetailPage.tsx), both one click away via this card's
 * existing product-detail link. Wishlist and compare stay -- both are
 * genuinely product-level actions (you wishlist "a Money Plant", not "a
 * Money Plant from this one seller"), so they're unaffected by the
 * marketplace migration.
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

  // There is no single "the" price on a product anymore -- each seller's
  // listing variant has its own. listingMinPrice/listingMaxPrice are
  // computed server-side across all of the product's approved, public,
  // in-stock listing variants (see PHASE3A_HANDOFF.md). Both null means no
  // seller currently has this product listed with any in-stock variant.
  const hasListings = product.listingCount > 0 && product.listingMinPrice != null;
  const priceRange = hasListings && product.listingMinPrice !== product.listingMaxPrice;

  function handleWishlist(e: React.MouseEvent) {
    e.preventDefault();
    toggleWishlist({
      productId: product.id,
      name: product.name,
      slug: product.slug,
      price: product.listingMinPrice ?? 0,
      discountPrice: null,
      image: product.images?.[0] || "",
    });
  }

  const rawImg = product.images[0] || FALLBACK_IMG;
  const img = rawImg.includes("res.cloudinary.com")
    ? rawImg.replace("/upload/", "/upload/w_400,h_400,c_fill,f_webp,q_75/")
    : rawImg;
  const href = backContext
    ? "/products/" + product.id + "?from=" + encodeURIComponent(backContext)
    : "/products/" + product.id;

  return (
    <Link href={href}>
      <article
        className="group relative bg-card border border-border rounded-2xl overflow-hidden transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5 cursor-pointer flex flex-col h-full"
        aria-label={product.name + (hasListings ? " - from Tk" + product.listingMinPrice!.toLocaleString() : "")}
      >
        <div className="relative aspect-square overflow-hidden bg-muted/30">
          <img
            src={img}
            alt={product.name}
            className={"w-full h-full object-cover transition-transform duration-500 group-hover:scale-105 " + (!hasListings ? "opacity-60 grayscale" : "")}
            loading={priority ? "eager" : "lazy"}
            decoding="async"
            width="400"
            height="400"
          />
          <div className="absolute top-3 left-3 flex flex-col gap-1">
            {!hasListings && (
              <Badge className="bg-gray-500 text-white text-xs font-medium shadow-sm">
                Currently Unavailable
              </Badge>
            )}
          </div>
          <button
            onClick={(e) => { e.preventDefault(); inCompare ? removeFromCompare(product.id) : addToCompare(product.id); }}
            className={"absolute bottom-3 left-3 p-2 rounded-full bg-background/85 backdrop-blur-sm shadow-sm transition-all duration-200 hover:scale-110 " + (inCompare ? "text-accent opacity-100" : "text-muted-foreground opacity-0 group-hover:opacity-100")}
            aria-label={inCompare ? "Remove from comparison" : "Add to comparison"}
          >
            <BarChart2 className={"h-4 w-4 " + (inCompare ? "fill-current" : "")} />
          </button>
          <button
            onClick={handleWishlist}
            className={"absolute top-3 right-3 p-2 rounded-full bg-background/85 backdrop-blur-sm shadow-sm transition-all duration-200 hover:scale-110 " + (isWishlisted ? "text-rose-500 opacity-100" : "text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-rose-500")}
            aria-label={isWishlisted ? "Remove from wishlist" : "Add to wishlist"}
          >
            <Heart className={"h-4 w-4 " + (isWishlisted ? "fill-current" : "")} />
          </button>
        </div>
        <div className="p-4 flex flex-col flex-1 gap-2">
          <h3 className="font-medium text-sm leading-snug line-clamp-2 flex-1">
            {product.name}
          </h3>
          <div className="flex items-center gap-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star
                key={i}
                className={"h-3 w-3 " + (i < Math.round(product.averageRating) ? "fill-accent text-accent" : "text-muted")}
                aria-hidden="true"
              />
            ))}
            {product.reviewCount > 0 && (
              <span className="text-xs text-muted-foreground ml-1">
                ({product.reviewCount})
              </span>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-sm">
              {hasListings ? (
                priceRange
                  ? <>{"Tk"}{product.listingMinPrice!.toLocaleString()}{" – Tk"}{product.listingMaxPrice!.toLocaleString()}</>
                  : <>{"Tk"}{product.listingMinPrice!.toLocaleString()}</>
              ) : (
                <span className="text-muted-foreground font-normal">Not currently available</span>
              )}
            </span>
          </div>
        </div>
      </article>
    </Link>
  );
}

export const ProductCard = memo(ProductCardInner);
