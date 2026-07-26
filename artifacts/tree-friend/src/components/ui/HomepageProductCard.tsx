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
 * Wide horizontal product card used only on the homepage ("Trending / New
 * Arrivals" and "Based on Category" sections), matching the approved design
 * mockup. The grid/browse/wishlist/compare pages keep using ProductCard.tsx
 * -- this is a deliberately separate component rather than a variant prop on
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
  const img = rawImg && rawImg.includes("res.cloudinary.com")
    ? rawImg.replace("/upload/", "/upload/w_600,h_600,c_fill,f_webp,q_75/")
    : rawImg;
  const href = backContext
    ? "/products/" + product.id + "?from=" + encodeURIComponent(backContext)
    : "/products/" + product.id;

  const growth = growthLabel(product.growthRate);
  const care = careLabel(product.watering);

  return (
    <Link href={href}>
      <article
        className="group bg-card border border-border rounded-[24px] p-5 sm:p-7 flex flex-col gap-4 sm:gap-6 shadow-[0_20px_48px_-12px_rgba(0,0,0,0.08),0_4px_12px_-4px_rgba(0,0,0,0.04)] hover:shadow-lg transition-shadow cursor-pointer"
        aria-label={product.name}
      >
        {/* Top: image + content */}
        <div className="flex gap-4 sm:gap-7 items-start">
          <div className="shrink-0 w-[110px] sm:w-[180px]">
            <div className="w-full aspect-square rounded-[clamp(12px,3vw,20px)] overflow-hidden bg-muted/30">
              {img ? (
                <img
                  src={img}
                  alt={product.name}
                  className="w-full h-full object-cover"
                  loading={priority ? "eager" : "lazy"}
                  decoding="async"
                  width="400"
                  height="400"
                />
              ) : (
                <NoImagePlaceholder />
              )}
            </div>
          </div>

          <div className="flex-1 min-w-0 flex flex-col gap-1.5 pt-0.5">
            <div className="flex justify-between items-start gap-3">
              <h3 className="text-[22px] sm:text-[28px] font-bold text-foreground leading-tight tracking-tight break-words">
                {product.name}
              </h3>
              <button
                onClick={handleWishlist}
                className="shrink-0 -mt-1 h-9 w-9 sm:h-11 sm:w-11 rounded-full bg-background border border-border shadow-sm flex items-center justify-center transition-transform hover:scale-105"
                aria-label={isWishlisted ? "Remove from wishlist" : "Add to wishlist"}
              >
                <svg
                  viewBox="0 0 24 24"
                  className={"h-4 w-4 sm:h-5 sm:w-5 " + (isWishlisted ? "fill-rose-500 stroke-rose-500" : "fill-none stroke-primary")}
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                </svg>
              </button>
            </div>

            {product.scientificName && (
              <p className="text-[13px] sm:text-base italic text-muted-foreground">
                {product.scientificName}
              </p>
            )}

            <div className="flex items-center gap-2.5 sm:gap-5 flex-wrap pt-1.5">
              {categoryName && (
                <span className="inline-flex items-center gap-1.5 bg-primary/10 text-primary px-2.5 sm:px-4 py-1.5 rounded-full text-xs sm:text-sm font-medium whitespace-nowrap">
                  <img src={CATEGORY_ICON} alt="" aria-hidden="true" className="h-[18px] w-[18px] sm:h-[22px] sm:w-[22px]" />
                  {categoryName}
                </span>
              )}

              <span className="inline-flex items-center gap-1.5 text-sm sm:text-base whitespace-nowrap" aria-label={`Rating ${product.averageRating} out of 5${product.reviewCount ? ` based on ${product.reviewCount} reviews` : ""}`}>
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 sm:h-[18px] sm:w-[18px] fill-[#FABB05]" aria-hidden="true">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                <span className="font-bold text-foreground">{product.averageRating.toFixed(1)}</span>
                {product.reviewCount > 0 && (
                  <span className="text-muted-foreground font-medium">({product.reviewCount})</span>
                )}
              </span>
            </div>
          </div>
        </div>

        {/* Description */}
        {product.description && (
          <p className="text-[13px] sm:text-base leading-relaxed text-muted-foreground line-clamp-2">
            {product.description}
          </p>
        )}

        <hr className="border-border" />

        {/* Footer */}
        <div className="flex items-start justify-between gap-2">
          {growth && (
            <div className="flex items-start gap-1.5 sm:gap-3 flex-1 min-w-0">
              <img src={GROWTH_ICON} alt="" aria-hidden="true" className="h-[18px] w-[18px] sm:h-[22px] sm:w-[22px] shrink-0 mt-0.5" />
              <span className="text-xs sm:text-[15.5px] font-medium text-foreground leading-snug">{growth}</span>
            </div>
          )}

          {growth && care && <div className="w-px self-stretch bg-border shrink-0 mx-1 sm:mx-2" aria-hidden="true" />}

          {care && (
            <div className="flex items-start gap-1.5 sm:gap-3 flex-1 min-w-0">
              <img src={CARE_ICON} alt="" aria-hidden="true" className="h-[18px] w-[18px] sm:h-[22px] sm:w-[22px] shrink-0 mt-0.5" />
              <span className="text-xs sm:text-[15.5px] font-medium text-foreground leading-snug">{care}</span>
            </div>
          )}

          {(growth || care) && <div className="w-px self-stretch bg-border shrink-0 mx-1 sm:mx-2" aria-hidden="true" />}

          <span className="flex items-start justify-end gap-1 flex-1 min-w-0 text-primary font-semibold text-xs sm:text-[15.5px] group-hover:opacity-80 transition-opacity">
            <span className="whitespace-nowrap">View details</span>
            <svg viewBox="0 0 24 24" className="h-4 w-4 sm:h-[18px] sm:w-[18px] stroke-primary fill-none shrink-0 mt-0.5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </span>
        </div>
      </article>
    </Link>
  );
}

export const HomepageProductCard = memo(HomepageProductCardInner);
