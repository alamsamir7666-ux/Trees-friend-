/**
 * OrderDetailCard — rich inline UI component for get_order_details tool results.
 *
 * v6.2 Part 1: renders a full order card inline in the chat — order number,
 * items with thumbnails, status timeline, nursery name, payment info, and
 * interactive buttons (Track Order, View Details).
 *
 * The "building" animation: while the tool is executing (activeToolCalls
 * contains "get_order_details"), the frontend shows OrderCardSkeleton (a
 * shimmer placeholder). When the tool_result SSE event arrives with the
 * result data, the skeleton transitions to this real card.
 *
 * Data shape (from the get_order_details tool in aiTools.ts):
 *   { order: { order_number, tracking_id, status, payment_status,
 *     payment_method, total, placed_at, confirmed_at, shipped_at,
 *     delivered_at, cancelled_at, items: [{ name, qty, price }],
 *     location } }
 *
 * If the tool returned an error or "not signed in", the card shows a
 * friendly message instead of the order details.
 */
import { memo } from "react";
import { Package, Truck, CheckCircle2, Clock, MapPin, XCircle } from "lucide-react";
import { useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useStaggeredReveal } from "@/hooks/useStaggeredReveal";
// v6.2 Part 12 (Gap Fix #1): types flow from the Zod schema (single source
// of truth). No more local interfaces that could drift from the backend.
import type { OrderResult } from "./schemas";

// ─── Status timeline ─────────────────────────────────────────────────────

const STEPS = ["pending", "confirmed", "processing", "shipped", "delivered"] as const;

const STEP_ICONS: Record<string, typeof Clock> = {
  pending: Clock,
  confirmed: CheckCircle2,
  processing: Package,
  shipped: Truck,
  delivered: CheckCircle2,
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-warning/10 text-warning border-warning/30",
  confirmed: "bg-info/10 text-info border-info/30",
  processing: "bg-info/10 text-info border-info/30",
  shipped: "bg-primary/10 text-primary border-primary/30",
  delivered: "bg-success/10 text-success border-success/30",
  cancelled: "bg-destructive/10 text-destructive border-destructive/30",
};

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatPrice(price: number | string): string {
  const n = typeof price === "string" ? Number(price) : price;
  return `৳${n.toLocaleString()}`;
}

// ─── Component ────────────────────────────────────────────────────────────

