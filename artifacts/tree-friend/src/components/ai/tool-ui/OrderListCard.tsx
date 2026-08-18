/**
 * OrderListCard — rich inline UI for get_user_orders tool results.
 *
 * v6.2 Part 2: renders the user's 5 most recent orders as a compact
 * list — order number, status badge, date, item summary, total, and a
 * "View" button that deep-links to the order detail page.
 *
 * v6.2 Part 15 (UI vs text dedup — industry-standard pattern):
 *   - Adds a `FactCallout` at the TOP of the card that surfaces a
 *     one-sentence summary of the user's order history, picked by
 *     inspecting the user's question (e.g. 'how many' -> count,
 *     'recent'/'latest' -> most recent order date, default -> count).
 *   - Pairs with the system-prompt v1.4.0 change: model now writes
 *     ONLY the direct 1-2 sentence answer; it does NOT restate the
 *     structured fields this card already shows.
 *
 * Data shape (from aiTools.ts getUserOrders):
 *   { signed_in: boolean, orders: [{
 *     order_number, tracking_id, status, payment_status, total, date,
 *     delivered, items: ["1× Alphonso Mango", ...], location
 *   }], message?: string }
 *
 * If not signed in, shows a friendly message prompting sign-in.
 */
import { memo } from "react";
import { Package, ChevronRight, LogIn, ClipboardList, Truck, CheckCircle2 } from "lucide-react";
import { useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { useStaggeredReveal } from "@/hooks/useStaggeredReveal";
// v6.2 Part 12 (Gap Fix #1): types flow from the Zod schema. No local
// OrderItem / OrdersResult interfaces — they're now inferred + validated.
import type { OrdersResult, OrderListItem } from "./schemas";
import { FactCallout, matchesAnyKeyword } from "./FactCallout";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-warning/10 text-warning border-warning/30",
  confirmed: "bg-info/10 text-info border-info/30",
  processing: "bg-info/10 text-info border-info/30",
  shipped: "bg-primary/10 text-primary border-primary/30",
  delivered: "bg-success/10 text-success border-success/30",
  cancelled: "bg-destructive/10 text-destructive border-destructive/30",
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

function formatPrice(price: string | number): string {
  const n = typeof price === "string" ? Number(price) : price;
  return `৳${n.toLocaleString()}`;
}

// ─── v6.2 Part 15: question-driven callout picker ─────────────────────────────
//
// Returns { icon, text } for the FactCallout, or null if no rule matches.
// The summary always references real fields from the orders list so the
// user gets a concrete number + date — never a vague phrase.
function pickOrderListCallout(
  userQuestion: string | undefined,
  orders: OrderListItem[],
): { icon: typeof Package; text: string } | null {
  if (orders.length === 0) return null;
  const latest = orders[0]; // orders are sorted DESC by created_at in the SQL
  const deliveredCount = orders.filter((o) => o.status === "delivered").length;
  const inTransitCount = orders.filter((o) =>
    ["confirmed", "processing", "shipped"].includes(o.status),
  ).length;

  // 'how many' / 'count' -> numeric summary
  if (matchesAnyKeyword(userQuestion, ["how many", "count", "number of"])) {
    return {
      icon: ClipboardList,
      text: `You have ${orders.length} recent order${orders.length === 1 ? "" : "s"}${deliveredCount > 0 ? `, ${deliveredCount} delivered` : ""}.`,
    };
  }

  // 'recent' / 'latest' / 'last' -> most recent order date + number
  if (matchesAnyKeyword(userQuestion, ["recent", "latest", "last", "newest"])) {
    return {
      icon: Package,
      text: `Most recent: order #${latest.order_number}, placed ${formatDate(latest.date)}, currently ${latest.status}.`,
    };
  }

  // 'delivery' / 'shipping' / 'track' -> in-transit count + which ones
  if (
    matchesAnyKeyword(userQuestion, ["deliver", "shipping", "ship", "track", "arrive", "transit"])
  ) {
    if (inTransitCount > 0) {
      return {
        icon: Truck,
        text: `${inTransitCount} order${inTransitCount === 1 ? " is" : "s are"} currently in transit. Tap any row to track.`,
      };
    }
    if (deliveredCount > 0) {
      return {
        icon: CheckCircle2,
        text: `${deliveredCount} order${deliveredCount === 1 ? "" : "s"} delivered, none currently in transit.`,
      };
    }
  }

  // Default: numeric summary (covers the open-ended 'show my orders' case).
  return {
    icon: ClipboardList,
    text: `Showing ${orders.length} recent order${orders.length === 1 ? "" : "s"}${deliveredCount > 0 ? `, ${deliveredCount} delivered` : ""}.`,
  };
}

function OrderRow({ order, onClose }: { order: OrderListItem; onClose?: () => void }) {
  const [, navigate] = useLocation();
  const itemsSummary = order.items?.slice(0, 2).join(", ") ?? "";
  const extraCount = (order.items?.length ?? 0) - 2;

  // v6.2 Part 5 (P1-10): keyboard accessibility.
  // The row was a clickable <div> with no role/tabIndex/onKeyDown —
  // keyboard users couldn't activate it. Now it's a proper button-like
  // element: role="button", tabIndex=0 (focusable in DOM order), and
  // Enter/Space triggers the same navigation as a click.
  //
  // Industry standard (WAI-ARIA Authoring Practices for list-of-links):
  //   - role="button" (NOT "link" — this is a JS-driven navigation, not a
  //     real <a>; the URL doesn't change in the address bar on focus)
  //   - tabIndex={0} (reachable via Tab key)
  //   - onKeyDown handles Enter + Space (the two activation keys per
  //     WAI-ARIA — Space is the standard for buttons, Enter for both)
  //   - aria-label describes the destination for screen readers
  //
  // We DON'T use a real <button> here because the row contains a flex
  // layout with multiple interactive children — a <button> can't legally
  // contain other interactive elements per the HTML spec. The role="button"
  // pattern is the WAI-ARIA sanctioned workaround.
  const handleNavigate = () => {
    onClose?.();
    navigate(`/orders/${order.order_number}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Enter OR Space activates — both are standard per WAI-ARIA APG.
    // preventDefault on Space to stop the page from scrolling (default
    // Space behavior when focus is on a non-form element).
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleNavigate();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleNavigate}
      onKeyDown={handleKeyDown}
      // Comprehensive aria-label so screen readers announce the row's
      // content as a single action — without this, the row would be
      // announced as a confusing sequence of "#123, delivered, 2 items,
      // ৳1,200, Aug 12" without the context that it's clickable.
      aria-label={`View order ${order.order_number}, status ${order.status}, total ${formatPrice(order.total)}, placed ${formatDate(order.date)}`}
      className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset transition-colors cursor-pointer"
    >
      {/* Icon */}
      <div className="h-8 w-8 rounded bg-primary/10 flex items-center justify-center flex-shrink-0">
        <Package className="h-4 w-4 text-primary" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium">#{order.order_number}</span>
          <Badge
            variant="outline"
            className={`text-[8px] h-4 ${STATUS_COLORS[order.status] || ""}`}
          >
            {order.status}
          </Badge>
        </div>
        <p className="text-[10px] text-muted-foreground truncate">
          {itemsSummary}
          {extraCount > 0 && ` +${extraCount} more`}
        </p>
      </div>

      {/* Price + date */}
      <div className="text-right flex-shrink-0">
        <div className="text-xs font-semibold">{formatPrice(order.total)}</div>
        <div className="text-[9px] text-muted-foreground">{formatDate(order.date)}</div>
      </div>

      <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
    </div>
  );
}

export const OrderListCard = memo(function OrderListCard({
  data,
  userQuestion,
  onClose,
}: {
  data: OrdersResult;
  /**
   * v6.2 Part 15: the user's most recent question, used by
   * pickOrderListCallout to surface the single most relevant summary
   * in the FactCallout at the top of the card.
   */
  userQuestion?: string;
  onClose?: () => void;
}) {
  // v6.2 Part 12 (Gap Fix #1): data is now typed as OrdersResult from the
  // Zod schema (validated upstream in ToolComponentRenderer). No more
  // `as OrdersResult` cast — the type flows from the schema.
  const result = data;

  // v6.2 Part 9 (Gap 17 fix — Phase A): staggered reveal of order rows.
  // Each row fades in 40ms after the previous (capped at 400ms — tighter
  // than ListingGridCard because order rows are smaller + the user scans
  // them faster). Matches Claude's artifact streaming visual pattern.
  // Computed before early returns (Rules of Hooks).
  const visibleOrders = result?.orders ?? [];
  const rowStyles = useStaggeredReveal(visibleOrders.length, 40, 400);
  // v6.2 Part 15: pick the callout to feature at the top of the card.
  // Computed here (after early returns is fine since this isn't a hook).
  const callout =
    result?.signed_in && visibleOrders.length > 0
      ? pickOrderListCallout(userQuestion, visibleOrders)
      : null;

  // Not signed in.
  if (!result || !result.signed_in) {
    return (
      <div className="border rounded-lg p-3 bg-muted/30 text-center">
        <LogIn className="h-5 w-5 text-muted-foreground mx-auto mb-1" />
        <p className="text-xs text-muted-foreground">
          {result?.message || "Sign in to view your orders."}
        </p>
      </div>
    );
  }

  if (!result.orders || result.orders.length === 0) {
    return (
      <div className="border rounded-lg p-3 bg-muted/30 text-center text-xs text-muted-foreground">
        You haven't placed any orders yet.{" "}
        <a href="/products" className="text-primary hover:underline">
          Start shopping
        </a>
        .
      </div>
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden bg-card shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* Header */}
      <div className="flex items-center justify-between p-2 border-b bg-muted/30">
        <span className="text-xs font-semibold">Your Recent Orders</span>
        <a href="/orders" className="text-[10px] text-primary hover:underline">
          View all
        </a>
      </div>

      {/* v6.2 Part 15: Fact callout (top of card) */}
      {callout && (
        <div className="px-3 pt-3">
          <FactCallout icon={callout.icon} text={callout.text} accent="primary" />
        </div>
      )}

      {/* Order rows */}
      <div className="divide-y">
        {/* v6.2 Part 9: staggered fade-in per row (Phase A progressive render) */}
        {visibleOrders.map((order, i) => (
          <div
            key={order.order_number}
            style={rowStyles[i]}
            className="animate-in fade-in slide-in-from-bottom-1 duration-200"
          >
            <OrderRow order={order} onClose={onClose} />
          </div>
        ))}
      </div>
    </div>
  );
});
