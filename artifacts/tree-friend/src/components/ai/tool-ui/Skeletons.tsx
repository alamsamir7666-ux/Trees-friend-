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
// v6.2 Part 12 (Gap Fix #2): SKELETONS is now keyed by ToolName — a typo
// in a tool name is a compile-time error, not a silent fallback to the
// generic skeleton.
import type { ToolName } from "./toolNames";

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
 *
 * v6.2 Part 12 (Gap Fix #2): typed as `Partial<Record<ToolName, React.FC>>`
 * so the keys are checked at compile time. A typo like `get_order_detail`
 * (missing `s`) is now a compile error, not a silent miss. New tools
 * added to toolNames.ts that don't need a skeleton are simply omitted —
 * `Partial<>` allows that.
 */
export function getToolSkeleton(toolName: string): React.FC {
  // The function accepts `string` (not ToolName) because AssistantPanel
  // passes the raw `call.name` from ActiveToolCall — which is already
  // typed as ToolName upstream, but the `string` parameter keeps this
  // helper usable from non-typed call sites (e.g. tests, future callers).
  const SKELETONS: Partial<Record<ToolName, React.FC>> = {
    get_order_details: OrderCardSkeleton,
    get_user_orders: OrderListSkeleton,
    search_seller_listings: ListingGridSkeleton,
    get_product_care: CareGuideSkeleton,
  };
  // Cast through `string` for the lookup — Partial<Record> returns
  // `FC | undefined`, which we default to GenericToolSkeleton.
  return SKELETONS[toolName as ToolName] ?? (() => <GenericToolSkeleton label="Loading" />);
}

/**
 * Skeleton for OrderListCard — mimics the list layout (header + 3 rows).
 */
export function OrderListSkeleton() {
  return (
    <div className="border rounded-lg overflow-hidden bg-muted/30 space-y-0 animate-in fade-in duration-300">
      <div className="p-2 border-b bg-muted/20">
        <Skeleton className="h-3 w-28" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-2 p-2 border-b last:border-0">
          <Skeleton className="h-8 w-8 rounded" />
          <div className="flex-1 space-y-1">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-2 w-32" />
          </div>
          <div className="text-right space-y-1">
            <Skeleton className="h-2.5 w-10" />
            <Skeleton className="h-2 w-8" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Skeleton for ListingGridCard — mimics a 2-column grid of 4 listing cards.
 */
export function ListingGridSkeleton() {
  return (
    <div className="space-y-2 animate-in fade-in duration-300">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="border rounded-lg p-3 bg-muted/30 space-y-2">
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-12" />
            </div>
            <Skeleton className="h-2 w-24" />
            <Skeleton className="h-2 w-16" />
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-6 w-14 rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Skeleton for CareGuideCard — mimics the header + fields grid + tips.
 */
export function CareGuideSkeleton() {
  return (
    <div className="border rounded-lg overflow-hidden bg-muted/30 space-y-3 animate-in fade-in duration-300">
      <div className="flex items-center gap-3 p-3 border-b bg-muted/20">
        <Skeleton className="h-12 w-12 rounded" />
        <div className="space-y-1">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-2 w-20" />
        </div>
      </div>
      <div className="p-3 grid grid-cols-2 gap-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="h-3.5 w-3.5 rounded-full" />
            <Skeleton className="h-2.5 w-20" />
          </div>
        ))}
      </div>
      <div className="px-3 pb-3 space-y-1">
        <Skeleton className="h-2 w-16" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-2 w-3/4" />
      </div>
    </div>
  );
}
