import { memo } from "react";
import { Link } from "wouter";
import { type Product } from "@workspace/api-client-react";
import { useWishlist } from "@/contexts/WishlistContext";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";

// Same custom icon set used in the original design mockup (Cloudinary-hosted
// SVGs), kept as-is rather than swapped for a generic icon library so the
// homepage card matches the approved design pixel-for-pixel.
const CATEGORY_ICON =
  "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1784963644/cropped-8e9b0a45-dd2d-4fad-9149-ee5858cbc4ca_zskxxe_au7ckt.svg";
const GROWTH_ICON =
  "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1784964251/cropped-b6b31dd8-4e2a-4059-8e56-444eaa70c710_kq2ffi.svg";
const CARE_ICON =
  "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1784964252/cropped-8a860daf-2b7c-47df-bbb7-32935c65b173_f388pi.svg";

// products.growthRate comes from a fixed dropdown in the admin form
// ("slow" | "moderate" | "fast"), stored lowercase.
function growthLabel(rate?: string | null): string | null {
  if (!rate) return null;
  return rate.charAt(0).toUpperCase() + rate.slice(1) + " Growth";
}

// Unlike growthRate, `watering` is free text in the admin form (e.g.
// "medium", "water twice a week") -- there's no fixed set of values to map
// against, so classifying it into "Easy Care"/"Moderate Care" would silently
// drop anything that isn't an exact "low"/"moderate"/"high" match (as
// happened with "medium"). Simplest correct fix: recognize the common
// low/moderate/high family case-insensitively, and otherwise just show
// whatever the admin typed, title-cased, rather than hiding it.
function careLabel(watering?: string | null): string | null {
  if (!watering) return null;
  const w = watering.trim().toLowerCase();
  if (w === "low") return "Easy Care";
  if (w === "moderate" || w === "medium") return "Moderate Care";
  if (w === "high") return "High Maintenance";
  return watering.charAt(0).toUpperCase() + watering.slice(1);
}

/**
 * Compact horizontal product card used only on the homepage ("Trending / New
 * Arrivals" and "Based on Category" sections), matching the approved compact
 * design mockup: small square image on the left, title/subtitle/meta stacked
 * on the right, tag + rating inline, favorite button absolute top-right,
 * description below, footer with growth | care | view-details columns
 * divided by vertical dividers.
 *
 * The grid/browse/wishlist/compare pages keep using ProductCard.tsx -- this
 * is a deliberately separate component rather than a variant prop on
 * ProductCard, since the two layouts share almost no markup.
 */
