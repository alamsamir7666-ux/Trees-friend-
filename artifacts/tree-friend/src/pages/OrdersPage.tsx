import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { useState, useEffect } from "react";
import { Link } from "wouter";
import { useListOrders, getListOrdersQueryKey } from "@workspace/api-client-react";
import { useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Package2, ArrowRight, Copy, Check } from "lucide-react";
import { BKASH_ICON, NAGAD_ICON, SHIP_ICON } from "@/lib/preorderIcons";
import { useApiJson } from "@/lib/useApiFetch";

interface GuestOrderEntry {
  trackingId: string;
  type?: string;
  createdAt?: string;
  [key: string]: unknown;
}

interface ReturnRow {
  orderId: number;
  status: string;
  [key: string]: unknown;
}

interface PreOrderRow {
  id: number;
  trackingId: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

const statusColors: Record<string, string> = {
  pending:          "bg-warning text-warning-foreground",
  confirmed:        "bg-info text-info-foreground",
  processing:       "bg-info text-info-foreground",
  shipped:          "bg-info text-info-foreground",
  delivered:        "bg-success text-success-foreground",
  cancelled:        "bg-destructive/10 text-destructive",
  return_completed: "bg-success text-success-foreground",
};

const returnBadgeColors: Record<string, string> = {
  requested: "bg-warning text-warning-foreground",
  approved:  "bg-info text-info-foreground",
  rejected:  "bg-destructive/10 text-destructive",
  completed: "bg-success text-success-foreground",
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
        ? <Check className="h-3 w-3 text-success-foreground" />
        : <Copy className="h-3 w-3" />
      }
    </button>
  );
}

