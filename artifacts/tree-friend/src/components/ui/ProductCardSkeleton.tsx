import { memo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Skeleton component library for the homepage.
 *
 * Every skeleton here is a 1:1 structural mirror of a real homepage
 * component — same height, same grid, same gap, same border radius. This
 * is critical for CLS (Cumulative Layout Shift): when real content swaps
 * in, the page doesn't reflow. The user just sees the gray blocks turn
 * into images and text.
 *
 * Conventions:
 *  - All skeletons use the shimmer effect (defined in index.css) by way
 *    of the upgraded <Skeleton> primitive.
 *  - Grid skeletons use `skeleton-stagger` so cards fade in with a 60ms
 *    delay per index — gives a sense of progressive rendering.
 *  - All skeletons are memoized so a parent re-render doesn't re-paint
 *    every skeleton in a grid.
 *  - Decorative `aria-hidden="true"` so screen readers skip the
 *    placeholder; the loading region itself should be labelled by the
 *    parent (e.g. <section aria-busy="true" aria-label="Loading…">).
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Vertical product card skeleton — matches `ProductCard.tsx` (the 4-col
 * grid card used in the "Best Plants & Trees by Category" section):
 * square image, title, 5 stars, full-width CTA button.
 */
export const ProductCardSkeleton = memo(function ProductCardSkeleton() {
  return (
    <div
      className="bg-white rounded-xl overflow-hidden shadow-[0_4px_15px_rgba(0,0,0,0.08)] flex flex-col h-full"
      aria-hidden="true"
    >
      <Skeleton className="aspect-square w-full rounded-none" />
      <div className="p-2.5 flex flex-col flex-1 gap-1.5">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-4/5" />
        <div className="flex gap-px mt-0.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} variant="pulse" className="h-[11px] w-[11px] rounded-sm" />
          ))}
        </div>
        <Skeleton className="mt-auto h-6 w-full rounded-md" />
      </div>
    </div>
  );
});

/**
 * Horizontal product card skeleton — matches `HomepageProductCard.tsx`
 * (the 2-col card used in the "Trending / New Arrivals" section):
 * small square image left, title + subtitle + tag + rating right,
 * favorite button absolute top-right, 2-line description below,
 * 3-column footer (growth | care | view-details) divided by vertical
 * dividers.
 *
 * Critical for CLS: this card has a very different shape from
 * `ProductCardSkeleton` (horizontal vs vertical, with a 3-column
 * footer) — using the vertical skeleton here would cause the entire
 * Trending section to reflow when content loads.
 */
export const HomepageProductCardSkeleton = memo(function HomepageProductCardSkeleton() {
  return (
    <div
      className="bg-card border border-border rounded-[20px] p-4 sm:p-5 shadow-[0_4px_20px_rgba(0,0,0,0.08)] overflow-hidden"
      aria-hidden="true"
    >
      {/* Header: image (left) + info (right) + favorite (absolute) */}
      <div className="flex gap-3.5 items-start relative min-w-0">
        <Skeleton className="shrink-0 h-[72px] w-[72px] sm:h-[88px] sm:w-[88px] rounded-xl" />
        <div className="flex-1 min-w-0 pr-8 flex flex-col gap-1.5">
          <Skeleton className="h-[18px] w-full" />
          <Skeleton className="h-[18px] w-3/4" />
          <Skeleton className="h-3 w-24 italic" />
          <div className="flex items-center gap-2.5 mt-1">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-3 w-12" />
          </div>
        </div>
        <Skeleton className="absolute top-0 right-0 h-8 w-8 rounded-full" />
      </div>

      {/* Description */}
      <Skeleton className="mt-3.5 h-3.5 w-full" />
      <Skeleton className="mt-1.5 h-3.5 w-5/6" />

      {/* Footer: growth | care | view-details */}
      <div className="mt-3.5 flex items-center border-t border-border pt-3">
        <div className="flex-1 flex items-center gap-1.5 min-w-0">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-3 w-14" />
        </div>
        <div className="flex-1 flex items-center gap-1.5 min-w-0 border-l border-border pl-3">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-3 w-14" />
        </div>
        <div className="flex items-center gap-1 border-l border-border pl-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-3" />
        </div>
      </div>
    </div>
  );
});

/**
 * Grid of vertical product card skeletons (for the "Best Plants" section).
 * Apply `skeleton-stagger` for the progressive fade-in.
 */
export function ProductGridSkeleton({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 skeleton-stagger",
        className,
      )}
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, i) => (
        <ProductCardSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * Grid of horizontal product card skeletons (for the "Trending / New
 * Arrivals" section). 2-col layout matching the real grid.
 */
export function HomepageProductGridSkeleton({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("grid grid-cols-1 sm:grid-cols-2 gap-5 skeleton-stagger", className)}
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, i) => (
        <HomepageProductCardSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * Pill-group tabs skeleton — matches the Trending/New Arrivals pill
 * toggle and the Best-Plants category tab strip. Two-pill default
 * (the Trending toggle); pass `count` for more (e.g. 4 for category
 * tabs).
 */
export const TabsSkeleton = memo(function TabsSkeleton({
  count = 2,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border border-border bg-muted/40 p-1 gap-1",
        className,
      )}
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-9 w-24 rounded-full"
          // First tab "active" state — slightly darker to match the real
          // active pill (bg-foreground text-background).
          style={i === 0 ? { opacity: 1 } : undefined}
        />
      ))}
    </div>
  );
});

