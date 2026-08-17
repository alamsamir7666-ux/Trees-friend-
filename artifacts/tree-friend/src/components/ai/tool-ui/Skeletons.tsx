/**
 * Skeleton loading states for tool-call UI components (v6.2 Part 1).
 *
 * Shows a shimmer animation while the tool is executing — the "building"
 * effect the user asked for. Each skeleton mimics the layout of the real
 * component (OrderDetailCard, ListingGrid, etc.) so the transition from
 * skeleton → real component is seamless (same shape, same height).
 *
 * Uses the existing shadcn `Skeleton` component (animate-pulse rounded-md).
 */
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Skeleton for OrderDetailCard — mimics the card layout:
 * header (order number + status), item list (2 rows), timeline, buttons.
 */
export function OrderCardSkeleton() {
  return (
    <div className="border rounded-lg p-4 bg-muted/30 space-y-3 animate-in fade-in duration-300">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-16" />
        </div>
        <Skeleton className="h-5 w-20" />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Skeleton className="h-3 w-32" />
      </div>
      <div className="space-y-2">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-3 p-2 rounded-lg bg-background/50">
            <Skeleton className="h-10 w-10 rounded" />
            <div className="flex-1 space-y-1">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-2 w-20" />
            </div>
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1 pt-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex-1 flex flex-col items-center gap-1">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-2 w-12" />
          </div>
        ))}
      </div>
      <div className="flex gap-2 pt-1">
        <Skeleton className="h-8 w-24 rounded-lg" />
        <Skeleton className="h-8 w-20 rounded-lg" />
      </div>
    </div>
  );
}

/**
 * Generic skeleton for tools we haven't built a specific skeleton for yet.
 * Shows a simple shimmer box with the tool's friendly label.
 */
export function GenericToolSkeleton({ label }: { label: string }) {
  return (
    <div className="border rounded-lg p-4 bg-muted/30 space-y-2 animate-in fade-in duration-300">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-4 rounded-full" />
        <span className="text-xs text-muted-foreground font-medium">{label}…</span>
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

/**
 * Maps tool names → skeleton components.
 * Falls back to GenericToolSkeleton for unmapped tools.
 */
export function getToolSkeleton(toolName: string): React.FC {
  const SKELETONS: Record<string, React.FC> = {
    get_order_details: OrderCardSkeleton,
    get_user_orders: OrderCardSkeleton, // similar shape — list of orders
  };
  return SKELETONS[toolName] ?? (() => <GenericToolSkeleton label="Loading" />);
}
