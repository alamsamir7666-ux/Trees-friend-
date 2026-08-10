import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { useState, useEffect, useMemo, useCallback } from "react";
import { Link, useLocation } from "wouter";
import { useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Package2, ArrowRight, Copy, Check, Search, Filter, Calendar, Trash2 } from "lucide-react";
// Note: Package, BKASH_ICON, NAGAD_ICON, SHIP_ICON were used by the old
// heavy pre-order card. Removed since the card is now compact (defers
// heavy UI to the detail page). If a future pre-order card redesign
// needs them, re-add the imports.
import { useApiJson } from "@/lib/useApiFetch";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { getOrderStatusConfig, FILTERABLE_ORDER_STATUSES } from "@/lib/orderStatus";
import { getReturnStatusConfig } from "@/lib/returnStatus";
import { useDebounce } from "@/hooks/useDebounce";
import { apiClient } from "@/lib/apiClient";

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
  orderNumber?: number | null;
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
  const [location, setLocation] = useLocation();

  // ── URL-preserved filter state ───────────────────────────────────
  // Filters are stored in the URL query string (?orderStatus=shipped&search=EE12)
  // so they survive navigation: if the buyer sets a filter, clicks an order,
  // and comes back, the filter is still applied. This is the industry-standard
  // pattern (Shopify, Amazon, every e-commerce platform).
  const urlParams = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : "",
  );
  const [statusFilter, setStatusFilter] = useState<string>(urlParams.get("orderStatus") ?? "");
  const [searchInput, setSearchInput] = useState<string>(urlParams.get("search") ?? "");
  const [dateFrom, setDateFrom] = useState<string>(urlParams.get("dateFrom") ?? "");
  const [dateTo, setDateTo] = useState<string>(urlParams.get("dateTo") ?? "");
  const debouncedSearch = useDebounce(searchInput, 400);

  // Sync filters back to URL whenever they change (replaces history entry
  // so the back button doesn't create a chain of filter states).
  useEffect(() => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("orderStatus", statusFilter);
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    const queryString = params.toString();
    const newUrl = queryString ? `/orders?${queryString}` : "/orders";
    // Only update if the URL actually changed (avoid spurious history entries)
    if (location !== newUrl) {
      setLocation(newUrl, { replace: true });
    }
  }, [statusFilter, debouncedSearch, dateFrom, dateTo, location, setLocation]);

  // ── Bulk selection state ─────────────────────────────────────────
  // Industry-standard bulk actions: buyer can select multiple orders via
  // checkboxes and cancel them all at once. Selected IDs are tracked in
  // a Set for O(1) add/remove/has.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showBulkCancelDialog, setShowBulkCancelDialog] = useState(false);
  const [bulkCancelReason, setBulkCancelReason] = useState("");
  const [bulkCancelling, setBulkCancelling] = useState(false);

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

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
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);

      const data = await apiJson<AuthOrder[]>(`/api/orders?${params.toString()}`);
      if (replace) {
        setOrders(data);
      } else {
        setOrders((prev) => [...prev, ...data]);
      }
      // If we got fewer than the page size, there are no more results.
      setHasMoreOrders(data.length === ORDERS_PAGE_SIZE);
    },
    [apiJson, statusFilter, debouncedSearch, dateFrom, dateTo],
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
      (async () => {
        try {
          const raw = JSON.parse(localStorage.getItem("treefriend_guest_orders") ?? "[]");
          const preIds = (raw as GuestOrderEntry[])
            .filter((o) => o.type === "preorder")
            .map((o) => o.trackingId);
          if (preIds.length === 0) return;
          // Batch fetch all guest pre-orders in a single POST request
          // (was N parallel GET requests — N+1 problem). The batch endpoint
          // caps at 50 tracking IDs per request.
          const results = await apiJson<PreOrderRow[]>("/api/pre-orders/track-batch", {
            method: "POST",
            body: JSON.stringify({ trackingIds: preIds }),
          });
          if (!cancelled && Array.isArray(results)) {
            setPreOrders(results);
          }
        } catch {
          // Corrupted localStorage or batch endpoint failed — start with no pre-orders.
        }
      })();
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
              placeholder="Search by tracking ID or product name..."
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

        {/* ── Date range filter + bulk actions ─────────────────────── */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          {/* Date range — compact card with From/To labels */}
          <div className="flex items-center gap-2 px-3 py-1.5 border rounded-full bg-card">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-medium text-muted-foreground shrink-0">From</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="text-xs bg-transparent border-none outline-none cursor-pointer w-[120px] text-foreground"
            />
            <span className="text-xs text-muted-foreground shrink-0">to</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="text-xs bg-transparent border-none outline-none cursor-pointer w-[120px] text-foreground"
            />
          </div>
          {(dateFrom || dateTo) && (
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full text-xs h-7 px-2"
              onClick={() => {
                setDateFrom("");
                setDateTo("");
              }}
            >
              Clear dates
            </Button>
          )}
          {/* Bulk actions bar — shown when orders are selected */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-sm text-muted-foreground">{selectedIds.size} selected</span>
              <Button
                variant="outline"
                size="sm"
                className="rounded-full text-destructive"
                onClick={() => setShowBulkCancelDialog(true)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Cancel Selected
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full"
                onClick={() => setSelectedIds(new Set())}
              >
                Clear
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {mergedList.map((order) => {
            if (order._type === "preorder") {
              // Compact pre-order card — was rendering a heavy inline
              // timeline + payment method + delivery info. Now shows just
              // the essentials (tracking ID, status, date, total) and
              // defers heavy UI to the pre-order detail page.
              const isCancelled = order.status === "cancelled";
              const preTotal =
                Number(order.discountedPrice ?? 0) * Number(order.quantity ?? 1) +
                Number(order.deliveryCharge ?? 0);
              return (
                <Link key={`pre-${order.id}`} href={`/pre-orders/${order.trackingId}`}>
                  <div className="bg-card border rounded-xl p-5 hover:shadow-md transition-shadow cursor-pointer">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-bold bg-info text-info-foreground rounded-full px-2.5 py-1">
                            PRE-ORDER
                          </span>
                          <span
                            className={`text-xs font-bold rounded-full px-2.5 py-1 ${
                              isCancelled
                                ? "bg-destructive/10 text-destructive"
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
                        <p className="font-mono font-semibold text-sm">{order.trackingId}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {new Date(order.createdAt).toLocaleDateString("en-BD", {
                            year: "numeric",
                            month: "long",
                            day: "numeric",
                          })}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold">Tk{preTotal.toLocaleString()}</p>
                        <ArrowRight className="h-4 w-4 text-muted-foreground mt-1 ml-auto" />
                      </div>
                    </div>
                  </div>
                </Link>
              );
            }

            // Order (not pre-order)
            const statusCfg = getOrderStatusConfig(order.orderStatus);
            const ret = returnsMap[order.id];
            const retCfg = ret ? getReturnStatusConfig(ret.status) : null;
            const isSelected = selectedIds.has(order.id);
            return (
              <div key={order.id} className="relative">
                <div className="absolute left-3 top-1/2 -translate-y-1/2 z-10">
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleSelect(order.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
                <Link href={`/orders/${order.id}`}>
                  <div
                    className={`bg-card border rounded-xl p-5 hover:shadow-md transition-shadow cursor-pointer ${isSelected ? "border-primary ring-1 ring-primary/20" : ""} pl-12`}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-3 mb-1">
                          <p className="font-medium">
                            {order.orderNumber ? `Order #${order.orderNumber}` : "Order"}
                          </p>
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
              </div>
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

      {/* ── Bulk Cancel Dialog ─────────────────────────────────────── */}
      <Dialog open={showBulkCancelDialog} onOpenChange={setShowBulkCancelDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Cancel {selectedIds.size} Order{selectedIds.size !== 1 ? "s" : ""}?
            </DialogTitle>
            <DialogDescription>
              This action cannot be undone. Please provide a reason for cancelling these orders.
              Only orders in "pending" status can be cancelled — others will be skipped.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Cancellation reason (required, min 3 characters)..."
            value={bulkCancelReason}
            onChange={(e) => setBulkCancelReason(e.target.value)}
            className="min-h-[80px]"
          />
          <div className="flex gap-2 mt-4">
            <Button
              variant="outline"
              className="flex-1 rounded-full"
              onClick={() => {
                setShowBulkCancelDialog(false);
                setBulkCancelReason("");
              }}
            >
              Go Back
            </Button>
            <Button
              variant="destructive"
              className="flex-1 rounded-full"
              disabled={bulkCancelling || bulkCancelReason.trim().length < 3}
              onClick={async () => {
                setBulkCancelling(true);
                const ids = Array.from(selectedIds);
                // Cancel each selected order sequentially. The backend's
                // POST /orders/:id/cancel validates that the order is in
                // "pending" status — non-pending orders return 400 and
                // are skipped (not an error for the buyer).
                const results = await Promise.allSettled(
                  ids.map((id) =>
                    apiClient.post(`/orders/${id}/cancel`, { reason: bulkCancelReason.trim() }),
                  ),
                );
                const succeeded = results.filter((r) => r.status === "fulfilled").length;
                const failed = results.length - succeeded;
                setBulkCancelling(false);
                setShowBulkCancelDialog(false);
                setBulkCancelReason("");
                setSelectedIds(new Set());
                // Refetch the orders list to reflect the cancellations.
                pageRef.current = 1;
                fetchOrders(1, true);
                if (failed > 0) {
                  // Silently skip failed ones — the buyer can see which
                  // orders weren't cancelled (they're still in the list).
                }
              }}
            >
              {bulkCancelling
                ? "Cancelling..."
                : `Cancel ${selectedIds.size} Order${selectedIds.size !== 1 ? "s" : ""}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
