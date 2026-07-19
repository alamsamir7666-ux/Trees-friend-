import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { BKASH_ICON, NAGAD_ICON } from "@/lib/preorderIcons";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, Circle, Package, Anchor, Truck, Home, ChevronLeft, XCircle, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";

const PRE_STEPS = ["pending", "confirmed", "arrived_in_bd", "shipped", "delivered"];
const PRE_STEP_LABELS = ["Pending", "Confirmed", "Arrived in BD", "Shipped", "Delivered"];

const statusColors: Record<string, string> = {
  pending:       "bg-yellow-100 text-yellow-800",
  confirmed:     "bg-blue-100 text-blue-800",
  arrived_in_bd: "bg-purple-100 text-purple-800",
  shipped:       "bg-indigo-100 text-indigo-800",
  delivered:     "bg-green-100 text-green-800",
  cancelled:     "bg-red-100 text-red-800",
};

export function PreOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const trackingId = params.id ?? "";
  const { getToken } = useAuth();
  const [order, setOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState("");

  useEffect(() => {
    if (!trackingId) return;
    getToken().then(token => {
      fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/pre-orders/track/${trackingId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then(r => r.json())
        .then(d => setOrder(d))
        .catch(() => setOrder(null))
        .finally(() => setLoading(false));
    });
  }, [trackingId]);

  async function handleCancel() {
    if (!cancelReason.trim() || cancelReason.trim().length < 3) {
      setCancelError("Please provide a reason.");
      return;
    }
    setCancelLoading(true);
    setCancelError("");
    try {
      const token = await getToken();
      const r = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/pre-orders/${order.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: "cancelled", cancellationReason: cancelReason.trim() }),
      });
      if (!r.ok) { setCancelError("Failed to cancel."); return; }
      setCancelOpen(false);
      window.location.reload();
    } catch {
      setCancelError("Something went wrong.");
    } finally {
      setCancelLoading(false);
    }
  }

  if (loading) return <div className="container mx-auto px-4 py-10"><Skeleton className="h-96 rounded-xl" /></div>;
  if (!order || order.error) return <div className="py-20 text-center text-muted-foreground">Pre-order not found.</div>;

  const currentStep = PRE_STEPS.indexOf(order.status);
  const addr = order.shippingAddress as { fullName?: string; street?: string; city?: string; district?: string; phone?: string } | null;
  const total = Number(order.discountedPrice) * Number(order.quantity) + Number(order.deliveryCharge);

  return (
    <div className="min-h-screen bg-background">
      <div className="bg-muted/30 border-b py-10">
        <div className="container mx-auto px-4">
          <PageBreadcrumb
            crumbs={[
              { label: "My Orders", href: "/orders", icon: <Package className="h-3 w-3" /> },
              { label: `Pre-Order ${order.trackingId}` },
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
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-bold bg-blue-100 text-blue-700 rounded-full px-2 py-0.5">PRE-ORDER</span>
              </div>
              <h1 className="font-serif text-3xl font-medium">{order.trackingId}</h1>
              <p className="text-muted-foreground mt-1 text-sm">{new Date(order.createdAt).toLocaleDateString("en-BD", { year: "numeric", month: "long", day: "numeric" })}</p>
            </div>
            <span className={`px-3 py-1.5 rounded-full text-sm font-medium ${statusColors[order.status] ?? "bg-muted"}`}>
              {order.status === "arrived_in_bd" ? "Arrived in BD" : order.status.charAt(0).toUpperCase() + order.status.slice(1)}
            </span>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8 max-w-3xl space-y-8">
        <div className="flex">
          <a href="/products">
            <button className="px-6 py-2.5 rounded-full border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-foreground transition-colors">
              🛍️ Continue Shopping
            </button>
          </a>
        </div>

        {order.status === "cancelled" && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-5">
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                <span className="text-red-600 text-lg">⚠️</span>
              </div>
              <div>
                <p className="font-medium text-red-700 text-sm">This pre-order has been cancelled</p>
                {order.cancellationReason && (
                  <p className="text-sm text-red-600 mt-1">Reason: {order.cancellationReason}</p>
                )}
              </div>
            </div>
          </div>
        )}

        {order.status !== "cancelled" && (
          <div className="bg-card border rounded-xl p-6">
            <h2 className="font-medium mb-6">Pre-Order Progress</h2>
            <div className="flex items-start gap-0">
              {PRE_STEPS.map((step, i) => {
                const done = i < currentStep;
                const active = i === currentStep;
                const icons = [Circle, CheckCircle2, Anchor, Truck, Home];
                const Icon = icons[Math.min(i, icons.length - 1)];
                return (
                  <div key={step} className="flex-1 flex flex-col items-center relative">
                    {i < PRE_STEPS.length - 1 && (
                      <div className={`absolute top-5 left-1/2 w-full h-0.5 ${done ? "bg-accent" : "bg-border"}`} />
                    )}
                    <div className={`relative z-10 h-10 w-10 rounded-full flex items-center justify-center border-2 transition-colors shrink-0 ${done ? "bg-accent border-accent text-white" : active ? "bg-background border-primary" : "bg-background border-border text-muted-foreground"}`}>
                      {done ? <CheckCircle2 className="h-5 w-5 text-white" /> : <Icon className="h-5 w-5" />}
                    </div>
                    <div className="h-8 flex items-start justify-center mt-2 w-full px-0.5">
                      <p className={`text-xs text-center leading-tight ${active ? "font-medium" : "text-muted-foreground"}`}>{PRE_STEP_LABELS[i]}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="bg-card border rounded-xl p-6">
          <h2 className="font-medium mb-4">Items Ordered</h2>
          <div className="flex gap-4 py-2">
            {order.productImage && <img src={order.productImage} alt={order.productName} className="w-16 h-16 object-cover rounded-lg shrink-0" />}
            <div className="flex-1 flex justify-between items-center">
              <div>
                <p className="font-medium text-sm">{order.productName}</p>
                <p className="text-xs text-muted-foreground mt-0.5">Qty: {order.quantity}</p>
                <p className="text-xs text-muted-foreground mt-0.5">🚢 Expected: 5-8 days after arrival in BD</p>
              </div>
              <p className="font-medium text-sm">Tk{(Number(order.discountedPrice) * Number(order.quantity)).toLocaleString()}</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div className="bg-card border rounded-xl p-5">
            <h3 className="font-medium text-sm mb-3 uppercase tracking-wider">Payment</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Method</span>
                <span className="flex items-center gap-1 capitalize">{order.paymentMethod === "bkash" && <img src={BKASH_ICON} className="h-4 w-4 rounded-sm" />}{order.paymentMethod === "nagad" && <img src={NAGAD_ICON} className="h-4 w-4 rounded-sm" />}{order.paymentMethod === "bkash" ? "bKash" : order.paymentMethod === "nagad" ? "Nagad" : order.paymentMethod}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <span className={`capitalize ${order.paymentStatus === "paid" ? "text-green-600" : "text-amber-600"}`}>{order.paymentStatus}</span>
              </div>
              {order.senderNumber && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">From</span>
                  <span className="font-mono text-xs">{order.senderNumber}</span>
                </div>
              )}
              <div className="border-t pt-2 mt-1 space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Product</span>
                  <span>Tk{(Number(order.discountedPrice) * Number(order.quantity)).toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Delivery</span>
                  <span>Tk{Number(order.deliveryCharge).toLocaleString()}</span>
                </div>
              </div>
              <div className="flex justify-between font-semibold border-t pt-2 mt-1">
                <span>Total</span>
                <span>Tk{total.toLocaleString()}</span>
              </div>
            </div>
          </div>

          {addr && (
            <div className="bg-card border rounded-xl p-5">
              <h3 className="font-medium text-sm mb-3 uppercase tracking-wider">Delivery Address</h3>
              <div className="text-sm text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">{addr.fullName}</p>
                <p>{addr.street}</p>
                <p>{addr.city}{addr.district ? `, ${addr.district}` : ""}</p>
                {addr.phone && <p>📞 {addr.phone}</p>}
                {order.whatsappPhone && <p>💬 {order.whatsappPhone}</p>}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="container mx-auto px-4 pb-10 max-w-3xl">
        {order.status === "pending" && (
          <Button
            variant="outline"
            className="rounded-full gap-2 text-destructive border-destructive hover:bg-destructive/10"
            onClick={() => { setCancelOpen(true); setCancelReason(""); setCancelError(""); }}
          >
            <XCircle className="h-4 w-4" /> Cancel Pre-Order
          </Button>
        )}
      </div>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel Pre-Order</DialogTitle>
            <DialogDescription>Please provide a reason for cancellation.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <Textarea
              placeholder="Reason for cancellation..."
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              rows={3}
              maxLength={500}
              className="resize-none text-sm"
            />
            {cancelError && <p className="text-xs text-destructive">{cancelError}</p>}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1 rounded-full" onClick={() => setCancelOpen(false)}>Keep</Button>
              <Button variant="destructive" className="flex-1 rounded-full gap-2" onClick={handleCancel} disabled={cancelLoading}>
                {cancelLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                Confirm Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
