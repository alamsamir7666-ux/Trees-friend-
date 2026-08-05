import { memo } from "react";
import { Link } from "wouter";
import { Heart, Star, Users, ArrowRight, BarChart2 } from "lucide-react";
import { type Product } from "@workspace/api-client-react";
import { useComparison } from "@/components/ui/ProductComparison";
import { useWishlist } from "@/contexts/WishlistContext";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";

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
 *
 * Card visual (per 2026-08-06 redesign):
 *  - Image with "Available seller" pill badge top-right (white bg, dark
 *    green text #2d5016, Users icon + count) when hasListings.
 *  - Title (line-clamp-2).
 *  - Star rating (5 stars + review count).
 *  - Full-width dark-green "View details ->" button (CTA).
 *  - The old "Currently Unavailable" badge and "Not currently available"
 *    price-row text are both removed.
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

  const rawImg = product.images[0] || null;
  const img = rawImg && rawImg.includes("res.cloudinary.com")
    ? rawImg.replace("/upload/", "/upload/w_400,h_400,c_fill,f_webp,q_75/")
    : rawImg;
  const href = backContext
    ? "/products/" + product.id + "?from=" + encodeURIComponent(backContext)
    : "/products/" + product.id;

  return (
    <Link href={href}>
      <article
        className="group relative bg-card border border-border rounded-2xl overflow-hidden transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5 cursor-pointer flex flex-col h-full"
        aria-label={product.name + (hasListings ? ` - ${product.listingCount} seller${product.listingCount > 1 ? "s" : ""}` : "")}
      >
        <div className="relative aspect-square overflow-hidden bg-muted/30">
          {img ? (
            <img
              src={img}
              alt={product.name}
              className={"w-full h-full object-cover transition-transform duration-500 group-hover:scale-105 " + (!hasListings ? "opacity-60 grayscale" : "")}
              loading={priority ? "eager" : "lazy"}
              decoding="async"
              width="400"
              height="400"
            />
          ) : (
            <NoImagePlaceholder />
          )}
          {/* "Available seller" pill badge -- top-right, white bg, dark green text */}
          {hasListings && (
            <div
              className="absolute top-3 right-3 flex items-center gap-1 bg-white shadow-sm rounded-full px-2.5 py-1 text-[#2d5016]"
            >
              <Users className="h-3 w-3" />
              <span className="text-xs font-semibold leading-none">
                {product.listingCount} seller{product.listingCount > 1 ? "s" : ""}
              </span>
            </div>
          )}
          <button
            onClick={(e) => { e.preventDefault(); inCompare ? removeFromCompare(product.id) : addToCompare(product.id); }}
            className={"absolute bottom-3 left-3 p-2 rounded-full bg-background/85 backdrop-blur-sm shadow-sm transition-all duration-200 hover:scale-110 " + (inCompare ? "text-accent opacity-100" : "text-muted-foreground opacity-0 group-hover:opacity-100")}
            aria-label={inCompare ? "Remove from comparison" : "Add to comparison"}
          >
            <BarChart2 className={"h-4 w-4 " + (inCompare ? "fill-current" : "")} />
          </button>
          <button
            onClick={handleWishlist}
            className={"absolute bottom-3 right-3 p-2 rounded-full bg-background/85 backdrop-blur-sm shadow-sm transition-all duration-200 hover:scale-110 " + (isWishlisted ? "text-destructive opacity-100" : "text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive")}
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
          {/* Full-width dark-green "View details" CTA — the whole card is a link,
              so this is a visual affordance, not a separate action. */}
          <div
            className="w-full flex items-center justify-center gap-1.5 text-white text-sm font-medium py-2.5 px-4 rounded-3xl bg-[#2d5016]"
            aria-hidden="true"
          >
            View details
            <ArrowRight className="h-4 w-4" />
          </div>
        </div>
      </article>
    </Link>
  );
}

export const ProductCard = memo(ProductCardInner);