export function OrdersPage() {
  const { user, isLoaded } = useUser();
  const isGuest = isLoaded && !user;
  const { data: orders, isLoading: ordersLoading } = useListOrders({ query: { enabled: !isGuest, queryKey: getListOrdersQueryKey() } });
  const isLoading = !isLoaded || (!isGuest && ordersLoading);
  const apiJson = useApiJson();
  const [guestTrackingIds, setGuestTrackingIds] = useState<GuestOrderEntry[]>([]);

  useEffect(() => {
    if (!isGuest) return;
    try {
      const raw = JSON.parse(localStorage.getItem("treefriend_guest_orders") ?? "[]");
      setGuestTrackingIds(
        (raw as Array<string | GuestOrderEntry>)
          .filter((o) => (typeof o === "string" ? true : o.type !== "preorder"))
          .map((o) => (typeof o === "string" ? { trackingId: o } : o))
      );
    } catch { setGuestTrackingIds([]); }
  }, [isGuest]);
  const [returnsMap, setReturnsMap] = useState<Record<number, ReturnRow>>({});

  useEffect(() => {
    if (isGuest) return;
    let cancelled = false;
    apiJson<ReturnRow[]>("/api/returns/me")
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        const map: Record<number, ReturnRow> = {};
        data.forEach((r) => { map[r.orderId] = r; });
        setReturnsMap(map);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [apiJson]);

  const [preOrders, setPreOrders] = useState<PreOrderRow[]>([]);
  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;
    if (isGuest) {
      try {
        const raw = JSON.parse(localStorage.getItem("treefriend_guest_orders") ?? "[]");
        const preIds = (raw as GuestOrderEntry[]).filter((o) => o.type === "preorder").map((o) => o.trackingId);
        if (preIds.length === 0) return;
        Promise.all(
          preIds.map((tid) =>
            apiJson<PreOrderRow | null>(`/api/pre-orders/track/${tid}`).catch(() => null)
          )
        ).then((results) => {
          if (!cancelled) setPreOrders(results.filter((r): r is PreOrderRow => r !== null));
        });
      } catch {}
      return () => { cancelled = true; };
    }
    apiJson<PreOrderRow[]>("/api/pre-orders/my")
      .then((d) => { if (!cancelled && Array.isArray(d)) setPreOrders(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isLoaded, isGuest, apiJson]);

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
                    <span className="text-xs font-bold bg-info text-info-foreground rounded-full px-2.5 py-1">PRE-ORDER</span>
                    <p className="font-mono font-semibold text-sm mt-1">{o.trackingId}</p>
                    {o.createdAt && <p className="text-xs text-muted-foreground mt-0.5">{new Date(o.createdAt).toLocaleDateString("en-BD", { year: "numeric", month: "long", day: "numeric" })}</p>}
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
              </div>
            </Link>
          ))}
          {guestTrackingIds.map((o) => {
            // `o` is `GuestOrderEntry` with an index signature returning
            // `unknown`. The guest-orders localStorage payload is a loose
            // JSON blob whose shape mirrors the public /orders/track
            // response, so we cast through `any` here for ergonomic field
            // access. This is the only place these guest rows are read.
            const g = o as GuestOrderEntry & {
              items?: Array<{ productName: string; productImage?: string; quantity: number; price: number }>;
              total?: number | string;
              subtotal?: number | string;
              discount?: number;
              couponCode?: string | null;
              shipping?: number | string;
            };
            return (
            <Link key={g.trackingId} href={`/orders/${g.trackingId}`}>
              <div className="border rounded-xl p-4 hover:bg-muted/30 transition-colors cursor-pointer">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="font-mono font-semibold text-sm">{g.trackingId}</p>
                    {g.createdAt && (
                      <p className="text-xs text-muted-foreground mt-0.5">{new Date(g.createdAt).toLocaleDateString("en-BD", { year: "numeric", month: "long", day: "numeric" })}</p>
                    )}
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
                {g.items && g.items.length > 0 && (
                  <div className="space-y-1.5 mb-2">
                    {g.items.slice(0, 3).map((item, i) => (
                      <div key={i} className="flex items-center gap-2">
                        {item.productImage && (
                          <img src={item.productImage} alt={item.productName} className="h-8 w-8 rounded-md object-cover border shrink-0" />
                        )}
                        <p className="text-xs text-muted-foreground truncate flex-1">{item.productName}  {item.quantity}</p>
                        <p className="text-xs font-medium shrink-0">Tk{(item.price * item.quantity).toLocaleString()}</p>
                      </div>
                    ))}
                    {g.items.length > 3 && (
                      <p className="text-xs text-muted-foreground">+{g.items.length - 3} more item{g.items.length - 3 !== 1 ? "s" : ""}</p>
                    )}
                  </div>
                )}
                {g.total != null && (
                  <div className="border-t pt-2 space-y-1">
                    {g.subtotal != null && (
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Subtotal</span>
                        <span>Tk{Number(g.subtotal).toLocaleString()}</span>
                      </div>
                    )}
                    {(g.discount ?? 0) > 0 && (
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Discount{g.couponCode ? ` (${g.couponCode})` : ""}</span>
                        <span className="text-success-foreground">-Tk{Number(g.discount).toLocaleString()}</span>
                      </div>
                    )}
                    {g.shipping != null && (
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Delivery</span>
                        <span>{g.shipping === 0 ? <span className="text-success-foreground">Free</span> : `Tk${Number(g.shipping).toLocaleString()}`}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-sm font-semibold pt-1">
                      <span>Total</span>
                      <span>Tk{Number(g.total).toLocaleString()}</span>
                    </div>
                  </div>
                )}
              </div>
            </Link>
            );
          })}
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
          {([
              ...(orders ?? []).map((o) => ({ ...o, _type: "order" as const })),
              ...preOrders.map((o) => ({ ...o, _type: "preorder" as const })),
            ] as any[])
              .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .map((order: any, index: number) => {
                if (order._type === "preorder") {
                  const preNum2 = preOrders.slice().sort((a,b) => a.id - b.id).findIndex((p) => p.id === order.id) + 1;
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
                        <span className="text-xs font-bold bg-info text-info-foreground rounded-full px-2.5 py-1">PRE-ORDER</span>
                        <span className={`text-xs font-bold rounded-full px-2.5 py-1 ${isCancelled ? "bg-destructive/10 text-destructive" : order.status === "arrived_in_bd" ? "bg-info text-info-foreground" : order.status === "shipped" ? "bg-info text-info-foreground" : order.status === "delivered" ? "bg-success text-success-foreground" : "bg-warning text-warning-foreground"}`}>
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
                    {order.trackingId && (
                      <div className="flex items-center mt-1">
                        <span className="text-xs text-muted-foreground font-mono">{order.trackingId}</span>
                        <CopyTrackingButton trackingId={order.trackingId} />
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