function HomepageProductCardInner({
  product,
  categoryName,
  backContext,
  priority = false,
}: {
  product: Product;
  categoryName?: string;
  backContext?: string;
  priority?: boolean;
}) {
  const { isWishlisted: isWishlistedFn, toggle: toggleWishlist } = useWishlist();
  const isWishlisted = isWishlistedFn(product.id);

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
  // Smaller Cloudinary transform than the previous wide-card layout
  // (w_200 instead of w_600) — the new compact card displays the image at
  // 72–88px, so 200px is plenty for 2–3x retina sharpness and saves
  // meaningful bandwidth on the homepage's many cards.
  const img = rawImg && rawImg.includes("res.cloudinary.com")
    ? rawImg.replace("/upload/", "/upload/w_200,h_200,c_fill,f_webp,q_75/")
    : rawImg;
  const href = backContext
    ? "/products/" + product.id + "?from=" + encodeURIComponent(backContext)
    : "/products/" + product.id;

  const growth = growthLabel(product.growthRate);
  const care = careLabel(product.watering);

  return (
    <Link href={href}>
      <article
        className="group block bg-card border border-border rounded-2xl overflow-hidden shadow-sm hover:shadow-lg md:hover:-translate-y-1 lg:hover:shadow-xl lg:hover:-translate-y-1.5 transition-all duration-300 cursor-pointer"
        aria-label={product.name}
      >
        {/* Image */}
        <div className="relative aspect-[4/3] lg:aspect-[3/2] overflow-hidden bg-muted/30">
          {img ? (
            <img
              src={rawImg && rawImg.includes("res.cloudinary.com")
                ? rawImg.replace("/upload/", "/upload/w_400,h_300,c_fill,f_webp,q_75/")
                : rawImg}
              alt={product.name}
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
              loading={priority ? "eager" : "lazy"}
              decoding="async"
              width={400}
              height={300}
            />
          ) : (
            <NoImagePlaceholder />
          )}
          {/* Favorite button */}
          <button
            onClick={handleWishlist}
            className="absolute top-2.5 right-2.5 lg:top-3 lg:right-3 h-8 w-8 lg:h-9 lg:w-9 rounded-full bg-background/85 backdrop-blur-sm border border-border flex items-center justify-center transition-all hover:scale-110"
            aria-label={isWishlisted ? "Remove from wishlist" : "Add to wishlist"}
          >
            <svg
              viewBox="0 0 24 24"
              className={"h-4 w-4 " + (isWishlisted ? "fill-rose-500 stroke-rose-500" : "fill-none stroke-muted-foreground")}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 1 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
            </svg>
          </button>
          {/* Category badge */}
          {categoryName && (
            <span className="absolute bottom-2.5 left-2.5 lg:bottom-3 lg:left-3 inline-flex items-center gap-1.5 bg-success text-success-foreground px-2.5 py-1 lg:px-3 lg:py-1.5 rounded-full text-[10px] lg:text-xs font-semibold leading-none shadow-sm">
              <img src={CATEGORY_ICON} alt="" aria-hidden="true" className="h-3 w-3 shrink-0" />
              <span className="truncate max-w-[80px]">{categoryName}</span>
            </span>
          )}
        </div>

        {/* Content */}
        <div className="p-3.5 sm:p-4 lg:p-5">
          <h3 className="text-sm lg:text-base font-semibold leading-snug text-foreground line-clamp-1 mb-1 lg:mb-1.5">
            {product.name}
          </h3>
          {product.scientificName && (
            <p className="text-xs lg:text-sm italic text-muted-foreground truncate mb-1.5">
              {product.scientificName}
            </p>
          )}

          {/* Rating + Price row */}
          <div className="flex items-center justify-between gap-2 mb-2 lg:mb-3">
            <span
              className="inline-flex items-center gap-1 text-xs lg:text-sm text-muted-foreground"
              aria-label={`Rating ${product.averageRating} out of 5${product.reviewCount ? ` based on ${product.reviewCount} reviews` : ""}`}
            >
              <svg viewBox="0 0 24 24" className="h-3 w-3 lg:h-3.5 lg:w-3.5 fill-amber-500" aria-hidden="true">
                <path d="M12 17.3l-6.2 3.7 1.6-7L2 9.3l7.2-.6L12 2l2.8 6.7 7.2.6-5.4 4.7 1.6 7z" />
              </svg>
              <strong className="font-bold text-foreground">{product.averageRating.toFixed(1)}</strong>
              {product.reviewCount > 0 && (
                <span>({product.reviewCount})</span>
              )}
            </span>
            {product.listingMinPrice != null && product.listingCount > 0 && (
              <span className="text-sm lg:text-base font-semibold lg:font-bold text-foreground">
                {"Tk"}{product.listingMinPrice!.toLocaleString()}
                {product.listingMaxPrice !== product.listingMinPrice && <span>+</span>}
              </span>
            )}
          </div>

          {/* Footer: growth | care */}
          {(growth || care) && (
            <div className="flex items-center border-t border-border pt-2.5 lg:pt-3 gap-2 lg:gap-3">
              {growth && (
                <div className="flex items-center gap-1 text-[11px] lg:text-xs font-medium text-muted-foreground leading-tight min-w-0">
                  <img src={GROWTH_ICON} alt="" aria-hidden="true" className="h-3.5 w-3.5 lg:h-4 lg:w-4 shrink-0" />
                  <span className="truncate">{growth}</span>
                </div>
              )}
              {care && (
                <div className={"flex items-center gap-1 text-[11px] lg:text-xs font-medium text-muted-foreground leading-tight min-w-0 " + (growth ? "border-l border-border pl-2 lg:pl-3" : "")}>
                  <img src={CARE_ICON} alt="" aria-hidden="true" className="h-3.5 w-3.5 lg:h-4 lg:w-4 shrink-0" />
                  <span className="truncate">{care}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </article>
    </Link>
  );
}

export const HomepageProductCard = memo(HomepageProductCardInner);