export const OrderDetailCard = memo(function OrderDetailCard({
  data,
  onClose,
}: {
  data: OrderResult;
  onClose?: () => void;
}) {
  const [, navigate] = useLocation();
  // v6.2 Part 12 (Gap Fix #1): `data` is now typed as `OrderResult` from
  // the Zod schema (validated upstream in ToolComponentRenderer). The
  // old `const result = data as OrderResult` cast is gone — the type
  // flows from the schema, so a backend shape change updates the type
  // automatically (and any code referencing a removed field fails at
  // compile time).
  const result = data;

  // v6.2 Part 9 (Gap 17 fix — Phase A): pre-compute item + step counts
  // before the early return so we can call useStaggeredReveal unconditionally
  // (Rules of Hooks). When the order is null, these are 0-length arrays.
  const items = result?.order?.items ?? [];
  const itemStyles = useStaggeredReveal(items.length, 40, 320);
  // Timeline has 5 fixed steps (pending → confirmed → processing → shipped → delivered).
  // Stagger them 60ms apart — they're the focal point of the card.
  const stepStyles = useStaggeredReveal(5, 60, 400);

  // Error states.
  if (!result || !result.order) {
    return (
      <div className="border rounded-lg p-4 bg-destructive/5 border-destructive/20">
        <div className="flex items-center gap-2 text-sm text-destructive">
          <XCircle className="h-4 w-4" />
          <span>{result?.message || result?.error || "Order not found."}</span>
        </div>
      </div>
    );
  }

  const order = result.order;
  const isCancelled = order.status === "cancelled";
  const currentStep = isCancelled ? -1 : STEPS.indexOf(order.status as (typeof STEPS)[number]);
  const tsMap: Record<string, string | null> = {
    pending: order.placed_at,
    confirmed: order.confirmed_at,
    processing: order.confirmed_at,
    shipped: order.shipped_at,
    delivered: order.delivered_at,
  };

  return (
    <div className="border rounded-lg overflow-hidden bg-card shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between p-3 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm">Order #{order.order_number}</span>
          <Badge variant="outline" className={`text-[10px] ${STATUS_COLORS[order.status] || ""}`}>
            {order.status}
          </Badge>
        </div>
        <span className="text-[10px] text-muted-foreground">{formatDate(order.placed_at)}</span>
      </div>

      {/* ─── Items ────────────────────────────────────────────────── */}
      <div className="p-3 space-y-2">
        {/* v6.2 Part 9 (Gap 17 fix — Phase A): staggered fade-in per item.
            Each item reveals 40ms after the previous one. */}
        {items.map((item, i) => (
          <div
            key={i}
            style={itemStyles[i]}
            className="flex items-center gap-3 animate-in fade-in slide-in-from-bottom-1 duration-200"
          >
            <div className="h-10 w-10 rounded bg-muted flex items-center justify-center flex-shrink-0">
              <Package className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{item.name}</p>
              <p className="text-[10px] text-muted-foreground">×{item.qty}</p>
            </div>
            <span className="text-sm font-semibold">{formatPrice(item.price)}</span>
          </div>
        ))}
      </div>

      {/* ─── Status Timeline ──────────────────────────────────────── */}
      {!isCancelled ? (
        <div className="px-3 pb-3">
          <div className="flex items-start gap-0">
            {/* v6.2 Part 9 (Gap 17 fix — Phase A): staggered fade-in per
                timeline step. Each step reveals 60ms after the previous
                one — the timeline is the focal point of the card. */}
            {STEPS.map((step, i) => {
              const done = i < currentStep;
              const active = i === currentStep;
              const Icon = STEP_ICONS[step] || Clock;
              return (
                <div
                  key={step}
                  style={stepStyles[i]}
                  className="flex-1 flex flex-col items-center relative animate-in fade-in slide-in-from-bottom-1 duration-200"
                >
                  {i < STEPS.length - 1 && (
                    <div
                      className={`absolute top-4 left-1/2 w-full h-0.5 ${done ? "bg-primary" : "bg-border"}`}
                    />
                  )}
                  <div
                    className={`relative z-10 h-8 w-8 rounded-full flex items-center justify-center border-2 transition-colors ${
                      done
                        ? "bg-primary border-primary text-primary-foreground"
                        : active
                          ? "bg-background border-primary"
                          : "bg-background border-border text-muted-foreground"
                    }`}
                  >
                    {done ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <Icon className={`h-3.5 w-3.5 ${active ? "text-primary" : ""}`} />
                    )}
                  </div>
                  <p
                    className={`text-[9px] mt-1 capitalize text-center ${
                      active ? "font-medium text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {step}
                  </p>
                  {tsMap[step] && (
                    <p className="text-[8px] text-muted-foreground/60">{formatDate(tsMap[step])}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="px-3 pb-3">
          <div className="bg-destructive/10 text-destructive rounded-lg p-2 text-xs text-center">
            This order was cancelled
            {order.cancelled_at ? ` on ${formatDate(order.cancelled_at)}` : ""}.
          </div>
        </div>
      )}

      {/* ─── Footer: total + location + buttons ───────────────────── */}
      <div className="p-3 border-t bg-muted/20 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Total</span>
          <span className="font-bold text-sm">{formatPrice(order.total)}</span>
        </div>
        {order.location && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <MapPin className="h-3 w-3" />
            <span>{order.location}</span>
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              onClose?.();
              navigate(`/track-order?tracking=${order.tracking_id}`);
            }}
          >
            <Truck className="h-3 w-3 mr-1" />
            Track Order
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              onClose?.();
              navigate(`/orders/${order.order_number}`);
            }}
          >
            <Package className="h-3 w-3 mr-1" />
            View Details
          </Button>
        </div>
      </div>
    </div>
  );
});
