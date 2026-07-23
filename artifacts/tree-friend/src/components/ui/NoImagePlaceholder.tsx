import { Sprout } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Phase 5: replaces the hardcoded Unsplash fallback
 * (images.unsplash.com/photo-1556228578-8c89e6adf883, a skincare product
 * tube -- not a plant, and was likely never a plant; hotlinking an
 * arbitrary external photo ID is fragile regardless of which ID is used,
 * since the underlying photo can change or be removed at any time) that
 * was copy-pasted across ProductCard.tsx, ProductDetailPage.tsx,
 * WishlistPage.tsx, SubscriptionsPage.tsx, CartPage.tsx (x2),
 * SellerListingDetailPage.tsx, and OrderDetailPage.tsx.
 *
 * Icon + text placeholder, no external dependency, can't silently rot.
 * `className` should set sizing/aspect-ratio/rounding on the wrapper --
 * this component fills its parent (`w-full h-full`) rather than assuming
 * any particular size, since call sites range from small cart thumbnails
 * to full detail-page hero images. `compact` drops the "No image" label
 * for small (<=~48px) thumbnails where text would be illegible/cramped.
 */
export function NoImagePlaceholder({ className, iconClassName, compact = false }: { className?: string; iconClassName?: string; compact?: boolean }) {
  return (
    <div className={cn("w-full h-full flex flex-col items-center justify-center gap-1.5 bg-muted/40 text-muted-foreground", className)}>
      <Sprout className={cn(compact ? "h-4 w-4" : "h-8 w-8", "opacity-40", iconClassName)} />
      {!compact && <span className="text-xs opacity-60">No image</span>}
    </div>
  );
}
