import { memo } from "react";
import { Link } from "wouter";
import { Star, Users, ArrowRight } from "lucide-react";
import { type Product } from "@workspace/api-client-react";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";

/**
 * ProductCard — redesigned to match the user's HTML reference (2026-08-06).
 *
 * Visual spec:
 *  - Card: white bg, 12px radius, no border, soft shadow.
 *  - Image: square (1:1), always grayscale + contrast-105.
 *  - Badge (top-right): white pill, dark green text #2d5016, Users icon
 *    (filled), "Available seller {count}".
 *  - Content: 10px padding.
 *  - Title: 13px, font-semibold, #111, tight letter-spacing.
 *  - Stars: 5 × 11px outline stars, amber when filled, gray when empty.
 *    No review count text.
 *  - Button: full-width, bg #2d5016, white text, 10px font, 6px radius,
 *    6px×10px padding, "View details →".
 *
 * The whole card is wrapped in a <Link> to the product detail page, so the
 * "View details" button is a visual affordance — clicking anywhere navigates.
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
  const rawImg = product.images[0] || null;
  const img = rawImg && rawImg.includes("res.cloudinary.com")
    ? rawImg.replace("/upload/", "/upload/w_400,h_400,c_fill,f_webp,q_75/")
    : rawImg;
  const href = backContext
    ? "/products/" + product.id + "?from=" + encodeURIComponent(backContext)
    : "/products/" + product.id;

  const sellerCount = product.listingCount ?? 0;
  const roundedRating = Math.round(product.averageRating);

  return (
    <Link href={href}>
      <article
        className="group bg-white rounded-xl overflow-hidden shadow-[0_4px_15px_rgba(0,0,0,0.08)] hover:shadow-[0_6px_20px_rgba(0,0,0,0.12)] transition-shadow duration-200 cursor-pointer flex flex-col h-full"
        aria-label={product.name}
      >
        {/* ── Image area ─────────────────────────────────────────── */}
        <div className="relative aspect-square bg-[#f0f0f0] overflow-hidden">
          {img ? (
            <img
              src={img}
              alt={product.name}
              className="w-full h-full object-cover grayscale contrast-105 group-hover:scale-105 transition-transform duration-500"
              loading={priority ? "eager" : "lazy"}
              decoding="async"
              width="400"
              height="400"
            />
          ) : (
            <NoImagePlaceholder />
          )}
          {/* Badge — always visible, top-right */}
          <div className="absolute top-2 right-2 flex items-center gap-[5px] bg-white rounded-full px-2.5 py-1.5 shadow-[0_2px_8px_rgba(0,0,0,0.15)]">
            <Users className="w-[13px] h-[13px] fill-[#2d5016]" strokeWidth={0} />
            <span className="text-[10px] font-semibold leading-none text-[#2d5016]">
              Available seller {sellerCount}
            </span>
          </div>
        </div>

        {/* ── Content area ──────────────────────────────────────── */}
        <div className="p-2.5 flex flex-col flex-1">
          <h3 className="text-[13px] font-semibold text-[#111] tracking-[-0.01em] mb-1 line-clamp-2 leading-snug">
            {product.name}
          </h3>
          <div className="flex gap-px mb-2.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star
                key={i}
                className={
                  "w-[11px] h-[11px] " +
                  (i < roundedRating ? "fill-amber-400 text-amber-400" : "text-[#d1d5db]")
                }
                strokeWidth={2}
                aria-hidden="true"
              />
            ))}
          </div>
          {/* View details CTA — visual affordance (whole card is a link) */}
          <div
            className="mt-auto w-full flex items-center justify-center gap-1 bg-[#2d5016] group-hover:bg-[#1f3a0f] text-white text-[10px] font-semibold py-1.5 px-2.5 rounded-md transition-colors duration-200"
            aria-hidden="true"
          >
            View details
            <ArrowRight className="w-[11px] h-[11px]" strokeWidth={2.5} />
          </div>
        </div>
      </article>
    </Link>
  );
}

export const ProductCard = memo(ProductCardInner);
