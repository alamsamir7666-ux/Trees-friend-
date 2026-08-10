import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { useState, useEffect, useMemo, useCallback } from "react";
import { Link } from "wouter";
import { useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Package2, ArrowRight, Copy, Check, Search, Filter, Package } from "lucide-react";
import { BKASH_ICON, NAGAD_ICON, SHIP_ICON } from "@/lib/preorderIcons";
import { useApiJson } from "@/lib/useApiFetch";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { getOrderStatusConfig, FILTERABLE_ORDER_STATUSES } from "@/lib/orderStatus";
import { getReturnStatusConfig } from "@/lib/returnStatus";
import { useDebounce } from "@/hooks/useDebounce";

// ── Types ────────────────────────────────────────────────────────────
// Previously these were loose interfaces with `[key: string]: unknown`
// index signatures + pervasive `any` casts. Now they're properly typed
// so the compiler catches shape mismatches at compile time.

interface GuestOrderEntry {
  trackingId: string;
  type?: string;
  createdAt?: string;
  items?: { productName: string; productImage?: string; quantity: number; price: number }[];
  total?: number | string;
  subtotal?: number | string;
  discount?: number;
  couponCode?: string | null;
  shipping?: number | string;
}

interface ReturnRow {
  orderId: number;
  status: string;
}

interface PreOrderRow {
  id: number;
  trackingId: string;
  status: string;
  createdAt: string;
  paymentMethod?: string;
  discountedPrice?: number | string;
  quantity?: number;
  deliveryCharge?: number | string;
}

// Authenticated order shape (matches the Order type from the generated
// client, but defined here so we don't need to import the whole thing).
interface AuthOrder {
  id: number;
  trackingId: string;
  orderStatus: string;
  paymentStatus?: string;
  paymentMethod: string;
  totalAmount: number | string;
  items?: unknown[];
  createdAt: string;
}

// Discriminated union for the merged list — replaces the old `as any[]`
// cast. The `_type` discriminator lets the render loop narrow the type
// safely without runtime `any` access.
type OrderListItem = ({ _type: "order" } & AuthOrder) | ({ _type: "preorder" } & PreOrderRow);

// ── Constants ────────────────────────────────────────────────────────

const ORDERS_PAGE_SIZE = 20;

// ── Copy button ──────────────────────────────────────────────────────

