import { memo } from "react";
import { Link } from "wouter";
import { Star, ArrowRight, Users } from "lucide-react";
import { type Product } from "@workspace/api-client-react";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";

/**
 * CategoryProductCard — the vertical product card used on /category/:slug pages.
 *
 * Design (matches the user's approved mockup):
 *   ┌──────────────────────┐
 *   │     [grayscale]      │
 *   │    ┌──────────────┐  │  ← "N sellers" badge, centered at top of image
 *   │    │ 👤 N sellers │  │     (white pill, green icon, backdrop-blur)
 *   │    └──────────────┘  │
 *   ├──────────────────────┤
 *   │  Product Name        │  ← bold, line-clamp-2
 *   │  ★ ★ ★ ★ ★          │  ← 5 stars (accent fill when rated, gray when 0)
 *   │  ┌─────────────────┐ │
 *   │  │ View details  → │ │  ← full-width green button, text never truncates
 *   │  └─────────────────┘ │
 *   └──────────────────────┘
 *
 * What was removed vs the old ProductCard (to match the approved design):
 *   - No price text (the green button IS the CTA — price lives on the detail page)
 *   - No wishlist heart (detail page has it; this card is a discovery surface)
 *   - No compare button (same reason)
 *   - No "Currently Unavailable" text badge (replaced by the seller-count badge —
 *     when count is 0, the image goes grayscale + opacity-60 to signal unavailable)
 *
 * The card is a <Link> wrapping the whole <article>, so clicking anywhere
 * navigates to /products/:id. The green "View details" button is visual only
 * (it's inside the link, so clicking it also navigates — no separate handler).
 */

function CategoryProductCardInner({
  product,
  backContext,
  priority = false,
}: {
  product: Product;
  backContext?: string;
  priority?: boolean;
}) {
  const sellerCount = product.listingCount;
  const hasListings = sellerCount > 0 && product.listingMinPrice != null;

  // Cloudinary-optimise the image: 400px square, webp, quality 75. Matches
  // the transform used by the regular ProductCard.
  const rawImg = product.images[0] || null;
  const img =
    rawImg && rawImg.includes("res.cloudinary.com")
      ? rawImg.replace("/upload/", "/upload/w_400,h_400,c_fill,f_webp,q_75/")
      : rawImg;

  const href = backContext
    ? "/products/" + product.id + "?from=" + encodeURIComponent(backContext)
    : "/products/" + product.id;

  return (
    <Link href={href}>
      <article
        className="group bg-card border border-border rounded-2xl overflow-hidden transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5 cursor-pointer flex flex-col h-full"
        aria-label={product.name}
      >
        {/* ─── Image ──────────────────────────────────────────────────────
            Square aspect ratio. When no sellers are available, the image
            goes grayscale + opacity-60 to visually signal "unavailable"
            (matches the approved design). The seller-count badge sits
            centered at the TOP of the image. */}
        <div className="relative aspect-square overflow-hidden bg-muted/30">
          {img ? (
            <img
              src={img}
              alt={product.name}
              className={
                "w-full h-full object-cover transition-transform duration-500 group-hover:scale-105 " +
                (!hasListings ? "opacity-60 grayscale" : "")
              }
              loading={priority ? "eager" : "lazy"}
              decoding="async"
              width="400"
              height="400"
            />
          ) : (
            <NoImagePlaceholder />
          )}

          {/* ─── Seller-count badge ──────────────────────────────────────
              Centered horizontally at the top of the image. White pill
              with backdrop-blur so it's readable over any image. Green
              Users icon + "N seller(s)" text. Grammar: "1 seller" vs
              "N sellers" (0 uses plural, matching standard English). */}
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10">
            <span className="inline-flex items-center gap-1.5 bg-background/95 backdrop-blur-sm text-foreground text-[11px] font-medium px-2.5 py-1 rounded-full shadow-sm whitespace-nowrap">
              <Users className="w-3 h-3 text-accent shrink-0" />
              {sellerCount} seller{sellerCount !== 1 ? "s" : ""}
            </span>
          </div>
        </div>

        {/* ─── Info area ─────────────────────────────────────────────────
            Name + 5-star rating + full-width green "View details" button.
            No price, no wishlist, no compare — the button IS the CTA. */}
        <div className="p-4 flex flex-col flex-1 gap-3">
          {/* Product name — bold, line-clamp-2 so long names don't blow
              up the card height. flex-1 pushes the button to the bottom
              so all cards in a row have aligned buttons. */}
          <h3 className="font-medium text-sm leading-snug line-clamp-2 flex-1">
            {product.name}
          </h3>

          {/* 5-star rating — accent-colored fill for rated products,
              gray outline when averageRating is 0 (no reviews yet). */}
          <div className="flex items-center gap-0.5" aria-label={`Rating: ${product.averageRating} out of 5`}>
            {Array.from({ length: 5 }).map((_, i) => (
              <Star
                key={i}
                className={
                  "h-3.5 w-3.5 " +
                  (i < Math.round(product.averageRating)
                    ? "fill-accent text-accent"
                    : "text-muted-foreground/40")
                }
                aria-hidden="true"
              />
            ))}
          </div>

          {/* ─── Full-width "View details" button ───────────────────────
              Green background, white text, right arrow icon. Uses
              whitespace-nowrap + flex-shrink-0 so the text NEVER
              truncates (the bug the user reported: "View d..." was
              cut off). The button is visual only — it sits inside the
              wrapping <Link>, so clicking it navigates to the product
              detail page. No separate onClick handler needed. */}
          <span className="w-full inline-flex items-center justify-center gap-1.5 bg-primary text-primary-foreground text-xs font-semibold px-3 py-2.5 rounded-xl whitespace-nowrap transition-colors group-hover:bg-accent">
            View details
            <ArrowRight className="w-3.5 h-3.5 flex-shrink-0" />
          </span>
        </div>
      </article>
    </Link>
  );
}

export const CategoryProductCard = memo(CategoryProductCardInner);
