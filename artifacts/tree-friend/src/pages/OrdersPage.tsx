import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { useState, useEffect } from "react";
import { Link } from "wouter";
import { useListOrders } from "@workspace/api-client-react";
import { useAuth, useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Package2, ArrowRight, Copy, Check } from "lucide-react";
import { BKASH_ICON, NAGAD_ICON, SHIP_ICON } from "@/lib/preorderIcons";

const statusColors: Record<string, string> = {
  pending:          "bg-yellow-100 text-yellow-800",
  confirmed:        "bg-blue-100 text-blue-800",
  processing:       "bg-purple-100 text-purple-800",
  shipped:          "bg-indigo-100 text-indigo-800",
  delivered:        "bg-green-100 text-green-800",
  cancelled:        "bg-red-100 text-red-800",
  return_completed: "bg-teal-100 text-teal-800",
};

const returnBadgeColors: Record<string, string> = {
  requested: "bg-amber-100 text-amber-700",
  approved:  "bg-blue-100 text-blue-700",
  rejected:  "bg-red-100 text-red-700",
  completed: "bg-teal-100 text-teal-700",
};

const returnBadgeLabels: Record<string, string> = {
  requested: "🔄 Return Requested",
  approved:  "✅ Return Approved",
  rejected:  "❌ Return Rejected",
  completed: "💰 Refund Completed",
};