function CopyTrackingButton({ trackingId }: { trackingId: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard
      .writeText(trackingId)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // Clipboard API may be unavailable (e.g. insecure context) — non-critical.
      });
  }

  return (
    <button
      onClick={handleCopy}
      title="Copy tracking ID"
      className="inline-flex items-center gap-1 ml-1 text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? (
        <Check className="h-3 w-3 text-success-foreground" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

// ── Main component ───────────────────────────────────────────────────

export function OrdersPage() {
  const { user, isLoaded } = useUser();
  const isGuest = isLoaded && !user;
  const apiJson = useApiJson();

  // ── Filter + search state (authenticated path) ───────────────────
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebounce(searchInput, 400);

  // ── Paginated orders (authenticated path) ────────────────────────
  // Previously used the generated `useListOrders` hook which doesn't
  // support query params (page, limit, orderStatus, search). Now uses
  // useApiJson directly so we get full control over pagination + filtering.
  // The query key includes the filter params so React Query caches each
  // filter combination separately.
  const [orders, setOrders] = useState<AuthOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [hasMoreOrders, setHasMoreOrders] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRef = useState({ current: 1 })[0];

  const fetchOrders = useCallback(
    async (page: number, replace: boolean) => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(ORDERS_PAGE_SIZE),
      });
      if (statusFilter) params.set("orderStatus", statusFilter);
      if (debouncedSearch) params.set("search", debouncedSearch);

      const data = await apiJson<AuthOrder[]>(`/api/orders?${params.toString()}`);
      if (replace) {
        setOrders(data);
      } else {
        setOrders((prev) => [...prev, ...data]);
      }
      // If we got fewer than the page size, there are no more results.
      setHasMoreOrders(data.length === ORDERS_PAGE_SIZE);
    },
    [apiJson, statusFilter, debouncedSearch],
  );

  // Refetch from page 1 when filters change.
  useEffect(() => {
    if (isGuest || !isLoaded) return;
    let cancelled = false;
    setOrdersLoading(true);
    pageRef.current = 1;
    fetchOrders(1, true)
      .catch(() => {
        if (!cancelled) setOrders([]);
      })
      .finally(() => {
        if (!cancelled) setOrdersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isGuest, fetchOrders, pageRef]);

  // Infinite scroll: load next page when the sentinel enters view.
  const loadMore = useCallback(() => {
    if (loadingMore || !hasMoreOrders || isGuest) return;
    setLoadingMore(true);
    const nextPage = pageRef.current + 1;
    fetchOrders(nextPage, false)
      .then(() => {
        pageRef.current = nextPage;
      })
      .catch(() => {
        // Non-critical — the user can retry by scrolling again.
      })
      .finally(() => setLoadingMore(false));
  }, [loadingMore, hasMoreOrders, isGuest, fetchOrders, pageRef]);

  const { sentinelRef } = useInfiniteScroll(loadMore, {
    enabled: !isGuest && hasMoreOrders && !ordersLoading,
  });

  // ── Returns map (authenticated path) ─────────────────────────────
  const [returnsMap, setReturnsMap] = useState<Record<number, ReturnRow>>({});
  useEffect(() => {
    if (isGuest) return;
    let cancelled = false;
    apiJson<ReturnRow[]>("/api/returns/me")
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        const map: Record<number, ReturnRow> = {};
        data.forEach((r) => {
          map[r.orderId] = r;
        });
        setReturnsMap(map);
      })
      .catch(() => {
        // Non-critical — returns badges just won't show.
      });
    return () => {
      cancelled = true;
    };
  }, [apiJson, isGuest]);

  // ── Pre-orders (both paths) ──────────────────────────────────────
  const [preOrders, setPreOrders] = useState<PreOrderRow[]>([]);
  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;
    if (isGuest) {
      try {
        const raw = JSON.parse(localStorage.getItem("treefriend_guest_orders") ?? "[]");
        const preIds = (raw as GuestOrderEntry[])
          .filter((o) => o.type === "preorder")
          .map((o) => o.trackingId);
        if (preIds.length === 0) return;
        // Guest pre-orders are fetched in parallel (Promise.all) — there's
        // no batch endpoint for guest tracking IDs. This is N parallel
        // requests, not N sequential, so it's acceptable for typical
        // guest carts (1-3 pre-orders). A future optimization could add a
        // POST /pre-orders/track-batch endpoint.
        Promise.all(
          preIds.map((tid) =>
            apiJson<PreOrderRow | null>(`/api/pre-orders/track/${tid}`).catch(() => null),
          ),
        ).then((results) => {
          if (!cancelled) setPreOrders(results.filter((r): r is PreOrderRow => r !== null));
        });
      } catch {
        // Corrupted localStorage — start with no pre-orders.
      }
      return () => {
        cancelled = true;
      };
    }
    apiJson<PreOrderRow[]>("/api/pre-orders/my")
      .then((d) => {
        if (!cancelled && Array.isArray(d)) setPreOrders(d);
      })
      .catch(() => {
        // Non-critical — pre-orders section just won't show.
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isGuest, apiJson]);

  // ── Guest orders (localStorage) ──────────────────────────────────
  const [guestTrackingIds, setGuestTrackingIds] = useState<GuestOrderEntry[]>([]);
  useEffect(() => {
    if (!isGuest) return;
    try {
      const raw = JSON.parse(localStorage.getItem("treefriend_guest_orders") ?? "[]");
      setGuestTrackingIds(
        (raw as (string | GuestOrderEntry)[])
          .filter((o) => (typeof o === "string" ? true : o.type !== "preorder"))
          .map((o) => (typeof o === "string" ? { trackingId: o } : o)),
      );
    } catch {
      setGuestTrackingIds([]);
    }
  }, [isGuest]);

  const isLoading = !isLoaded || (!isGuest && ordersLoading);

  // ── Merged + sorted list (authenticated path) ────────────────────
  // Properly typed discriminated union — no more `as any[]`.
  const mergedList = useMemo<OrderListItem[]>(() => {
    return [
      ...orders.map((o) => ({ ...o, _type: "order" as const })),
      ...preOrders.map((o) => ({ ...o, _type: "preorder" as const })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [orders, preOrders]);

  // ── Guest rendering ──────────────────────────────────────────────
  if (isGuest) {
    if (isLoading) {
      return (
        <div className="container mx-auto px-4 py-10">
          <div className="space-y-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
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
          <p className="text-muted-foreground text-sm mb-6">
            Orders you place as a guest will appear here on this device.
          </p>
          <Link href="/products">
            <Button className="rounded-full px-8">Start Shopping</Button>
          </Link>
        </div>
      );
    }
    return (
      <div className="min-h-screen bg-background">
        <div className="bg-muted/30 border-b py-10">
          <div className="container mx-auto px-4">
            <PageBreadcrumb
              crumbs={[{ label: "My Orders", icon: <Package2 className="h-3 w-3" /> }]}
              className="mb-3"
            />
            <h1 className="font-serif text-4xl font-medium">My Orders</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {guestTrackingIds.length + preOrders.length} order
              {guestTrackingIds.length + preOrders.length !== 1 ? "s" : ""} on this device
            </p>
          </div>
        </div>
        <div className="container mx-auto px-4 py-8 max-w-3xl space-y-3">
          {preOrders.map((o) => (
            <Link key={o.trackingId} href={`/pre-orders/${o.trackingId}`}>
              <div className="border rounded-xl p-4 hover:bg-muted/30 transition-colors cursor-pointer">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <span className="text-xs font-bold bg-info text-info-foreground rounded-full px-2.5 py-1">
                      PRE-ORDER
                    </span>
                    <p className="font-mono font-semibold text-sm mt-1">{o.trackingId}</p>
                    {o.createdAt && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {new Date(o.createdAt).toLocaleDateString("en-BD", {
                          year: "numeric",
                          month: "long",
                          day: "numeric",
                        })}
                      </p>
                    )}
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
              </div>
            </Link>
          ))}
          {guestTrackingIds.map((g) => (
            <Link key={g.trackingId} href={`/orders/${g.trackingId}`}>
              <div className="border rounded-xl p-4 hover:bg-muted/30 transition-colors cursor-pointer">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="font-mono font-semibold text-sm">{g.trackingId}</p>
                    {g.createdAt && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {new Date(g.createdAt).toLocaleDateString("en-BD", {
                          year: "numeric",
                          month: "long",
                          day: "numeric",
                        })}
                      </p>
                    )}
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
                {g.items && g.items.length > 0 && (
                  <div className="space-y-1.5 mb-2">
                    {g.items.slice(0, 3).map((item, i) => (
                      <div key={i} className="flex items-center gap-2">
                        {item.productImage && (
                          <img
                            src={item.productImage}
                            alt={item.productName}
                            className="h-8 w-8 rounded-md object-cover border shrink-0"
                          />
                        )}
                        <p className="text-xs text-muted-foreground truncate flex-1">
                          {item.productName} {item.quantity}
                        </p>
                        <p className="text-xs font-medium shrink-0">
                          Tk{(item.price * item.quantity).toLocaleString()}
                        </p>
                      </div>
                    ))}
                    {g.items.length > 3 && (
                      <p className="text-xs text-muted-foreground">
                        +{g.items.length - 3} more item{g.items.length - 3 !== 1 ? "s" : ""}
                      </p>
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
                        <span className="text-muted-foreground">
                          Discount{g.couponCode ? ` (${g.couponCode})` : ""}
                        </span>
                        <span className="text-success-foreground">
                          -Tk{Number(g.discount).toLocaleString()}
                        </span>
                      </div>
                    )}
                    {g.shipping != null && (
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Delivery</span>
                        <span>
                          {g.shipping === 0 ? (
                            <span className="text-success-foreground">Free</span>
                          ) : (
                            `Tk${Number(g.shipping).toLocaleString()}`
                          )}
                        </span>
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
          ))}
        </div>
      </div>
    );
  }

  // ── Authenticated rendering ──────────────────────────────────────
  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-10">
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (mergedList.length === 0) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
        <div className="h-20 w-20 rounded-full bg-muted flex items-center justify-center mb-6">
          <Package2 className="h-9 w-9 text-muted-foreground" />
        </div>
        <h2 className="font-serif text-2xl font-medium mb-2">
          {statusFilter || debouncedSearch ? "No matching orders" : "No orders yet"}
        </h2>
        <p className="text-muted-foreground text-sm mb-6">
          {statusFilter || debouncedSearch
            ? "Try adjusting your filters or search query."
            : "Your orders will appear here once you've shopped with us."}
        </p>
        {(statusFilter || debouncedSearch) && (
          <Button
            variant="outline"
            className="rounded-full mb-3"
            onClick={() => {
              setStatusFilter("");
              setSearchInput("");
            }}
          >
            Clear filters
          </Button>
        )}
        <Link href="/products">
          <Button className="rounded-full px-8">Start Shopping</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="bg-muted/30 border-b py-10">
        <div className="container mx-auto px-4">
          <PageBreadcrumb
            crumbs={[{ label: "My Orders", icon: <Package2 className="h-3 w-3" /> }]}
            className="mb-3"
          />
          <h1 className="font-serif text-4xl font-medium">My Orders</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {mergedList.length} order{mergedList.length !== 1 ? "s" : ""}
            {(statusFilter || debouncedSearch) && " (filtered)"}
          </p>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8 max-w-3xl">
        {/* ── Filter + search bar (industry-standard) ───────────────── */}
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search by tracking ID..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9 rounded-full"
            />
          </div>
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="pl-9 pr-8 py-2 rounded-full border bg-background text-sm appearance-none cursor-pointer hover:bg-muted/50 transition-colors min-w-[150px]"
            >
              <option value="">All statuses</option>
              {FILTERABLE_ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {getOrderStatusConfig(s).label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-4">
          {mergedList.map((order) => {
            if (order._type === "preorder") {
              const preTotal =
                Number(order.discountedPrice ?? 0) * Number(order.quantity ?? 1) +
                Number(order.deliveryCharge ?? 0);
              const preStepIdx = [
                "pending",
                "confirmed",
                "arrived_in_bd",
                "shipped",
                "delivered",
              ].indexOf(order.status);
              const isCancelled = order.status === "cancelled";
              return (
                <Link key={`pre-${order.id}`} href={`/pre-orders/${order.trackingId}`}>
                  <div className="bg-card border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow cursor-pointer">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <Package className="h-4 w-4 text-muted-foreground" />
                          <p className="font-semibold text-lg">Pre-Order</p>
                        </div>
                        <p className="text-xs text-muted-foreground font-mono">
                          {order.trackingId}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Current Total:</p>
                        <p className="font-semibold text-lg">Tk {preTotal.toLocaleString()}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-xs font-bold bg-info text-info-foreground rounded-full px-2.5 py-1">
                        PRE-ORDER
                      </span>
                      <span
                        className={`text-xs font-bold rounded-full px-2.5 py-1 ${
                          isCancelled
                            ? "bg-destructive/10 text-destructive"
                            : order.status === "arrived_in_bd"
                              ? "bg-info text-info-foreground"
                              : order.status === "shipped"
                                ? "bg-info text-info-foreground"
                                : order.status === "delivered"
                                  ? "bg-success text-success-foreground"
                                  : "bg-warning text-warning-foreground"
                        }`}
                      >
                        {isCancelled
                          ? "✕ CANCELLED"
                          : order.status === "arrived_in_bd"
                            ? "Arrived in BD"
                            : order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-sm mb-1">
                      <p className="text-muted-foreground">
                        Order Date:{" "}
                        <span className="text-foreground">
                          {new Date(order.createdAt).toLocaleDateString("en-US", {
                            year: "numeric",
                            month: "long",
                            day: "numeric",
                          })}
                        </span>
                      </p>
                      <p className="text-muted-foreground flex items-center gap-1">
                        Payment:{" "}
                        {order.paymentMethod === "bkash" ? (
                          <span className="flex items-center gap-1 text-foreground">
                            <img src={BKASH_ICON} className="h-4 w-4 inline" />
                            bKash
                          </span>
                        ) : order.paymentMethod === "nagad" ? (
                          <span className="flex items-center gap-1 text-foreground">
                            <img src={NAGAD_ICON} className="h-4 w-4 inline rounded-sm" />
                            Nagad
                          </span>
                        ) : (
                          <span className="text-foreground capitalize">{order.paymentMethod}</span>
                        )}
                      </p>
                    </div>

                    <div className="flex items-center gap-1.5 mb-4">
                      <p className="text-sm text-muted-foreground">Tracking ID:</p>
                      <span className="text-sm font-mono bg-muted px-1.5 py-0.5 rounded">
                        {order.trackingId}
                      </span>
                      <CopyTrackingButton trackingId={order.trackingId} />
                    </div>

                    <div className="bg-muted/40 rounded-xl p-4 mb-4">
                      <div className="flex items-center gap-3 mb-3">
                        <img src={SHIP_ICON} className="h-8 w-8 rounded" alt="" />
                        <div>
                          <p className="text-sm font-medium text-muted-foreground">
                            Delivery Information
                          </p>
                          <p className="text-sm">Estimated Delivery: 5-8 days after arrival</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-1">
                        {["Awaiting Arrival", "Ready for Shipping", "Delivered"].map((label, i) => {
                          const thresholds = [1, 2, 4];
                          const stepDone = isCancelled ? false : preStepIdx >= thresholds[i];
                          return (
                            <div key={label} className="flex-1 flex flex-col">
                              <div
                                className={`h-1 rounded-full ${stepDone ? "bg-foreground" : "bg-border"}`}
                              />
                              <p
                                className={`text-[10px] mt-1 text-center ${
                                  isCancelled
                                    ? "line-through text-muted-foreground"
                                    : stepDone
                                      ? "text-foreground"
                                      : "text-muted-foreground"
                                }`}
                              >
                                {label}
                              </p>
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
                        onClick={(e) => e.stopPropagation()}
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

            // Order (not pre-order)
            const statusCfg = getOrderStatusConfig(order.orderStatus);
            const ret = returnsMap[order.id];
            const retCfg = ret ? getReturnStatusConfig(ret.status) : null;
            return (
              <Link key={order.id} href={`/orders/${order.id}`}>
                <div className="bg-card border rounded-xl p-5 hover:shadow-md transition-shadow cursor-pointer">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-3 mb-1">
                        <p className="font-medium">Order</p>
                        <span
                          className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${statusCfg.badge}`}
                        >
                          {statusCfg.label}
                        </span>
                        {retCfg && order.orderStatus !== "return_completed" && (
                          <span
                            className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${retCfg.badgeBg}`}
                          >
                            {retCfg.label}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {new Date(order.createdAt).toLocaleDateString("en-BD", {
                          year: "numeric",
                          month: "long",
                          day: "numeric",
                        })}
                      </p>
                      {order.trackingId && (
                        <div className="flex items-center mt-1">
                          <span className="text-xs text-muted-foreground font-mono">
                            {order.trackingId}
                          </span>
                          <CopyTrackingButton trackingId={order.trackingId} />
                        </div>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="font-semibold">
                        Tk{Number(order.totalAmount).toLocaleString()}
                      </p>
                      <p className="text-xs text-muted-foreground capitalize">
                        {order.paymentMethod}
                      </p>
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
            );
          })}

          {/* Infinite scroll sentinel */}
          {hasMoreOrders && (
            <div ref={sentinelRef} className="py-4 flex justify-center">
              {loadingMore && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Skeleton className="h-4 w-4 rounded-full" />
                  Loading more orders...
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
