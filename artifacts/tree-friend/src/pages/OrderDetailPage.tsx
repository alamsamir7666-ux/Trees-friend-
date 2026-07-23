import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { useAuth } from "@clerk/react";
import { useGetOrder, useListOrders } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, Circle, Package, Truck, Home, ChevronLeft, XCircle, RotateCcw, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";

const STEPS = ["pending", "confirmed", "processing", "shipped", "delivered"];

const statusColors: Record<string, string> = {
  pending:          "bg-yellow-100 text-yellow-800",
  confirmed:        "bg-blue-100 text-blue-800",
  processing:       "bg-purple-100 text-purple-800",
  shipped:          "bg-indigo-100 text-indigo-800",
  delivered:        "bg-green-100 text-green-800",
  cancelled:        "bg-red-100 text-red-800",
  return_completed: "bg-teal-100 text-teal-800",
};

const returnStatusConfig: Record<string, { label: string; color: string; bg: string }> = {
  requested: { label: "Return Requested - Under Review",     color: "text-amber-700", bg: "bg-amber-50 border-amber-200" },
  approved:  { label: "Return Approved - Refund Processing", color: "text-blue-700",  bg: "bg-blue-50 border-blue-200"  },
  rejected:  { label: "Return Rejected",                     color: "text-red-700",   bg: "bg-red-50 border-red-200"    },
  completed: { label: "Refund Completed",                    color: "text-teal-700",  bg: "bg-teal-50 border-teal-200"  },
};

export function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const rawId = params.id ?? "0";
  const isGuest = !/^\d+$/.test(rawId);
  const id = isGuest ? 0 : parseInt(rawId);
  const { getToken } = useAuth();
  const { data: orders } = useListOrders({ query: { enabled: !isGuest } } as any);
  const orderRank = orders ? orders.length - orders.findIndex(o => o.id === id) : null;
  const { data: authOrder, isLoading: authLoading } = useGetOrder(id, { query: { enabled: !!id && !isGuest, queryKey: ["order", id] } });

  const [guestOrder, setGuestOrder] = useState<any>(null);
  const [guestLoading, setGuestLoading] = useState(isGuest);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);

  useEffect(() => {
    if (!isGuest) return;
    setGuestLoading(true);
    fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/orders/track/${rawId}`)
      .then(r => r.json())
      .then(data => setGuestOrder(data))
      .catch(() => setGuestOrder(null))
      .finally(() => setGuestLoading(false));
  }, [isGuest, rawId]);

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
  const [existingReturn, setExistingReturn] = useState<any>(null);

  useEffect(() => {
    if (!id || isGuest) return;
    getToken().then(token =>
      fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/returns/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json())
        .then((data: any[]) => {
          if (Array.isArray(data)) {
            const found = data.find(r => r.orderId === id);
            if (found) setExistingReturn(found);
          }
        })
        .catch(() => {})
    );
  }, [id]);

  if (isLoading) {
    return <div className="container mx-auto px-4 py-10"><Skeleton className="h-96 rounded-xl" /></div>;
  }
  if (!order) {
    return <div className="py-20 text-center text-muted-foreground">Order not found.</div>;
  }

  const currentStep = STEPS.indexOf(order.orderStatus);
  const addr = order.shippingAddress as { fullName?: string; street?: string; line1?: string; city?: string; district?: string; phone?: string } | null;

  async function handleCancelOrder() {
    if (!cancelReason.trim() || cancelReason.trim().length < 3) {
      setCancelError("Please provide a reason for cancellation.");
      return;
    }
    setCancelLoading(true);
    setCancelError("");
    try {
      const token = await getToken();
      const r = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/orders/${order.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ reason: cancelReason.trim() }),
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
    if (!returnReason.trim() || returnReason.trim().length < 10) {
      setReturnError("Please describe your reason in at least 10 characters.");
      return;
    }
    setReturnLoading(true);
    setReturnError("");
    try {
      const returnToken = await getToken();
      const r = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/returns`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${returnToken}` },
        body: JSON.stringify({ orderId: order.id, reason: returnReason.trim() }),
      });
      const data = await r.json();
      if (!r.ok) { setReturnError(data.error ?? "Failed to submit return request."); return; }
      setReturnSuccess(true);
      setExistingReturn(data);
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

        {/* Cancellation notice */}
        {order.orderStatus === "cancelled" && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-5">
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                <span className="text-red-600 text-lg">⚠️</span>
              </div>
              <div>
                <p className="font-medium text-red-700 text-sm">This order has been cancelled</p>
                {(order as any).cancellationReason ? (
                  <p className="text-sm text-red-600 mt-1">Reason: {(order as any).cancellationReason}</p>
                ) : (
                  <p className="text-sm text-red-500 mt-1">No reason provided.</p>
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
                    <div className={`relative z-10 h-10 w-10 rounded-full flex items-center justify-center border-2 transition-colors ${done ? "bg-accent border-accent text-white" : active ? "bg-background border-primary" : "bg-background border-border text-muted-foreground"}`}>
                      {done ? <CheckCircle2 className="h-5 w-5 text-white" /> : <Icon className="h-5 w-5" />}
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
                <span className="capitalize text-green-600">{order.paymentStatus}</span>
              </div>
              <div className="border-t pt-2 mt-1 space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>Tk{(order.items ?? []).reduce((s: number, i: any) => s + Number(i.price) * i.quantity, 0).toLocaleString()}</span>
                </div>
                {order.discountAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Discount{order.couponCode ? ` (${order.couponCode})` : ""}</span>
                    <span className="text-green-600">-Tk{Number(order.discountAmount).toLocaleString()}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Delivery</span>
                  <span>
                    {(() => {
                      const subtotal = (order.items ?? []).reduce((s: number, i: any) => s + Number(i.price) * i.quantity, 0);
                      const delivery = Number(order.totalAmount) - subtotal + Number(order.discountAmount ?? 0);
                      return delivery <= 0 ? <span className="text-green-600">Free</span> : `Tk${delivery.toLocaleString()}`;
                    })()}
                  </span>
                </div>
              </div>
              <div className="flex justify-between font-semibold border-t pt-2 mt-1">
                <span>Total</span>
                <span>Tk{order.totalAmount.toLocaleString()}</span>
              </div>
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
          <div className="mb-3 bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl px-4 py-3">
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
                    <span className="text-sm font-bold text-teal-700">
                      Tk{Number(existingReturn.refundAmount).toLocaleString()} refunded
                    </span>
                  )}
                </div>
                {existingReturn.status === "rejected" && existingReturn.adminNote && (
                  <p className="text-xs text-red-600">Admin note: {existingReturn.adminNote}</p>
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
              <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center mx-auto">
                <CheckCircle2 className="h-6 w-6 text-green-600" />
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
