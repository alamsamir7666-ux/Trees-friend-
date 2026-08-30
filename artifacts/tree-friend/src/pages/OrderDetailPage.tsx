import { useState, useEffect } from "react";
import { useParams, useSearch, Link, useLocation } from "wouter";
import {
  useGetOrder,
  useGetPublicSeller,
  createBkashPayment,
  createBkashPaymentGuest,
} from "@workspace/api-client-react";
import type { Order } from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CheckCircle2,
  Circle,
  Package,
  Truck,
  Home,
  ChevronLeft,
  XCircle,
  RotateCcw,
  Loader2,
  AlertTriangle,
  ExternalLink,
  MapPin,
  MessageCircle,
  ShieldCheck,
  Store as StoreIcon,
  Leaf,
  Hash,
  CreditCard,
  Calendar,
  Gift,
  Clock,
  Package2,
  ArrowRight,
} from "lucide-react";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";
import { BKASH_ICON } from "@/lib/preorderIcons";
import { useApiFetch } from "@/lib/useApiFetch";
import { getOrderStatusConfig } from "@/lib/orderStatus";
import { getReturnStatusConfig } from "@/lib/returnStatus";
import { apiClient } from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";

// ── Order item shape (per item in order.items[]) ───────────────────
// Items can be either platform-direct (sellerId == null) or marketplace
// (sellerId set). Each carries its own snapshot fields: productName,
// productImage, quantity, price, deliveryCharge, and optionally
// variantName (platform-direct) or sellerListingId/sellerListingVariantId
// (marketplace). Typed as `any` here to match the existing rendering
// pattern in this file — the underlying column is JSONB.
type OrderItemRow = {
  productId: number;
  productName: string;
  productImage?: string;
  variantName?: string;
  variantId?: number;
  sellerListingId?: number;
  sellerListingVariantId?: number;
  sellerId?: number | null;
  quantity: number;
  price: number;
  deliveryCharge?: number;
  [key: string]: unknown;
};

/**
 * One nursery's group inside an order: nursery header (logo, name,
 * location, verified badge, Visit Store + Message buttons) + that
 * nursery's line items + group subtotal/courier-fee summary. Falls back
 * gracefully when the seller is no longer active (useGetPublicSeller 404s).
 */
