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
        className="group block bg-card border border-border rounded-[20px] p-4 sm:p-5 shadow-[0_4px_20px_rgba(0,0,0,0.08)] hover:shadow-lg transition-shadow cursor-pointer"
        aria-label={product.name}
      >
        {/* Header: image + info + favorite (favorite is absolutely positioned) */}
        <div className="flex gap-3.5 items-start relative">
          {/* Image */}
          <div className="shrink-0 h-[72px] w-[72px] sm:h-[88px] sm:w-[88px] rounded-xl overflow-hidden bg-muted/30">
            {img ? (
              <img
                src={img}
                alt={product.name}
                className="w-full h-full object-cover"
                loading={priority ? "eager" : "lazy"}
                decoding="async"
                width={144}
                height={144}
              />
            ) : (
              <NoImagePlaceholder />
            )}
          </div>

          {/* Info: title + subtitle + meta (tag + rating on same row) */}
          {/* pr-7 reserves space so the absolute-positioned favorite button
              never overlaps the title text on narrow cards. */}
          <div className="flex-1 min-w-0 pr-7 flex flex-col">
            <h3 className="text-[17px] sm:text-[19px] font-bold leading-tight text-foreground break-words mb-1">
              {product.name}
            </h3>
            {product.scientificName && (
              <p className="text-xs italic text-muted-foreground truncate mb-2">
                {product.scientificName}
              </p>
            )}

            {/* Tag + rating on a single row (previously stacked) */}
            <div className="flex items-center gap-2.5 flex-wrap">
              {categoryName && (
                <span className="inline-flex items-center gap-1.5 bg-emerald-50 text-emerald-700 px-2.5 py-[5px] rounded-full text-[11px] font-semibold leading-none whitespace-nowrap">
                  <img src={CATEGORY_ICON} alt="" aria-hidden="true" className="h-3.5 w-3.5" />
                  {categoryName}
                </span>
              )}

              <span
                className="inline-flex items-center gap-[3px] text-xs text-muted-foreground whitespace-nowrap"
                aria-label={`Rating ${product.averageRating} out of 5${product.reviewCount ? ` based on ${product.reviewCount} reviews` : ""}`}
              >
                <svg viewBox="0 0 24 24" className="h-3 w-3 fill-amber-500" aria-hidden="true">
                  <path d="M12 17.3l-6.2 3.7 1.6-7L2 9.3l7.2-.6L12 2l2.8 6.7 7.2.6-5.4 4.7 1.6 7z" />
                </svg>
                <strong className="font-bold text-foreground">{product.averageRating.toFixed(1)}</strong>
                {product.reviewCount > 0 && (
                  <span>({product.reviewCount})</span>
                )}
              </span>
            </div>
          </div>

          {/* Favorite button — absolute top-right of the header */}
          <button
            onClick={handleWishlist}
            className="absolute top-0 right-0 h-8 w-8 rounded-full bg-background border border-border flex items-center justify-center transition-colors hover:bg-muted/30"
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
        </div>

        {/* Description */}
        {product.description && (
          <p className="mt-3.5 text-[13px] leading-[1.55] text-muted-foreground line-clamp-2">
            {product.description}
          </p>
        )}

        {/* Footer: growth | care | view-details, with vertical dividers
            between adjacent items. Items are conditional — the divider is
            only added when a previous item exists, so we never get a
            leading divider or two dividers in a row. */}
        <div className="mt-3.5 flex items-center border-t border-border pt-3">
          {growth && (
            <div className="flex-1 flex items-center gap-1.5 text-[11px] font-semibold text-foreground leading-tight min-w-0">
              <img src={GROWTH_ICON} alt="" aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span className="truncate">{growth}</span>
            </div>
          )}

          {care && (
            <div className={"flex-1 flex items-center gap-1.5 text-[11px] font-semibold text-foreground leading-tight min-w-0 " + (growth ? "border-l border-border pl-3" : "")}>
              <img src={CARE_ICON} alt="" aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span className="truncate">{care}</span>
            </div>
          )}

          <span
            className={"flex items-center gap-1 text-[11px] font-semibold text-muted-foreground whitespace-nowrap " + ((growth || care) ? "border-l border-border pl-3" : "")}
          >
            <span className="whitespace-nowrap group-hover:text-foreground transition-colors">View details</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 shrink-0" aria-hidden="true">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        </div>
      </article>
    </Link>
  );
}

export const HomepageProductCard = memo(HomepageProductCardInner);