function CopyTrackingButton({ trackingId }: { trackingId: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(trackingId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  return (
    <button
      onClick={handleCopy}
      title="Copy tracking ID"
      className="inline-flex items-center gap-1 ml-1 text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied
        ? <Check className="h-3 w-3 text-green-500" />
        : <Copy className="h-3 w-3" />
      }
    </button>
  );
}

export function OrdersPage() {
  const { user, isLoaded } = useUser();
  const isGuest = isLoaded && !user;
  const { data: orders, isLoading: ordersLoading } = useListOrders({ query: { enabled: !isGuest } } as any);
  const isLoading = !isLoaded || (!isGuest && ordersLoading);
  const { getToken } = useAuth();
  const [guestTrackingIds, setGuestTrackingIds] = useState<any[]>([]);

  useEffect(() => {
    if (!isGuest) return;
    try {
      const raw = JSON.parse(localStorage.getItem("treefriend_guest_orders") ?? "[]");
      setGuestTrackingIds(raw.filter((o: any) => o.type !== "preorder").map((o: any) => typeof o === "string" ? { trackingId: o } : o));
    } catch { setGuestTrackingIds([]); }
  }, [isGuest]);
  const [returnsMap, setReturnsMap] = useState<Record<number, any>>({});

  useEffect(() => {
    if (isGuest) return;
    getToken().then(token =>
      fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/returns/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json())
        .then((data: any[]) => {
          if (Array.isArray(data)) {
            const map: Record<number, any> = {};
            data.forEach(r => { map[r.orderId] = r; });
            setReturnsMap(map);
          }
        })
        .catch(() => {})
    );
  }, []);

  const [preOrders, setPreOrders] = useState<any[]>([]);
  useEffect(() => {
    if (!isLoaded) return;
    if (isGuest) {
      try {
        const raw = JSON.parse(localStorage.getItem("treefriend_guest_orders") ?? "[]");
        const preIds = raw.filter((o: any) => o.type === "preorder").map((o: any) => o.trackingId);
        if (preIds.length === 0) return;
        Promise.all(
          preIds.map((tid: string) =>
            fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/pre-orders/track/${tid}`)
              .then(r => r.ok ? r.json() : null).catch(() => null)
          )
        ).then(results => setPreOrders(results.filter(Boolean)));
      } catch {}
      return;
    }
    getToken().then(token => {
      if (!token) return;
      fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/pre-orders/my`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json())
        .then(d => { if (Array.isArray(d)) setPreOrders(d); })
        .catch(() => {});
    });
  }, [isLoaded, isGuest]);

  if (isGuest) {
    if (isLoading) {
      return (
        <div className="container mx-auto px-4 py-10">
          <div className="space-y-4">
            {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
          </div>
        </div>
      );
    }
    if (guestTrackingIds.length === 0 && preOrders.length === 0) {
      return (
        <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
          <div className="h-20 w-20 rounded-full bg-muted flex items-center justify-center mb-6">
            <Package2 className="h-9 w-9 text-muted-foreground" />
          </div>
          <h2 className="font-serif text-2xl font-medium mb-2">No orders yet</h2>
          <p className="text-muted-foreground text-sm mb-6">Orders you place as a guest will appear here on this device.</p>
          <Link href="/products"><Button className="rounded-full px-8">Start Shopping</Button></Link>
        </div>
      );
    }
    return (
      <div className="min-h-screen bg-background">
        <div className="bg-muted/30 border-b py-10">
          <div className="container mx-auto px-4">
            <PageBreadcrumb crumbs={[{ label: "My Orders", icon: <Package2 className="h-3 w-3" /> }]} className="mb-3" />
            <h1 className="font-serif text-4xl font-medium">My Orders</h1>
            <p className="text-muted-foreground mt-1 text-sm">{guestTrackingIds.length + preOrders.length} order{(guestTrackingIds.length + preOrders.length) !== 1 ? "s" : ""} on this device</p>
          </div>
        </div>
        <div className="container mx-auto px-4 py-8 max-w-3xl space-y-3">
          {preOrders.map((o: any) => (
            <Link key={o.trackingId} href={`/pre-orders/${o.trackingId}`}>
              <div className="border rounded-xl p-4 hover:bg-muted/30 transition-colors cursor-pointer">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <span className="text-xs font-bold bg-blue-100 text-blue-700 rounded-full px-2.5 py-1">PRE-ORDER</span>
                    <p className="font-mono font-semibold text-sm mt-1">{o.trackingId}</p>
                    {o.createdAt && <p className="text-xs text-muted-foreground mt-0.5">{new Date(o.createdAt).toLocaleDateString("en-BD", { year: "numeric", month: "long", day: "numeric" })}</p>}
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
              </div>
            </Link>
          ))}
          {guestTrackingIds.map((o) => (
            <Link key={o.trackingId} href={`/orders/${o.trackingId}`}>
              <div className="border rounded-xl p-4 hover:bg-muted/30 transition-colors cursor-pointer">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="font-mono font-semibold text-sm">{o.trackingId}</p>
                    {o.createdAt && (
                      <p className="text-xs text-muted-foreground mt-0.5">{new Date(o.createdAt).toLocaleDateString("en-BD", { year: "numeric", month: "long", day: "numeric" })}</p>
                    )}
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
                {o.items && o.items.length > 0 && (
                  <div className="space-y-1.5 mb-2">
                    {o.items.slice(0, 3).map((item: any, i: number) => (
                      <div key={i} className="flex items-center gap-2">
                        {item.productImage && (
                          <img src={item.productImage} alt={item.productName} className="h-8 w-8 rounded-md object-cover border shrink-0" />
                        )}
                        <p className="text-xs text-muted-foreground truncate flex-1">{item.productName}  {item.quantity}</p>
                        <p className="text-xs font-medium shrink-0">Tk{(item.price * item.quantity).toLocaleString()}</p>
                      </div>
                    ))}
                    {o.items.length > 3 && (
                      <p className="text-xs text-muted-foreground">+{o.items.length - 3} more item{o.items.length - 3 !== 1 ? "s" : ""}</p>
                    )}
                  </div>
                )}
                {o.total != null && (
                  <div className="border-t pt-2 space-y-1">
                    {o.subtotal != null && (
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Subtotal</span>
                        <span>Tk{Number(o.subtotal).toLocaleString()}</span>
                      </div>
                    )}
                    {o.discount > 0 && (
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Discount{o.couponCode ? ` (${o.couponCode})` : ""}</span>
                        <span className="text-green-600">-Tk{Number(o.discount).toLocaleString()}</span>
                      </div>
                    )}
                    {o.shipping != null && (
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Delivery</span>
                        <span>{o.shipping === 0 ? <span className="text-green-600">Free</span> : `Tk${Number(o.shipping).toLocaleString()}`}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-sm font-semibold pt-1">
                      <span>Total</span>
                      <span>Tk{Number(o.total).toLocaleString()}</span>
                    </div>
                  </div>
                )}
              </div>
            </Link>
          ))}
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-10">
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (!orders || orders.length === 0) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
        <div className="h-20 w-20 rounded-full bg-muted flex items-center justify-center mb-6">
          <Package2 className="h-9 w-9 text-muted-foreground" />
        </div>
        <h2 className="font-serif text-2xl font-medium mb-2">No orders yet</h2>
        <p className="text-muted-foreground text-sm mb-6">Your orders will appear here once you've shopped with us.</p>
        <Link href="/products"><Button className="rounded-full px-8">Start Shopping</Button></Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="bg-muted/30 border-b py-10">
        <div className="container mx-auto px-4">
          <PageBreadcrumb crumbs={[{ label: "My Orders", icon: <Package2 className="h-3 w-3" /> }]} className="mb-3" />
          <h1 className="font-serif text-4xl font-medium">My Orders</h1>
          <p className="text-muted-foreground mt-1 text-sm">{(orders?.length ?? 0) + preOrders.length} order{((orders?.length ?? 0) + preOrders.length) !== 1 ? "s" : ""}</p>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8 max-w-3xl">
        <div className="space-y-4">
          {[...(orders ?? []).map((o: any) => ({ ...o, _type: "order" })), ...preOrders.map((o: any) => ({ ...o, _type: "preorder" }))]
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .map((order, index) => {
                if ((order as any)._type === "preorder") {
                  const preNum2 = preOrders.slice().sort((a,b) => a.id - b.id).findIndex((p: any) => p.id === order.id) + 1;
                  const preTotal = Number(order.discountedPrice) * Number(order.quantity) + Number(order.deliveryCharge);
                  const preStepIdx = ["pending","confirmed","arrived_in_bd","shipped","delivered"].indexOf(order.status);
                  const isCancelled = order.status === "cancelled";
                  return (
                    <Link key={`pre-${order.id}`} href={`/pre-orders/${order.trackingId}`}>
                    <div className="bg-card border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow cursor-pointer">
                      <div className="flex items-start justify-between mb-3">
                        <p className="font-semibold text-lg">Pre-Order #{preNum2}</p>
                        <div className="text-right">
                          <p className="text-xs text-muted-foreground">Current Total:</p>
                          <p className="font-semibold text-lg">Tk {preTotal.toLocaleString()}</p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-xs font-bold bg-blue-100 text-blue-700 rounded-full px-2.5 py-1">PRE-ORDER</span>
                        <span className={`text-xs font-bold rounded-full px-2.5 py-1 ${isCancelled ? "bg-red-100 text-red-700" : order.status === "arrived_in_bd" ? "bg-purple-100 text-purple-700" : order.status === "shipped" ? "bg-indigo-100 text-indigo-700" : order.status === "delivered" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-800"}`}>
                          {isCancelled ? "✕ CANCELLED" : order.status === "arrived_in_bd" ? "Arrived in BD" : order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-sm mb-1">
                        <p className="text-muted-foreground">Order Date: <span className="text-foreground">{new Date(order.createdAt).toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" })}</span></p>
                        <p className="text-muted-foreground flex items-center gap-1">Payment: {order.paymentMethod === "bkash" ? <span className="flex items-center gap-1 text-foreground"><img src={BKASH_ICON} className="h-4 w-4 inline" />bKash</span> : order.paymentMethod === "nagad" ? <span className="flex items-center gap-1 text-foreground"><img src={NAGAD_ICON} className="h-4 w-4 inline rounded-sm" />Nagad</span> : <span className="text-foreground capitalize">{order.paymentMethod}</span>}</p>
                      </div>

                      <div className="flex items-center gap-1.5 mb-4">
                        <p className="text-sm text-muted-foreground">Tracking ID:</p>
                        <span className="text-sm font-mono bg-muted px-1.5 py-0.5 rounded">{order.trackingId}</span>
                        <CopyTrackingButton trackingId={order.trackingId} />
                      </div>

                      <div className="bg-muted/40 rounded-xl p-4 mb-4">
                        <div className="flex items-center gap-3 mb-3">
                          <img src={SHIP_ICON} className="h-8 w-8 rounded" />
                          <div>
                            <p className="text-sm font-medium text-muted-foreground">Delivery Information</p>
                            <p className="text-sm">Estimated Delivery: 5-8 days after arrival</p>
                          </div>
                        </div>
                        <div className="flex items-start gap-1">
                          {["Awaiting Arrival","Ready for Shipping","Delivered"].map((label, i) => {
                            const thresholds = [1, 2, 4];
                            const stepDone = isCancelled ? false : preStepIdx >= thresholds[i];
                            return (
                              <div key={label} className="flex-1 flex flex-col">
                                <div className={`h-1 rounded-full ${stepDone ? "bg-foreground" : "bg-border"}`} />
                                <p className={`text-[10px] mt-1 text-center ${isCancelled ? "line-through text-muted-foreground" : stepDone ? "text-foreground" : "text-muted-foreground"}`}>{label}</p>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-1">
                        <a
                          href="https://wa.me/8801636575741"
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="text-sm text-muted-foreground flex items-center gap-1 hover:text-foreground"
                        >
                          Contact Support
                        </a>
                        <span className="text-sm font-medium bg-muted px-3 py-1.5 rounded-full flex items-center gap-1">
                          View Details <ArrowRight className="h-3.5 w-3.5" />
                        </span>
                      </div>
                    </div>
                    </Link>
                  );
                }
                const rank = (orders ?? []).length - (orders ?? []).findIndex((o: any) => o.id === order.id);
                return (
            <Link key={order.id} href={`/orders/${order.id}?rank=${rank}`}>
              <div className="bg-card border rounded-xl p-5 hover:shadow-md transition-shadow cursor-pointer">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-3 mb-1">
                      <p className="font-medium">Order #{rank}</p>
                      <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[order.orderStatus] ?? "bg-muted"}`}>
                        {order.orderStatus === "return_completed" ? "Refund Completed" : order.orderStatus.charAt(0).toUpperCase() + order.orderStatus.slice(1)}
                      </span>
                      {returnsMap[order.id] && order.orderStatus !== "return_completed" && (
                        <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${returnBadgeColors[returnsMap[order.id].status] ?? "bg-muted"}`}>
                          {returnBadgeLabels[returnsMap[order.id].status] ?? "? Return"}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{new Date(order.createdAt).toLocaleDateString("en-BD", { year: "numeric", month: "long", day: "numeric" })}</p>
                    {(order as any).trackingId && (
                      <div className="flex items-center mt-1">
                        <span className="text-xs text-muted-foreground font-mono">{(order as any).trackingId}</span>
                        <CopyTrackingButton trackingId={(order as any).trackingId} />
                      </div>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="font-semibold">Tk{order.totalAmount.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground capitalize">{order.paymentMethod}</p>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    {order.items?.length ?? 0} item{(order.items?.length ?? 0) !== 1 ? "s" : ""}
                  </p>
                  <span className="text-xs text-muted-foreground flex items-center gap-1 hover:text-foreground">
                    View details <ArrowRight className="h-3 w-3" />
                  </span>
                </div>
              </div>
            </Link>
          )}
          )}
        </div>
      </div>

  </div>
  );
}