function NurseryGroupCard({
  sellerId,
  items,
  isGuest,
}: {
  sellerId: number;
  items: OrderItemRow[];
  isGuest: boolean;
}) {
  const { data: seller, isError } = useGetPublicSeller(sellerId, {
    query: { enabled: !!sellerId, queryKey: ["seller", sellerId] },
  });
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  async function handleMessage() {
    if (isGuest) {
      toast({
        title: "Sign in to message this nursery",
        description: "Create a free account to chat with sellers.",
      });
      return;
    }
    try {
      const res = await apiClient.post("/api/conversations", { sellerId });
      setLocation(`/messages/${(res.data as { id: number }).id}`);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      let description = "Something went wrong. Please try again.";
      try {
        const jsonMatch = raw.match(/\{.*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.error) description = parsed.error;
        }
      } catch {
        // Malformed error payload — fall back to the generic description.
      }
      toast({ title: "Could not start chat", description });
    }
  }

  const subtotal = items.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
  const codDelivery = items.reduce(
    (s, i) => s + (i.sellerId != null ? Number(i.deliveryCharge ?? 0) * i.quantity : 0),
    0,
  );

  return (
    <div className="bg-card border rounded-xl overflow-hidden">
      {/* Nursery header */}
      <div className="flex items-center justify-between gap-3 p-4 sm:p-5 border-b bg-muted/20">
        <div className="flex items-center gap-3 min-w-0">
          <div className="shrink-0 w-11 h-11 rounded-full overflow-hidden border bg-muted/40 flex items-center justify-center">
            {seller?.logoUrl ? (
              <img src={seller.logoUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <StoreIcon className="w-5 h-5 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="font-semibold text-sm truncate">
                {seller?.nurseryName ?? (isError ? "Nursery unavailable" : "Loading nursery...")}
              </h3>
              {seller?.isVerified && <ShieldCheck className="w-3.5 h-3.5 text-accent shrink-0" />}
            </div>
            {seller?.location && (
              <div className="flex items-center gap-1 mt-0.5">
                <MapPin className="w-3 h-3 text-muted-foreground shrink-0" strokeWidth={1.5} />
                <span className="text-[11px] text-muted-foreground truncate">
                  {seller.location}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {seller && (
            <Link
              href={`/store/${seller.id}`}
              className="text-xs font-medium text-accent hover:underline whitespace-nowrap"
            >
              Visit Store
            </Link>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs rounded-full"
            onClick={handleMessage}
          >
            <MessageCircle className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Message</span>
          </Button>
        </div>
      </div>

      {/* Items */}
      <div className="divide-y">
        {items.map((item) => (
          <ItemLine
            key={`${item.productId}-${item.variantId ?? item.sellerListingVariantId ?? ""}`}
            item={item}
          />
        ))}
      </div>

      {/* Group summary */}
      <div className="border-t bg-muted/10 px-4 sm:px-5 py-3 space-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">
            Subtotal ({items.length} item{items.length > 1 ? "s" : ""})
          </span>
          <span className="font-medium">Tk{subtotal.toLocaleString()}</span>
        </div>
        {codDelivery > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Courier fee (pay on delivery)</span>
            <span className="font-medium">Tk{codDelivery.toLocaleString()}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Single order item line: thumbnail + name + variant + qty + price +
 * per-item courier fee. Used inside NurseryGroupCard so item rendering
 * stays consistent across all nurseries.
 */
function ItemLine({ item }: { item: OrderItemRow }) {
  const img = item.productImage ?? null;
  return (
    <div className="flex gap-4 p-4 sm:p-5">
      {img ? (
        <img
          src={img}
          alt={item.productName}
          className="w-16 h-16 object-cover rounded-lg shrink-0"
        />
      ) : (
        <NoImagePlaceholder className="w-16 h-16 rounded-lg shrink-0" compact />
      )}
      <div className="flex-1 flex justify-between items-start gap-2">
        <div className="min-w-0">
          <p className="font-medium text-sm">{item.productName}</p>
          {item.variantName && (
            <p className="text-xs text-muted-foreground mt-0.5">Variant: {item.variantName}</p>
          )}
          <p className="text-xs text-muted-foreground mt-0.5">Qty: {item.quantity}</p>
          {item.sellerId != null && Number(item.deliveryCharge) > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Courier fee: Tk{(Number(item.deliveryCharge) * item.quantity).toLocaleString()} (pay
              on delivery)
            </p>
          )}
        </div>
        <p className="font-medium text-sm whitespace-nowrap">
          Tk{(item.price * item.quantity).toLocaleString()}
        </p>
      </div>
    </div>
  );
}

interface GuestOrder {
  id: number;
  trackingId: string;
  orderStatus: string;
  paymentStatus: string;
  paymentMethod: string;
  totalAmount: number | string;
  checkoutSessionId?: string | null;
  items?: {
    productName: string;
    productImage?: string;
    quantity: number;
    price: number;
    [k: string]: unknown;
  }[];
  shippingAddress?: {
    fullName?: string;
    street?: string;
    line1?: string;
    city?: string;
    district?: string;
    phone?: string;
  } | null;
  createdAt: string;
  [key: string]: unknown;
}

interface ReturnRow {
  orderId: number;
  status: string;
  reason?: string;
  adminNote?: string;
  [key: string]: unknown;
}

// Note: statusColors + returnStatusConfig moved to @/lib/orderStatus.ts and
// @/lib/returnStatus.ts (shared with OrdersPage.tsx). The local copies were
// removed to prevent drift between the two surfaces.

const STEPS = ["pending", "confirmed", "processing", "shipped", "delivered"];

// ─── Sibling Orders Section ──────────────────────────────────────────────────
// Shows the buyer's OTHER orders from the same checkout (linked via
// checkoutSessionId). When a cart has mixed payment methods, it splits into
// multiple orders — this section lets the buyer navigate between them.

function SiblingOrdersSection({
  checkoutSessionId,
  currentOrderId,
}: {
  checkoutSessionId: string;
  currentOrderId: number;
}) {
  const { data: siblings, isLoading } = useQuery({
    queryKey: ["order-siblings", checkoutSessionId],
    queryFn: async () => {
      const { data } = await apiClient.get<any[]>("/orders", {
        params: { checkoutSessionId, limit: 50 },
      });
      return Array.isArray(data) ? data : [];
    },
  });

  if (isLoading || !siblings) return null;

  // Filter out the current order — only show the OTHERS.
  const others = siblings.filter((o) => o.id !== currentOrderId);
  if (others.length === 0) return null;

  return (
    <div className="bg-muted/30 border border-border rounded-2xl p-4">
      <p className="text-sm font-semibold text-foreground mb-2 flex items-center gap-2">
        <Package2 className="h-4 w-4 text-muted-foreground" />
        Also from this checkout
      </p>
      <div className="space-y-2">
        {others.map((o) => (
          <Link
            key={o.id}
            href={`/orders/${o.id}`}
            className="flex items-center justify-between gap-2 rounded-lg bg-card border border-border px-3 py-2 hover:border-foreground/30 transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium text-foreground">
                Order #{o.orderNumber ?? o.trackingId}
              </span>
              <span
                className={`text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 ${
                  o.paymentMethod === "cod"
                    ? "bg-warning/20 text-warning-foreground"
                    : "bg-success/20 text-success-foreground"
                }`}
              >
                {o.paymentMethod === "cod" ? "COD" : "Advance"}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-muted-foreground">
                {o.paymentStatus === "paid"
                  ? "Paid"
                  : o.paymentStatus === "payment_pending"
                    ? "Payment pending"
                    : o.paymentStatus === "cancelled"
                      ? "Cancelled"
                      : o.paymentStatus}
              </span>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const rawId = params.id ?? "0";
  const isGuest = !/^\d+$/.test(rawId);
  const id = isGuest ? 0 : parseInt(rawId);
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  // Note: previously this component called useListOrders just to compute a
  // display "rank" ("Order #3") from the array position. That rank was
  // fragile — it broke with pagination (array position != global position)
  // and required an extra network request on every order detail page load.
  // Removed: the order ID is now used directly as the display identifier,
  // which is stable and meaningful.
  const { data: authOrder, isLoading: authLoading } = useGetOrder(id, {
    query: { enabled: !!id && !isGuest, queryKey: ["order", id] },
  });

  const [guestOrder, setGuestOrder] = useState<GuestOrder | null>(null);
  const [guestLoading, setGuestLoading] = useState(isGuest);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);

  useEffect(() => {
    if (!isGuest) return;
    let cancelled = false;
    setGuestLoading(true);
    // Guest order tracking endpoint is public (no Bearer token needed) —
    // the tracking ID itself is the bearer secret. apiFetch still tries
    // to attach a token (harmless if there's no signed-in user).
    apiFetch(`/api/orders/track/${rawId}`)
      .then(async (r) => (r.ok ? await r.json() : null))
      .then((data) => {
        if (!cancelled) setGuestOrder(data);
      })
      .catch(() => {
        if (!cancelled) setGuestOrder(null);
      })
      .finally(() => {
        if (!cancelled) setGuestLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isGuest, rawId, apiFetch]);

  const order = isGuest ? guestOrder : authOrder;
  const isLoading = isGuest ? guestLoading : authLoading;

  // All hooks must be called unconditionally before any early return
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const [returnLoading, setReturnLoading] = useState(false);
  const [returnError, setReturnError] = useState("");
  const [returnSuccess, setReturnSuccess] = useState(false);
  const [existingReturn, setExistingReturn] = useState<ReturnRow | null>(null);

  // Part 2 of 4 (bKash Tokenized Checkout, see PART2_HANDOFF.md): after
  // bKash's hosted page finishes, our own /api/bkash/callback redirects
  // the buyer's browser HERE with a ?bkash=... query param describing the
  // outcome ("success" | "cancel" | "failure" | "not_completed" |
  // "execute_failed" | etc. -- see that route's own doc comment for the
  // full set of values it can send). Read once via wouter's useSearch
  // (this is a real hook, not a one-off URLSearchParams read, so it stays
  // in sync if the query string changes without a full page reload).
  const search = useSearch();
  const bkashParam = new URLSearchParams(search).get("bkash");
  const [bkashRetryLoading, setBkashRetryLoading] = useState(false);
  const [bkashRetryError, setBkashRetryError] = useState("");

  useEffect(() => {
    if (!id || isGuest) return;
    let cancelled = false;
    apiFetch("/api/returns/me")
      .then(async (r) => (r.ok ? await r.json() : []))
      .then((data: ReturnRow[]) => {
        if (!cancelled && Array.isArray(data)) {
          const found = data.find((r) => r.orderId === id);
          if (found) setExistingReturn(found);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, apiFetch]);

  // ── Shipment tracking (courier tracking ID + link) ──────────────
  // Fetches the order's shipment record (booked by the seller via
  // Pathao/Steadfast) so the buyer can see the courier's tracking ID
  // and click through to the courier's tracking page. Previously the
  // shipment endpoint existed (GET /orders/:id/shipment) but the UI
  // never called it — the buyer had no way to track their package on
  // the courier's website.
  const [shipment, setShipment] = useState<{
    trackingNumber: string | null;
    courierName: string | null;
    trackingUrl: string | null;
    status: string | null;
  } | null>(null);
  useEffect(() => {
    if (!id || isGuest) return;
    let cancelled = false;
    apiFetch(`/api/orders/${id}/shipment`)
      .then(async (r) => (r.ok ? await r.json() : null))
      .then((data) => {
        if (!cancelled && data) setShipment(data);
      })
      .catch(() => {
        // Non-critical — shipment info just won't show.
      });
    return () => {
      cancelled = true;
    };
  }, [id, isGuest, apiFetch]);

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-10">
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }
  if (!order) {
    return <div className="py-20 text-center text-muted-foreground">Order not found.</div>;
  }

  const currentStep = STEPS.indexOf(order.orderStatus);
  const addr = order.shippingAddress as {
    fullName?: string;
    street?: string;
    line1?: string;
    city?: string;
    district?: string;
    phone?: string;
  } | null;

  // Normalize for field accesses that would otherwise widen to `unknown`
  // (because `order` is a union of `GuestOrder` and `Order`). This alias
  // has the same runtime value but a uniform type. Use `ord` for any
  // field access where the union confuses TypeScript; `order` itself is
  // fine for fields that exist identically on both shapes.
  const ord = order as Order;

  /**
   * "Pay with bKash" / "Retry payment" action -- reuses the exact same
   * create-payment endpoints CheckoutPage.tsx calls right after order
   * creation. Shown whenever an order is paymentMethod "bkash" and still
   * sitting at paymentStatus "payment_pending" (buyer never finished
   * paying, cancelled on bKash's page, or this is one of several bkash
   * orders from a multi-seller checkout that CheckoutPage.tsx only paid
   * the FIRST of -- see that file's own doc comment on
   * payFirstBkashOrderOrGoToOrder). Does a full browser redirect, same as
   * checkout's own flow, for the same reason (bKash's hosted page isn't
   * designed for a popup round-trip).
   */
  async function handlePayWithBkash() {
    if (!order) return;
    setBkashRetryLoading(true);
    setBkashRetryError("");
    try {
      const session = isGuest
        ? await createBkashPaymentGuest({ trackingId: order.trackingId })
        : await createBkashPayment({ orderId: order.id });
      window.location.href = session.bkashURL;
    } catch {
      setBkashRetryLoading(false);
      setBkashRetryError("Couldn't start bKash payment right now. Please try again in a moment.");
    }
  }

  async function handleCancelOrder() {
    if (!order) return;
    if (!cancelReason.trim() || cancelReason.trim().length < 3) {
      setCancelError("Please provide a reason for cancellation.");
      return;
    }
    setCancelLoading(true);
    setCancelError("");
    try {
      const r = await apiFetch(`/api/orders/${order.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: cancelReason.trim() }),
        headers: { "Content-Type": "application/json" },
      });
      const data = await r.json();
      if (!r.ok) {
        setCancelError(data.error ?? "Failed to cancel order.");
        return;
      }
      setCancelOpen(false);
      // React Query invalidation — replaces the old window.location.reload()
      // which was an anti-pattern (lost scroll position, bKash callback
      // query state, etc.). Invalidating the "order" query causes
      // useGetOrder to refetch with the updated status.
      qc.invalidateQueries({ queryKey: ["order", order.id] });
      // Also invalidate the orders list so it reflects the new status.
      qc.invalidateQueries({ queryKey: ["/api/orders"] });
    } catch {
      setCancelError("Something went wrong. Please try again.");
    } finally {
      setCancelLoading(false);
    }
  }

  async function handleReturnRequest() {
    if (!order) return;
    if (!returnReason.trim() || returnReason.trim().length < 10) {
      setReturnError("Please describe your reason in at least 10 characters.");
      return;
    }
    setReturnLoading(true);
    setReturnError("");
    try {
      const r = await apiFetch("/api/returns", {
        method: "POST",
        body: JSON.stringify({ orderId: order.id, reason: returnReason.trim() }),
        headers: { "Content-Type": "application/json" },
      });
      const data = await r.json();
      if (!r.ok) {
        setReturnError(data.error ?? "Failed to submit return request.");
        return;
      }
      setReturnSuccess(true);
      setExistingReturn(data as ReturnRow);
      setTimeout(() => setReturnOpen(false), 2500);
    } catch {
      setReturnError("Something went wrong. Please try again.");
    } finally {
      setReturnLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="bg-muted/30 border-b py-10">
        <div className="container mx-auto px-4">
          <PageBreadcrumb
            crumbs={[
              { label: "My Orders", href: "/orders", icon: <Package className="h-3 w-3" /> },
              { label: isGuest ? `Order ${order.trackingId}` : `Order #${order.id}` },
            ]}
            className="mb-4"
          />
          <Link href="/orders">
            <Button variant="ghost" size="sm" className="mb-4 gap-1 text-muted-foreground">
              <ChevronLeft className="h-4 w-4" /> My Orders
            </Button>
          </Link>
          <div className="flex items-start justify-between">
            <div>
              <h1 className="font-serif text-3xl font-medium">
                {isGuest ? `Order ${order.trackingId}` : `Order #${order.id}`}
              </h1>
              <p className="text-muted-foreground mt-1 text-sm">
                {new Date(order.createdAt).toLocaleDateString("en-BD", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </p>
            </div>
            <span
              className={`px-3 py-1.5 rounded-full text-sm font-medium ${getOrderStatusConfig(order.orderStatus).badge}`}
            >
              {order.orderStatus === "return_completed"
                ? "Refund Completed"
                : order.orderStatus.charAt(0).toUpperCase() + order.orderStatus.slice(1)}
            </span>
          </div>

          {/* ── Meta info chips ───────────────────────────────────────
              Industry-standard "order facts" row — at-a-glance summary of
              the order's stable identifiers (order #, tracking ID, payment
              method, date placed, item count). Skips chips whose value
              isn't available so we never show an empty pill. */}
          <div className="flex flex-wrap gap-2 mt-5">
            {!isGuest && (ord as any).orderNumber && (
              <span className="inline-flex items-center gap-1.5 bg-card border rounded-full px-3 py-1 text-xs text-muted-foreground">
                <Hash className="w-3 h-3" />
                Order #{(ord as any).orderNumber}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 bg-card border rounded-full px-3 py-1 text-xs text-muted-foreground">
              <Package className="w-3 h-3" />
              <span className="font-mono">{order.trackingId}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 bg-card border rounded-full px-3 py-1 text-xs text-muted-foreground capitalize">
              <CreditCard className="w-3 h-3" />
              {order.paymentMethod}
            </span>
            <span className="inline-flex items-center gap-1.5 bg-card border rounded-full px-3 py-1 text-xs text-muted-foreground">
              <Calendar className="w-3 h-3" />
              Placed{" "}
              {new Date(order.createdAt).toLocaleDateString("en-BD", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
            <span className="inline-flex items-center gap-1.5 bg-card border rounded-full px-3 py-1 text-xs text-muted-foreground">
              <Package className="w-3 h-3" />
              {(order.items ?? []).length} item{(order.items ?? []).length === 1 ? "" : "s"}
            </span>
            {/* Source count — how many distinct nurseries this order is
                sourced from. Same calculation as the grouped sections
                below, surfaced here as a chip so buyers can tell at a
                glance whether they're getting one delivery or several.
                Only shown when the order spans more than one nursery. */}
            {(() => {
              const sellerIds = new Set<number>();
              (order.items ?? []).forEach((i: any) => {
                if (i.sellerId != null) sellerIds.add(Number(i.sellerId));
              });
              const count = sellerIds.size;
              if (count <= 1) return null;
              return (
                <span className="inline-flex items-center gap-1.5 bg-accent/10 border border-accent/20 text-accent rounded-full px-3 py-1 text-xs">
                  <Leaf className="w-3 h-3" />
                  {count} nurseries
                </span>
              );
            })()}
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8 max-w-3xl space-y-8">
        {/* Continue Shopping */}
        <div className="flex">
          <a href="/products">
            <button className="px-6 py-2.5 rounded-full border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-foreground transition-colors">
              🛍️ Continue Shopping
            </button>
          </a>
        </div>

        {/* bKash payment outcome banner (Part 2 of 4) -- reflects the
            ?bkash=... query param routes/bkashPayment.ts's callback
            redirected here with. Purely informational: order.paymentStatus
            itself (read fresh from the server above, not from this query
            param) is always the source of truth for whether payment
            actually succeeded -- this banner just explains WHY the buyer
            landed back here, since bKash's own hosted page is where the
            actual payment happened, off our site. */}
        {bkashParam === "success" && order.paymentStatus === "paid" && (
          <div className="bg-success border border-success-border rounded-xl p-5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-success-foreground shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-success-foreground text-sm">Payment received</p>
                <p className="text-sm text-success-foreground mt-1">
                  Your bKash payment was successful. Thank you!
                </p>
              </div>
            </div>
          </div>
        )}
        {bkashParam && bkashParam !== "success" && order.paymentStatus === "payment_pending" && (
          <div className="bg-warning border border-warning-border rounded-xl p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-warning-foreground shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-warning-foreground text-sm">
                  {bkashParam === "cancel" || bkashParam === "cancelled"
                    ? "Payment cancelled"
                    : "Payment wasn't completed"}
                </p>
                <p className="text-sm text-warning-foreground mt-1">
                  {bkashParam === "cancel" || bkashParam === "cancelled"
                    ? "You cancelled the bKash payment. Your order is saved -- pay whenever you're ready."
                    : "Something interrupted your bKash payment. Your order is saved -- please try again below."}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Cancellation notice */}
        {order.orderStatus === "cancelled" && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-5">
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
                <span className="text-destructive text-lg">⚠️</span>
              </div>
              <div>
                <p className="font-medium text-destructive text-sm">
                  This order has been cancelled
                </p>
                {(order as any).cancellationReason ? (
                  <p className="text-sm text-destructive mt-1">
                    Reason: {(order as any).cancellationReason}
                  </p>
                ) : (
                  <p className="text-sm text-destructive mt-1">No reason provided.</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tracking steps — original horizontal progress bar, restored.
            The per-status timestamps (confirmedAt, shippedAt, deliveredAt)
            are now available on the order object for the return window
            calculation + SLA reporting. The visual UI stays as the
            compact horizontal bar the user originally designed, with
            per-step timestamps shown under each label so the buyer can
            see exactly when each milestone was reached. */}
        {order.orderStatus !== "cancelled" && order.orderStatus !== "return_completed" && (
          <div className="bg-card border rounded-xl p-6">
            <div className="flex items-baseline justify-between mb-6">
              <h2 className="font-medium">Order Progress</h2>
              {order.orderStatus === "delivered" && (ord as any).deliveredAt && (
                <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  Delivered{" "}
                  {new Date((ord as any).deliveredAt).toLocaleDateString("en-BD", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              )}
            </div>
            {/* Per-step timestamp lookup — falls back to null when the
                server hasn't recorded a timestamp for that step yet
                (e.g. confirmedAt is null until the seller confirms).
                Cast via `as any` because the generated Order type
                doesn't expose confirmedAt/shippedAt/deliveredAt (the
                API does return them — see formatOrder in
                lib/formatters.ts — but the OpenAPI spec is incomplete). */}
            {(() => {
              const tsMap: Record<string, string | null> = {
                pending: order.createdAt,
                confirmed: (ord as any).confirmedAt ?? null,
                processing: (ord as any).confirmedAt ?? null,
                shipped: (ord as any).shippedAt ?? null,
                delivered: (ord as any).deliveredAt ?? null,
              };
              return (
                <div className="flex items-center gap-0">
                  {STEPS.map((step, i) => {
                    const done = i < currentStep;
                    const active = i === currentStep;
                    const icons = [Circle, CheckCircle2, Package, Truck, Home];
                    const Icon = icons[Math.min(i, icons.length - 1)];
                    const ts = tsMap[step];
                    return (
                      <div key={step} className="flex-1 flex flex-col items-center relative">
                        {i < STEPS.length - 1 && (
                          <div
                            className={`absolute top-5 left-1/2 w-full h-0.5 ${done ? "bg-accent" : "bg-border"}`}
                          />
                        )}
                        <div
                          className={`relative z-10 h-10 w-10 rounded-full flex items-center justify-center border-2 transition-colors ${done ? "bg-accent border-accent text-accent-foreground" : active ? "bg-background border-primary" : "bg-background border-border text-muted-foreground"}`}
                        >
                          {done ? (
                            <CheckCircle2 className="h-5 w-5 text-accent-foreground" />
                          ) : (
                            <Icon className="h-5 w-5" />
                          )}
                        </div>
                        <p
                          className={`text-xs mt-2 capitalize text-center ${active ? "font-medium" : "text-muted-foreground"}`}
                        >
                          {step}
                        </p>
                        {/* Per-step timestamp — only shown when the step
                            has been reached (done or active) and the
                            server has recorded a timestamp for it. */}
                        {ts && (done || active) && (
                          <p className="text-[10px] text-muted-foreground mt-0.5 text-center">
                            {new Date(ts).toLocaleDateString("en-BD", {
                              month: "short",
                              day: "numeric",
                            })}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        )}

        {/* ── Courier tracking (shipment info) ────────────────────── */}
        {/* Shows the courier's tracking ID + a link to the courier's
            tracking page when the seller has booked a shipment via
            Pathao/Steadfast. Previously this endpoint existed but the UI
            never called it — the buyer had no way to track their package. */}
        {shipment && shipment.trackingNumber && (
          <div className="bg-card border rounded-xl p-5">
            <h3 className="font-medium text-sm mb-3 uppercase tracking-wider">Courier Tracking</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Courier</span>
                <span className="font-medium capitalize">{shipment.courierName ?? "N/A"}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Tracking Number</span>
                <span className="font-mono font-medium">{shipment.trackingNumber}</span>
              </div>
              {shipment.status && (
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Status</span>
                  <span className="capitalize">{shipment.status.replace(/_/g, " ")}</span>
                </div>
              )}
              {shipment.trackingUrl && (
                <a
                  href={shipment.trackingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-accent hover:underline mt-2"
                >
                  Track on courier's website
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          </div>
        )}

        {/* ── Sibling orders from this checkout ──────────────────────────
            When a cart has mixed payment methods (COD + Advance), it splits
            into multiple orders that share a checkoutSessionId. This section
            shows the buyer's other orders from the same checkout so they can
            navigate between them. Hidden for legacy orders (no checkoutSessionId)
            or when this is the only order from the checkout. */}
        {order.checkoutSessionId && (
          <SiblingOrdersSection
            checkoutSessionId={order.checkoutSessionId}
            currentOrderId={order.id}
          />
        )}

        {/* ── Items grouped by nursery ───────────────────────────────
            Industry-standard "shipped from" grouping — buyers see which
            nursery(s) their order came from, with each nursery's items,
            subtotal, and per-nursery courier fee broken out separately.
            Replaces the previous flat single-list "Items Ordered" block
            while keeping the same outer container styling so the page's
            visual rhythm is preserved. */}
        <div className="space-y-5">
          <div className="flex items-baseline justify-between">
            <h2 className="font-medium">Items Ordered</h2>
            <span className="text-xs text-muted-foreground">
              {(order.items ?? []).length} item{(order.items ?? []).length === 1 ? "" : "s"}{" "}
              {(() => {
                // Same source-count calc as the meta chips above —
                // surfaces "from 1 nursery" or "from N nurseries" so
                // the buyer knows upfront whether to expect one
                // delivery or several.
                const sellerIds = new Set<number>();
                (order.items ?? []).forEach((i: any) => {
                  if (i.sellerId != null) sellerIds.add(Number(i.sellerId));
                });
                const count = sellerIds.size;
                return count === 1 ? "from 1 nursery" : `from ${count} nurseries`;
              })()}
            </span>
          </div>
          {(() => {
            // Group items by their per-item sellerId. Preserves the
            // order in which each seller first appeared in the items[]
            // array so the rendering stays stable across refetches.
            // Every order item on this platform comes from a marketplace
            // seller (sellerId is always set), so every group renders
            // as a NurseryGroupCard.
            const groups: { sellerId: number; items: OrderItemRow[] }[] = [];
            for (const item of (order.items ?? []) as OrderItemRow[]) {
              if (item.sellerId == null) continue;
              const sid = Number(item.sellerId);
              let g = groups.find((g) => g.sellerId === sid);
              if (!g) {
                g = { sellerId: sid, items: [] };
                groups.push(g);
              }
              g.items.push(item);
            }
            return groups.map((g) => (
              <NurseryGroupCard
                key={g.sellerId}
                sellerId={g.sellerId}
                items={g.items}
                isGuest={isGuest}
              />
            ));
          })()}
        </div>

        {/* Summary + address */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div className="bg-card border rounded-xl p-5">
            <h3 className="font-medium text-sm mb-3 uppercase tracking-wider">Payment</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Method</span>
                <span className="capitalize">{order.paymentMethod}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <span
                  className={`capitalize ${
                    order.paymentStatus === "paid"
                      ? "text-success-foreground"
                      : order.paymentStatus === "failed" || order.paymentStatus === "refunded"
                        ? "text-destructive"
                        : "text-warning-foreground"
                  }`}
                >
                  {order.paymentStatus.replace(/_/g, " ")}
                </span>
              </div>
              {/* ── Paid-on date + transaction ID ──────────────────────
                  Industry-standard payment transparency: when the
                  payment actually settled (paidAt) and the gateway's
                  transaction ID. Hidden when the order hasn't been paid
                  yet or those fields aren't set (e.g. cash-on-delivery
                  orders won't have a transactionId). */}
              {ord.paidAt && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Paid on</span>
                  <span>
                    {new Date(ord.paidAt).toLocaleDateString("en-BD", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                </div>
              )}
              {ord.transactionId && (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground shrink-0">Transaction ID</span>
                  <span className="font-mono text-xs text-right truncate">{ord.transactionId}</span>
                </div>
              )}
              {/* Part 2 of 4: "Pay with bKash" retry action -- shown for
                  any bkash order still awaiting a completed payment,
                  whether the buyer never finished checkout's own redirect,
                  cancelled on bKash's page, or this is one of several
                  bkash orders from a multi-seller cart that checkout only
                  paid the first of (see CheckoutPage.tsx's doc comment on
                  payFirstBkashOrderOrGoToOrder). */}
              {order.paymentMethod === "bkash" && order.paymentStatus === "payment_pending" && (
                <div className="pt-1">
                  <Button
                    type="button"
                    size="sm"
                    className="w-full rounded-full"
                    onClick={handlePayWithBkash}
                    disabled={bkashRetryLoading}
                  >
                    {bkashRetryLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Redirecting...
                      </>
                    ) : (
                      <>
                        <img src={BKASH_ICON} className="h-4 w-4 mr-1.5" /> Pay with bKash
                      </>
                    )}
                  </Button>
                  {bkashRetryError && (
                    <p className="text-xs text-destructive mt-1.5">{bkashRetryError}</p>
                  )}
                </div>
              )}
              <div className="border-t pt-2 mt-1 space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>
                    Tk
                    {(order.items ?? [])
                      .reduce((s: number, i: any) => s + Number(i.price) * i.quantity, 0)
                      .toLocaleString()}
                  </span>
                </div>
                {Number(ord.discountAmount ?? 0) > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Discount{ord.couponCode ? ` (${ord.couponCode})` : ""}
                    </span>
                    <span className="text-success-foreground">
                      -Tk{Number(ord.discountAmount).toLocaleString()}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Delivery</span>
                  <span>
                    {(() => {
                      const subtotal = (order.items ?? []).reduce(
                        (s: number, i: any) => s + Number(i.price) * i.quantity,
                        0,
                      );
                      const delivery =
                        Number(order.totalAmount) - subtotal + Number(order.discountAmount ?? 0);
                      return delivery <= 0 ? (
                        <span className="text-success-foreground">Free</span>
                      ) : (
                        `Tk${delivery.toLocaleString()}`
                      );
                    })()}
                  </span>
                </div>
              </div>
              <div className="flex justify-between font-semibold border-t pt-2 mt-1">
                <span>Total</span>
                <span>Tk{order.totalAmount.toLocaleString()}</span>
              </div>
              {(() => {
                // Marketplace lines' courier fee was never part of
                // totalAmount (see routes/cart.ts / routes/orders.ts) --
                // it's snapshotted per-item as deliveryCharge and owed to
                // the seller's courier directly. Surface the order-wide
                // sum here so it isn't lost once the order is placed.
                const codDeliveryTotal = (order.items ?? []).reduce(
                  (s: number, i: any) =>
                    s + (i.sellerId != null ? Number(i.deliveryCharge ?? 0) * i.quantity : 0),
                  0,
                );
                return codDeliveryTotal > 0 ? (
                  <p className="text-xs text-muted-foreground text-right mt-1">
                    Plus Tk{codDeliveryTotal.toLocaleString()} pay on delivery for marketplace items
                  </p>
                ) : null;
              })()}
            </div>
          </div>

          {addr && (
            <div className="bg-card border rounded-xl p-5">
              <h3 className="font-medium text-sm mb-3 uppercase tracking-wider">
                Delivery Address
              </h3>
              <div className="text-sm text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">{addr.fullName}</p>
                <p>{addr.street ?? addr.line1}</p>
                <p>
                  {addr.city}
                  {addr.district ? `, ${addr.district}` : ""}
                </p>
                {addr.phone && <p>📞 {addr.phone}</p>}
              </div>
            </div>
          )}
        </div>

        {/* ── Gift Options ───────────────────────────────────────────
            Shown only when the buyer selected gift wrap or wrote a gift
            message at checkout. Both fields are snapshotted on the order
            at checkout time (see routes/orders.ts) so this stays stable
            even if the buyer later edits their gift preferences
            elsewhere. Previously these fields existed in the data but
            the order detail page never surfaced them. */}
        {(ord.giftWrap || ord.giftMessage) && (
          <div className="bg-card border rounded-xl p-5">
            <h3 className="font-medium text-sm mb-3 uppercase tracking-wider flex items-center gap-2">
              <Gift className="w-4 h-4" />
              Gift Options
            </h3>
            <div className="space-y-3 text-sm">
              {ord.giftWrap && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Gift wrap</span>
                  <span className="capitalize">
                    {ord.giftWrap === "yes" ? "Yes" : String(ord.giftWrap)}
                  </span>
                </div>
              )}
              {ord.giftMessage && (
                <div>
                  <p className="text-muted-foreground mb-1.5">Message</p>
                  <p className="italic text-foreground bg-muted/40 rounded-md p-3 border-l-2 border-accent">
                    &ldquo;{ord.giftMessage}&rdquo;
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="container mx-auto px-4 pb-10 max-w-3xl">
        {showLoginPrompt && (
          <div className="mb-3 bg-warning border border-warning-border text-warning-foreground text-sm rounded-xl px-4 py-3">
            Please{" "}
            <Link href="/sign-in" className="font-semibold underline">
              sign in
            </Link>{" "}
            or{" "}
            <Link href="/sign-up" className="font-semibold underline">
              sign up
            </Link>{" "}
            to cancel orders or request a return/refund.
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          {/* RELAXED: buyer can cancel until the order is SHIPPED (was:
              only pending). Standard e-commerce allows cancellation until
              the package leaves the seller's hands — after that, the buyer
              must use the return flow. The backend enforces the same rule. */}
          {["pending", "confirmed", "processing"].includes(order.orderStatus) && (
            <Button
              variant="outline"
              className="rounded-full gap-2 text-destructive border-destructive hover:bg-destructive/10"
              onClick={() => {
                if (isGuest) {
                  setShowLoginPrompt(true);
                  return;
                }
                setCancelOpen(true);
                setCancelReason("");
                setCancelError("");
              }}
            >
              <XCircle className="h-4 w-4" />
              Cancel Order
            </Button>
          )}
          {(order.orderStatus === "delivered" || order.orderStatus === "return_completed") &&
            (existingReturn ? (
              <div
                className={`w-full border rounded-xl px-4 py-3.5 space-y-1.5 ${getReturnStatusConfig(existingReturn.status).bannerBg}`}
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <RotateCcw
                      className={`h-4 w-4 shrink-0 ${getReturnStatusConfig(existingReturn.status).color}`}
                    />
                    <span
                      className={`text-sm font-semibold ${getReturnStatusConfig(existingReturn.status).color}`}
                    >
                      {getReturnStatusConfig(existingReturn.status).label}
                    </span>
                  </div>
                  {existingReturn.status === "completed" && existingReturn.refundAmount != null && (
                    <span className="text-sm font-bold text-success-foreground">
                      Tk{Number(existingReturn.refundAmount).toLocaleString()} refunded
                    </span>
                  )}
                </div>
                {existingReturn.status === "rejected" && existingReturn.adminNote && (
                  <p className="text-xs text-destructive">Admin note: {existingReturn.adminNote}</p>
                )}
              </div>
            ) : order.orderStatus === "delivered" ? (
              (() => {
                // BUG FIX: return window now uses `deliveredAt` (the dedicated
                // timestamp set when the order entered "delivered" status)
                // instead of `updatedAt` (which changes on every status flip
                // and was silently resetting the return window).
                // Falls back to updatedAt for legacy orders (NULL deliveredAt).
                const deliveredAt = new Date(
                  (ord as any).deliveredAt ?? (order as any).updatedAt ?? order.createdAt,
                );
                const expired = (Date.now() - deliveredAt.getTime()) / (1000 * 60 * 60 * 24) > 7;
                return expired ? (
                  <div className="w-full border border-muted-foreground/20 rounded-xl px-4 py-3 bg-muted/30">
                    <div className="flex items-center gap-2">
                      <RotateCcw className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm text-muted-foreground font-medium">
                        Return window expired
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Returns must be requested within 7 days of delivery.
                    </p>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="rounded-full gap-2"
                    onClick={() => {
                      if (isGuest) {
                        setShowLoginPrompt(true);
                        return;
                      }
                      setReturnOpen(true);
                      setReturnReason("");
                      setReturnError("");
                      setReturnSuccess(false);
                    }}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Request Return / Refund
                  </Button>
                );
              })()
            ) : null)}
        </div>
      </div>

      {/* Cancel Order Dialog */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel Order #{order.id}</DialogTitle>
            <DialogDescription>
              This action cannot be undone. Please provide a reason for cancellation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <Textarea
              placeholder="Reason for cancellation (e.g. Changed my mind, ordered by mistake?)"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              rows={3}
              maxLength={500}
              className="resize-none text-sm"
            />
            {cancelError && <p className="text-xs text-destructive">{cancelError}</p>}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1 rounded-full"
                onClick={() => setCancelOpen(false)}
              >
                Keep Order
              </Button>
              <Button
                variant="destructive"
                className="flex-1 rounded-full gap-2"
                onClick={handleCancelOrder}
                disabled={cancelLoading}
              >
                {cancelLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                Confirm Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Return Request Dialog */}
      <Dialog open={returnOpen} onOpenChange={setReturnOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Request Return / Refund</DialogTitle>
            <DialogDescription>
              Describe the issue with your order. Our team will review your request within 2-3
              business days.
            </DialogDescription>
          </DialogHeader>
          {returnSuccess ? (
            <div className="py-6 text-center space-y-2">
              <div className="h-12 w-12 rounded-full bg-success flex items-center justify-center mx-auto">
                <CheckCircle2 className="h-6 w-6 text-success-foreground" />
              </div>
              <p className="font-medium">Return request submitted!</p>
              <p className="text-sm text-muted-foreground">
                We'll review your request and get back to you soon.
              </p>
            </div>
          ) : (
            <div className="space-y-3 mt-2">
              <Textarea
                placeholder="Describe the issue (e.g. Wrong item received, product damaged, doesn't match description?)"
                value={returnReason}
                onChange={(e) => setReturnReason(e.target.value)}
                rows={4}
                maxLength={1000}
                className="resize-none text-sm"
              />
              <p className="text-xs text-muted-foreground">{returnReason.length}/1000</p>
              {returnError && <p className="text-xs text-destructive">{returnError}</p>}
              <Button
                className="w-full rounded-full gap-2"
                onClick={handleReturnRequest}
                disabled={returnLoading || returnReason.trim().length < 10}
              >
                {returnLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
                Submit Return Request
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