/**
 * Section header skeleton — the eyebrow label + serif title + optional
 * "View all" ghost button row used at the top of every homepage section.
 * Matches the typographic scale (11px eyebrow, 3xl/4xl serif title).
 */
export const SectionHeaderSkeleton = memo(function SectionHeaderSkeleton({
  eyebrowWidth = "w-28",
  titleWidth = "w-64",
  showViewAll = true,
}: {
  eyebrowWidth?: string;
  titleWidth?: string;
  showViewAll?: boolean;
}) {
  return (
    <div className="flex items-end justify-between mb-4" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className={cn("h-3 rounded-full", eyebrowWidth)} />
        <Skeleton className={cn("h-9 md:h-10", titleWidth)} />
      </div>
      {showViewAll && <Skeleton className="h-8 w-24 rounded-full" />}
    </div>
  );
});

/**
 * Hero section skeleton — matches the homepage hero:
 * huge serif headline (2 lines), accent divider row, paragraph,
 * 2-CTA grid (filled pill + outlined pill).
 */
export const HeroSkeleton = memo(function HeroSkeleton() {
  return (
    <section className="relative overflow-hidden pt-4 pb-4 bg-background" aria-hidden="true">
      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-xl w-full py-2 lg:py-10">
          {/* Headline — two lines, very large serif */}
          <Skeleton className="h-16 md:h-20 lg:h-24 w-72" />
          <Skeleton className="h-16 md:h-20 lg:h-24 w-56 mt-1" />

          {/* Divider row: small logo + line */}
          <div className="mt-5 flex items-center gap-3">
            <Skeleton className="h-6 w-6 rounded-full" />
            <Skeleton className="h-px w-12" />
          </div>

          {/* Paragraph */}
          <Skeleton className="mt-3 h-4 w-80 max-w-full" />
          <Skeleton className="mt-1.5 h-4 w-64" />

          {/* CTA grid: filled + outlined pill */}
          <div className="mt-6 grid grid-cols-2 gap-2 sm:gap-3 max-w-md">
            <Skeleton className="h-12 sm:h-14 rounded-full" />
            <Skeleton className="h-12 sm:h-14 rounded-full" />
          </div>
        </div>
      </div>
    </section>
  );
});

/**
 * Collection slider skeleton — matches the horizontal scroll strip of
 * 220×300 category cards with the navigation arrows in the header.
 * 5 cards visible by default (matches the typical categories count).
 */
export const CollectionSliderSkeleton = memo(function CollectionSliderSkeleton({
  count = 5,
}: {
  count?: number;
}) {
  return (
    <section className="pt-16 pb-10 bg-muted/20" aria-hidden="true">
      <div className="container mx-auto px-4">
        <div className="flex items-end justify-between mb-8">
          <SectionHeaderSkeleton eyebrowWidth="w-36" titleWidth="w-52" showViewAll={false} />
          {/* Nav arrows */}
          <div className="flex gap-2">
            <Skeleton className="h-9 w-9 rounded-full" />
            <Skeleton className="h-9 w-9 rounded-full" />
          </div>
        </div>
        <div className="flex gap-4 overflow-hidden skeleton-stagger">
          {Array.from({ length: count }).map((_, i) => (
            <Skeleton key={i} className="shrink-0 w-[220px] h-[300px] rounded-2xl" />
          ))}
        </div>
      </div>
    </section>
  );
});

/**
 * "Why Choose Us" skeleton — 3 feature cards with icon + title + desc.
 */
export const WhyChooseUsSkeleton = memo(function WhyChooseUsSkeleton() {
  return (
    <section className="py-20 bg-background border-t" aria-hidden="true">
      <div className="container mx-auto px-4">
        <div className="text-center mb-14 space-y-3">
          <Skeleton className="h-3 w-32 rounded-full mx-auto" />
          <Skeleton className="h-10 w-56 mx-auto" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto skeleton-stagger">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="flex flex-col items-center text-center gap-4 px-4 py-6 rounded-2xl bg-card border border-border/60"
            >
              <Skeleton className="h-14 w-14 rounded-2xl" />
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-5/6" />
              <Skeleton className="h-3.5 w-4/6" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
});

/**
 * Instagram feed skeleton — header (avatar + title + follow link) +
 * 3×2 (mobile) / 6×1 (desktop) image grid + bottom CTA.
 */
export const InstagramFeedSkeleton = memo(function InstagramFeedSkeleton() {
  return (
    <section className="py-14" aria-hidden="true">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="space-y-1.5">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-3 w-28" />
            </div>
          </div>
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="grid grid-cols-3 md:grid-cols-6 gap-1.5 md:gap-2 skeleton-stagger">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-xl" />
          ))}
        </div>
      </div>
    </section>
  );
});
