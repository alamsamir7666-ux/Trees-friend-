import { useState, useEffect } from "react";
import { useParams, useSearch } from "wouter";
import { useGetOrder, useListOrders, getListOrdersQueryKey, createBkashPayment, createBkashPaymentGuest } from "@workspace/api-client-react";
import type { Order } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, Circle, Package, Truck, Home, ChevronLeft, XCircle, RotateCcw, Loader2, AlertTriangle } from "lucide-react";
import { Link } from "wouter";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";
import { BKASH_ICON } from "@/lib/preorderIcons";
import { useApiFetch } from "@/lib/useApiFetch";

interface GuestOrder {
  id: number;
  trackingId: string;
  orderStatus: string;
  paymentStatus: string;
  paymentMethod: string;
  totalAmount: number | string;
  items?: { productName: string; productImage?: string; quantity: number; price: number; [k: string]: unknown }[];
  shippingAddress?: { fullName?: string; street?: string; line1?: string; city?: string; district?: string; phone?: string } | null;
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

const STEPS = ["pending", "confirmed", "processing", "shipped", "delivered"];

const statusColors: Record<string, string> = {
  pending:          "bg-warning text-warning-foreground",
  confirmed:        "bg-info text-info-foreground",
  processing:       "bg-info text-info-foreground",
  shipped:          "bg-info text-info-foreground",
  delivered:        "bg-success text-success-foreground",
  cancelled:        "bg-destructive/10 text-destructive",
  return_completed: "bg-success text-success-foreground",
};

const returnStatusConfig: Record<string, { label: string; color: string; bg: string }> = {
  requested: { label: "Return Requested - Under Review",     color: "text-warning-foreground", bg: "bg-warning border-warning-border" },
  approved:  { label: "Return Approved - Refund Processing", color: "text-info-foreground",  bg: "bg-info border-info-border"  },
  rejected:  { label: "Return Rejected",                     color: "text-destructive",   bg: "bg-destructive/10 border-destructive/20"    },
  completed: { label: "Refund Completed",                    color: "text-success-foreground",  bg: "bg-success border-success-border"  },
};

export function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const rawId = params.id ?? "0";
  const isGuest = !/^\d+$/.test(rawId);
  const id = isGuest ? 0 : parseInt(rawId);
  const apiFetch = useApiFetch();
  const { data: orders } = useListOrders({ query: { enabled: !isGuest, queryKey: getListOrdersQueryKey() } });
  const orderRank = orders ? orders.length - orders.findIndex(o => o.id === id) : null;
  const { data: authOrder, isLoading: authLoading } = useGetOrder(id, { query: { enabled: !!id && !isGuest, queryKey: ["order", id] } });

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
      .then((data) => { if (!cancelled) setGuestOrder(data); })
      .catch(() => { if (!cancelled) setGuestOrder(null); })
      .finally(() => { if (!cancelled) setGuestLoading(false); });
    return () => { cancelled = true; };
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
    return () => { cancelled = true; };
  }, [id, apiFetch]);

  if (isLoading) {
    return <div className="container mx-auto px-4 py-10"><Skeleton className="h-96 rounded-xl" /></div>;
  }
  if (!order) {
    return <div className="py-20 text-center text-muted-foreground">Order not found.</div>;
  }

  const currentStep = STEPS.indexOf(order.orderStatus);
  const addr = order.shippingAddress as { fullName?: string; street?: string; line1?: string; city?: string; district?: string; phone?: string } | null;

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
      if (!r.ok) { setCancelError(data.error ?? "Failed to cancel order."); return; }
      setCancelOpen(false);
      window.location.reload();
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
      if (!r.ok) { setReturnError(data.error ?? "Failed to submit return request."); return; }
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
              { label: isGuest ? `Order ${order.trackingId}` : `Order #${orderRank ?? order.id}` },
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
              <h1 className="font-serif text-3xl font-medium">{isGuest ? `Order ${order.trackingId}` : `Order #${orderRank ?? order.id}`}</h1>
              <p className="text-muted-foreground mt-1 text-sm">{new Date(order.createdAt).toLocaleDateString("en-BD", { year: "numeric", month: "long", day: "numeric" })}</p>
            </div>
            <span className={`px-3 py-1.5 rounded-full text-sm font-medium ${statusColors[order.orderStatus] ?? "bg-muted"}`}>
              {order.orderStatus === "return_completed" ? "Refund Completed" : order.orderStatus.charAt(0).toUpperCase() + order.orderStatus.slice(1)}
            </span>
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
                <p className="text-sm text-success-foreground mt-1">Your bKash payment was successful. Thank you!</p>
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
                <p className="font-medium text-destructive text-sm">This order has been cancelled</p>
                {(order as any).cancellationReason ? (
                  <p className="text-sm text-destructive mt-1">Reason: {(order as any).cancellationReason}</p>
                ) : (
                  <p className="text-sm text-destructive mt-1">No reason provided.</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tracking steps */}
        {order.orderStatus !== "cancelled" && (
          <div className="bg-card border rounded-xl p-6">
            <h2 className="font-medium mb-6">Order Progress</h2>
            <div className="flex items-center gap-0">
              {STEPS.map((step, i) => {
                const done = i < currentStep;
                const active = i === currentStep;
                const icons = [Circle, CheckCircle2, Package, Truck, Home];
                const Icon = icons[Math.min(i, icons.length - 1)];
                return (
                  <div key={step} className="flex-1 flex flex-col items-center relative">
                    {i < STEPS.length - 1 && (
                      <div className={`absolute top-5 left-1/2 w-full h-0.5 ${done ? "bg-accent" : "bg-border"}`} />
                    )}
                    <div className={`relative z-10 h-10 w-10 rounded-full flex items-center justify-center border-2 transition-colors ${done ? "bg-accent border-accent text-accent-foreground" : active ? "bg-background border-primary" : "bg-background border-border text-muted-foreground"}`}>
                      {done ? <CheckCircle2 className="h-5 w-5 text-accent-foreground" /> : <Icon className="h-5 w-5" />}
                    </div>
                    <p className={`text-xs mt-2 capitalize text-center ${active ? "font-medium" : "text-muted-foreground"}`}>{step}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Items */}
        <div className="bg-card border rounded-xl p-6">
          <h2 className="font-medium mb-4">Items Ordered</h2>
          <div className="divide-y">
            {(order.items ?? []).map((item: any) => {
              const img = item.productImage ?? null;
              return (
                <div key={item.productId} className="flex gap-4 py-4 first:pt-0 last:pb-0">
                  {img ? (
                    <img src={img} alt={item.productName} className="w-16 h-16 object-cover rounded-lg shrink-0" />
                  ) : (
                    <NoImagePlaceholder className="w-16 h-16 rounded-lg shrink-0" compact />
                  )}
                  <div className="flex-1 flex justify-between items-center">
                    <div>
                      <p className="font-medium text-sm">{item.productName}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Qty: {item.quantity}</p>
                      {item.sellerId != null && Number(item.deliveryCharge) > 0 && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Pay on delivery: Tk{(Number(item.deliveryCharge) * item.quantity).toLocaleString()}
                        </p>
                      )}
                    </div>
                    <p className="font-medium text-sm">Tk{(item.price * item.quantity).toLocaleString()}</p>
                  </div>
                </div>
              );
            })}
          </div>
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
                      <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Redirecting...</>
                    ) : (
                      <><img src={BKASH_ICON} className="h-4 w-4 mr-1.5" /> Pay with bKash</>
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
                  <span>Tk{(order.items ?? []).reduce((s: number, i: any) => s + Number(i.price) * i.quantity, 0).toLocaleString()}</span>
                </div>
                {Number(ord.discountAmount ?? 0) > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Discount{ord.couponCode ? ` (${ord.couponCode})` : ""}</span>
                    <span className="text-success-foreground">-Tk{Number(ord.discountAmount).toLocaleString()}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Delivery</span>
                  <span>
                    {(() => {
                      const subtotal = (order.items ?? []).reduce((s: number, i: any) => s + Number(i.price) * i.quantity, 0);
                      const delivery = Number(order.totalAmount) - subtotal + Number(order.discountAmount ?? 0);
                      return delivery <= 0 ? <span className="text-success-foreground">Free</span> : `Tk${delivery.toLocaleString()}`;
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
                  (s: number, i: any) => s + (i.sellerId != null ? Number(i.deliveryCharge ?? 0) * i.quantity : 0),
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
              <h3 className="font-medium text-sm mb-3 uppercase tracking-wider">Delivery Address</h3>
              <div className="text-sm text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">{addr.fullName}</p>
                <p>{addr.street ?? addr.line1}</p>
                <p>{addr.city}{addr.district ? `, ${addr.district}` : ""}</p>
                {addr.phone && <p>📞 {addr.phone}</p>}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="container mx-auto px-4 pb-10 max-w-3xl">
        {showLoginPrompt && (
          <div className="mb-3 bg-warning border border-warning-border text-warning-foreground text-sm rounded-xl px-4 py-3">
            Please <Link href="/sign-in" className="font-semibold underline">sign in</Link> or{" "}
            <Link href="/sign-up" className="font-semibold underline">sign up</Link> to cancel orders or request a return/refund.
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          {order.orderStatus === "pending" && (
            <Button
              variant="outline"
              className="rounded-full gap-2 text-destructive border-destructive hover:bg-destructive/10"
              onClick={() => {
                if (isGuest) { setShowLoginPrompt(true); return; }
                setCancelOpen(true); setCancelReason(""); setCancelError("");
              }}
            >
              <XCircle className="h-4 w-4" />
              Cancel Order
            </Button>
          )}
          {(order.orderStatus === "delivered" || order.orderStatus === "return_completed") && (
            existingReturn ? (
              <div className={`w-full border rounded-xl px-4 py-3.5 space-y-1.5 ${returnStatusConfig[existingReturn.status]?.bg ?? "bg-muted/30 border-border"}`}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <RotateCcw className={`h-4 w-4 shrink-0 ${returnStatusConfig[existingReturn.status]?.color ?? ""}`} />
                    <span className={`text-sm font-semibold ${returnStatusConfig[existingReturn.status]?.color ?? ""}`}>
                      {returnStatusConfig[existingReturn.status]?.label ?? existingReturn.status}
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
            ) : order.orderStatus === "delivered" ? (() => {
              const deliveredAt = new Date((order as any).updatedAt ?? order.createdAt);
              const expired = (Date.now() - deliveredAt.getTime()) / (1000 * 60 * 60 * 24) > 7;
              return expired ? (
                <div className="w-full border border-muted-foreground/20 rounded-xl px-4 py-3 bg-muted/30">
                  <div className="flex items-center gap-2">
                    <RotateCcw className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm text-muted-foreground font-medium">Return window expired</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Returns must be requested within 7 days of delivery.</p>
                </div>
              ) : (
                <Button
                  variant="outline"
                  className="rounded-full gap-2"
                  onClick={() => {
                    if (isGuest) { setShowLoginPrompt(true); return; }
                    setReturnOpen(true); setReturnReason(""); setReturnError(""); setReturnSuccess(false);
                  }}
                >
                  <RotateCcw className="h-4 w-4" />
                  Request Return / Refund
                </Button>
              );
            })() : null
          )}
        </div>
      </div>

      {/* Cancel Order Dialog */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel Order #{orderRank ?? order.id}</DialogTitle>
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
              <Button variant="outline" className="flex-1 rounded-full" onClick={() => setCancelOpen(false)}>
                Keep Order
              </Button>
              <Button
                variant="destructive"
                className="flex-1 rounded-full gap-2"
                onClick={handleCancelOrder}
                disabled={cancelLoading}
              >
                {cancelLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
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
              Describe the issue with your order. Our team will review your request within 2-3 business days.
            </DialogDescription>
          </DialogHeader>
          {returnSuccess ? (
            <div className="py-6 text-center space-y-2">
              <div className="h-12 w-12 rounded-full bg-success flex items-center justify-center mx-auto">
                <CheckCircle2 className="h-6 w-6 text-success-foreground" />
              </div>
              <p className="font-medium">Return request submitted!</p>
              <p className="text-sm text-muted-foreground">We'll review your request and get back to you soon.</p>
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
                {returnLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                Submit Return Request
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

    </div>
  );
}
