import { memo } from "react";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Pure-presentational skeleton placeholder for product cards. Wrapped in
 * `memo()` so a parent re-render (e.g. a search-input keystroke updating
 * the parent's state) doesn't re-render every skeleton in a grid of N.
 */
export const ProductCardSkeleton = memo(function ProductCardSkeleton() {
  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden flex flex-col">
      <Skeleton className="aspect-square w-full" />
      <div className="p-4 flex flex-col gap-2">
        <Skeleton className="h-2.5 w-14 rounded-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
        <div className="flex gap-0.5 mt-0.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-3 rounded-sm" />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-3 w-12" />
        </div>
      </div>
    </div>
  );
});

export function ProductGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
      {Array.from({ length: count }).map((_, i) => (
        <ProductCardSkeleton key={i} />
      ))}
    </div>
  );
}

