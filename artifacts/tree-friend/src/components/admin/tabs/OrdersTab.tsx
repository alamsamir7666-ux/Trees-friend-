import { useAdminContext } from "@/contexts/AdminContext";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, ChevronDown, MapPin, AlertCircle, Mail, Phone, Store, ShoppingBag, Clock, CheckCircle2, XCircle, Banknote } from "lucide-react";
import { apiClient } from "@/lib/apiClient";

const API = import.meta.env.VITE_API_BASE_URL ?? "";

// Seller status badge palette. Mirrors the sellersTable.status enum
// (pending_verification | active | suspended | vacation). Anything
// unexpected falls back to gray.
const SELLER_STATUS_STYLE: Record<string, string> = {
  active: "bg-success text-success-foreground border-success-border",
  pending_verification: "bg-warning text-warning-foreground border-warning-border",
  suspended: "bg-destructive/10 text-destructive border-destructive/20",
  vacation: "bg-info text-info-foreground border-info-border",
};
const SELLER_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  pending_verification: "Pending",
  suspended: "Suspended",
  vacation: "On vacation",
};

// Lightweight seller list shape returned by /admin/sellers -- only the
// fields the filter dropdown needs. Defined locally rather than importing
// a generated type because admin.ts isn't in the orval spec yet (see
// lib/api-spec/openapi.yaml).
type SellerLite = {
  id: number;
  businessName: string;
  status: string;
};

/**
 * Admin Orders tab — redesigned post-Phase-2 marketplace migration.
 *
 * Reality: orders now fully belong to sellers. Sellers create the
 * listings, set prices, set delivery charges, control quantity, and
 * fulfill the order end-to-end. The admin's role is OVERSIGHT — see
 * who bought what from which seller, spot stuck orders, contact the
 * seller when something needs human intervention — NOT fulfillment.
 *
 * Concrete changes vs. the pre-redesign tab:
 * - REMOVED the "Update" status dropdown. Admin can no longer flip an
 *   order to "shipped" / "delivered" — that's the seller's job via
 *   /seller/orders/:id/status. Letting admin do it was misleading
 *   (the seller would never see the change in their dashboard's
 *   status timeline) and conflicted with the marketplace split.
 * - ADDED a "Seller" column showing business name + status badge, so
 *   admin can see at a glance who is responsible for each order.
 * - ADDED a seller filter dropdown (populated from /admin/sellers)
 *   so admin can scope the list to one seller's orders.
 * - ADDED a summary stats bar at the top: total / pending / delivered
 *   / GMV. Computed client-side from the already-loaded page of
 *   orders (no new endpoint), which matches how the existing
 *   status tabs already worked.
 * - REPLACED the "Update" column with an "Actions" column: a
 *   "Contact seller" mailto: link (the legitimate admin
 *   intervention when an order is stuck and the seller isn't
 *   responding) plus the row-expand chevron hint.
 * - REWORKED the expanded view to lead with "Fulfilled by
 *   {sellerName}" + seller contact info (email + phone), so admin
 *   has everything they need to intervene in one place.
 *
 * The pre-order branch keeps its existing inline status dropdown
 * for now — pre-orders are a separate code path with a different
 * status enum, and rewriting that is out of scope for this pass.
 * Flagged as an open item.
 */
export function OrdersTab() {
  const {
    filteredOrders,
    ordersLoading,
    ordersHasMore,
    ordersTotal,
    ordersPage,
    expandedOrderId,
    setExpandedOrderId,
    orderSearch,
    setOrderSearch,
    cancelModal,
    setCancelModal,
    askConfirm,
    getToken,
    statusConfig,
    fetchOrders,
    fetchAdminPreOrders,
    orders,
  } = useAdminContext();

  // Seller list for the filter dropdown. Fetched once on mount, never
  // refetched -- new sellers mid-session aren't worth a refetch loop.
  const [sellers, setSellers] = useState<SellerLite[]>([]);
  const [sellersLoading, setSellersLoading] = useState(true);
  const [sellerFilter, setSellerFilter] = useState<number | "all">("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await apiClient.get<SellerLite[]>("/api/admin/sellers");
        if (!cancelled) {
          // Only sellers that actually have orders will appear in the
          // dropdown's filtered state, but showing all of them in the
          // raw dropdown is fine -- admin may want to check a brand-new
          // seller with zero orders too. Sort by businessName for
          // predictable scanning.
          setSellers((data ?? []).slice().sort((a, b) => a.businessName.localeCompare(b.businessName)));
        }
      } catch {
        if (!cancelled) setSellers([]);
      } finally {
        if (!cancelled) setSellersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply the seller filter on top of AdminContext's `filteredOrders`
  // (which already carries the search + status-pill filter logic). Kept
  // local to this tab so we don't leak seller-filter state into the
  // shared context (no other tab needs it).
  const visibleOrders = useMemo(() => {
    if (sellerFilter === "all") return filteredOrders;
    return filteredOrders.filter((o: any) => Number(o.sellerId) === sellerFilter);
  }, [filteredOrders, sellerFilter]);

  // Summary stats — computed from the page of orders already in `orders`,
  // NOT from `filteredOrders`. This matches the existing tab's behavior
  // (the pills at the top filter the displayed list, but the underlying
  // page is `orders`). Stats reflect the unfiltered page so admin always
  // sees the true health of the slice they're viewing.
  const stats = useMemo(() => {
    let pending = 0;
    let delivered = 0;
    let cancelled = 0;
    let gmv = 0;
    for (const o of orders as any[]) {
      if (o._type === "preorder") continue;
      const status = o.orderStatus;
      if (status === "pending") pending++;
      if (status === "delivered") {
        delivered++;
        gmv += Number(o.totalAmount ?? o.discountedPrice ?? 0);
      }
      if (status === "cancelled") cancelled++;
    }
    return { total: orders.filter((o: any) => o._type !== "preorder").length, pending, delivered, cancelled, gmv };
  }, [orders]);

  return (
    <div>
      {/* Summary stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <StatCard label="Orders on page" value={String(stats.total)} icon={<ShoppingBag className="h-4 w-4" />} tint="text-foreground" />
        <StatCard label="Pending" value={String(stats.pending)} icon={<Clock className="h-4 w-4" />} tint="text-warning-foreground" />
        <StatCard label="Delivered" value={String(stats.delivered)} icon={<CheckCircle2 className="h-4 w-4" />} tint="text-success-foreground" />
        <StatCard label="GMV (delivered)" value={`Tk${stats.gmv.toLocaleString()}`} icon={<Banknote className="h-4 w-4" />} tint="text-foreground" />
      </div>

      {/* Toolbar: search + status pills + seller filter */}
      <div className="flex flex-wrap items-center justify-between mb-4 gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
          <Input
            placeholder="Search by order ID, customer, or status..."
            value={orderSearch}
            onChange={(e) => setOrderSearch(e.target.value)}
            className="pl-9 rounded-xl"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Status pills */}
          <div className="flex gap-1.5 bg-muted p-1 rounded-xl">
            {["all", "pending", "delivered"].map((s) => (
              <button
                key={s}
                onClick={() => setOrderSearch(s === "all" ? "" : s)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${
                  (s === "all" && !orderSearch) || orderSearch === s
                    ? "bg-card text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          {/* Seller filter */}
          <select
            value={sellerFilter === "all" ? "all" : String(sellerFilter)}
            onChange={(e) => setSellerFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
            disabled={sellersLoading}
            className="h-9 rounded-xl border border-border bg-card px-3 pr-8 text-xs font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
            aria-label="Filter by seller"
          >
            <option value="all">{sellersLoading ? "Loading sellers…" : "All sellers"}</option>
            {sellers.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.businessName} {s.status !== "active" ? `· ${SELLER_STATUS_LABEL[s.status] ?? s.status}` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Empty-state for seller filter with no matches */}
      {sellerFilter !== "all" && visibleOrders.length === 0 && !ordersLoading && (
        <div className="bg-warning border border-warning-border rounded-xl p-4 mb-4 text-sm text-warning-foreground flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            No orders on this page match the selected seller. The seller may
            have no orders in the current page, or all of their orders are
            already archived. Switch the seller filter back to "All sellers"
            to see everything.
          </div>
        </div>
      )}

      {ordersLoading ? (
        <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
      ) : (
        <div className="bg-card rounded-2xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Order</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Customer</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Seller</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Date</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Payment</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="px-4 py-3.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Total</th>
                  <th className="px-4 py-3.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-muted/50">
                {visibleOrders.map((o) => {
                  if ((o as any)._type === "preorder") {
                    const isPreExpanded = expandedOrderId === `pre-${o.id}`;
                    // Pre-orders now carry seller fields via the new
                    // /admin/pre-orders endpoint (joined through
                    // sellerListingVariantId -> variant -> listing ->
                    // seller). Render the Seller column the same way the
                    // regular-orders branch does, falling back to
                    // "Unknown seller" only for legacy pre-Phase-6 rows
                    // (null sellerListingVariantId) or deleted sellers.
                    const preSellerName = (o as any).sellerBusinessName ?? null;
                    const preSellerStatus = (o as any).sellerStatus ?? null;
                    const preSellerEmail = (o as any).sellerContactEmail ?? null;
                    return (
                      <Fragment key={`pre-${o.id}`}>
                        <tr className="hover:bg-info/10 transition-colors cursor-pointer" onClick={() => setExpandedOrderId(isPreExpanded ? null : `pre-${o.id}`)}>
                          <td className="px-4 py-3.5">
                            <div className="flex items-center gap-1.5">
                              <ChevronDown className={`h-3.5 w-3.5 text-info-foreground/70 transition-transform shrink-0 ${isPreExpanded ? "rotate-180" : ""}`} />
                              <div>
                                <span className="text-xs font-bold bg-info text-info-foreground rounded-full px-2 py-0.5">PRE-ORDER</span>
                                <p className="text-xs font-mono text-muted-foreground mt-0.5">{o.trackingId}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3.5">
                            <p className="font-medium text-foreground text-xs">{o.shippingAddress?.fullName ?? "Guest"}</p>
                            <p className="text-xs text-muted-foreground/70">{o.whatsappPhone ?? o.shippingAddress?.phone}</p>
                          </td>
                          {/* Seller column for pre-orders — same shape as the
                              regular-orders branch below. Pre-orders without
                              a sellerListingVariantId (legacy pre-Phase-6 rows)
                              will have null seller fields and show "Unknown seller". */}
                          <td className="px-4 py-3.5">
                            {preSellerName ? (
                              <div className="flex flex-col gap-1 min-w-0">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <Store className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
                                  <span className="text-xs font-medium text-foreground truncate" title={preSellerName}>{preSellerName}</span>
                                </div>
                                {preSellerStatus && (
                                  <span className={`w-fit px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${SELLER_STATUS_STYLE[preSellerStatus] ?? "bg-muted text-muted-foreground border-border"}`}>
                                    {SELLER_STATUS_LABEL[preSellerStatus] ?? preSellerStatus}
                                  </span>
                                )}
                                {preSellerEmail && (
                                  <a
                                    href={`mailto:${preSellerEmail}?subject=${encodeURIComponent(`Pre-order #${o.id} — Tree Friend admin follow-up`)}&body=${encodeURIComponent(`Hi ${preSellerName},\n\nThis is the Tree friend admin team. We're reaching out about pre-order #${o.id} (tracking: ${o.trackingId}).\n\nPlease advise on the current status.\n\nThanks,\nTree Friend Admin`)}`}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-foreground bg-muted hover:bg-info/10 hover:text-info-foreground border border-border transition-colors"
                                    title={`Email ${preSellerEmail}`}
                                    onClick={(e) => e.stopPropagation()}
                  >
                                    <Mail className="h-3 w-3" />
                                    <span className="hidden sm:inline">Contact</span>
                                  </a>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground/70 italic" title="Legacy pre-order from before Phase 6, or seller record deleted">Unknown seller</span>
                            )}
                          </td>
                          <td className="px-4 py-3.5 text-xs text-muted-foreground">{new Date(o.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</td>
                          <td className="px-4 py-3.5">
                            <span className="text-xs bg-muted px-2 py-1 rounded-lg font-medium text-muted-foreground capitalize">{o.paymentMethod}</span>
                          </td>
                          <td className="px-4 py-3.5">
                            <span className={`flex items-center gap-1.5 w-fit px-2.5 py-1 rounded-full text-xs font-medium border ${
                              o.status === "delivered" ? "bg-success text-success-foreground border-success-border" :
                              o.status === "cancelled" ? "bg-destructive/10 text-destructive border-destructive/20" :
                              o.status === "shipped" ? "bg-info text-info-foreground border-info-border" :
                              o.status === "arrived_in_bd" ? "bg-info text-info-foreground border-info-border" :
                              o.status === "confirmed" ? "bg-success text-success-foreground border-success-border" :
                              "bg-warning text-warning-foreground border-warning-border"
                            }`}>{o.status === "arrived_in_bd" ? "Arrived in BD" : o.status.charAt(0).toUpperCase() + o.status.slice(1)}</span>
                          </td>
                          <td className="px-4 py-3.5 text-right font-semibold text-foreground">Tk{(Number(o.discountedPrice) * Number(o.quantity) + Number(o.deliveryCharge)).toLocaleString()}</td>
                          <td className="px-4 py-3.5 text-right text-xs text-muted-foreground/70 italic">pre-order</td>
                        </tr>
                        {isPreExpanded && (
                          <tr key={`pre-${o.id}-expanded`} className="bg-info/10">
                            <td colSpan={8} className="px-8 py-4">
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-sm">
                                <div>
                                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                    <MapPin className="h-3.5 w-3.5" /> Shipping Address
                                  </p>
                                  <p className="font-medium text-foreground">{o.shippingAddress?.fullName}</p>
                                  <p className="text-muted-foreground text-xs">{o.shippingAddress?.street}</p>
                                  <p className="text-muted-foreground text-xs">{o.shippingAddress?.city}{o.shippingAddress?.district ? `, ${o.shippingAddress.district}` : ""}</p>
                                  {o.shippingAddress?.phone && <p className="text-muted-foreground text-xs mt-0.5">📞 {o.shippingAddress.phone}</p>}
                                  {o.whatsappPhone && <p className="text-muted-foreground text-xs mt-0.5">💬 WhatsApp: {o.whatsappPhone}</p>}
                                </div>
                                <div>
                                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Product</p>
                                  <p className="text-xs text-muted-foreground">{o.productName} × {o.quantity}</p>
                                  <p className="text-xs text-muted-foreground mt-1">Price: Tk{Number(o.discountedPrice).toLocaleString()}</p>
                                  <p className="text-xs text-muted-foreground">Delivery: Tk{Number(o.deliveryCharge).toLocaleString()}</p>
                                  <p className="text-xs font-semibold text-foreground mt-1">Total: Tk{(Number(o.discountedPrice) * Number(o.quantity) + Number(o.deliveryCharge)).toLocaleString()}</p>
                                </div>
                                <div>
                                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Payment Info</p>
                                  <p className="text-xs text-muted-foreground capitalize">Method: {o.paymentMethod}</p>
                                  <p className={`text-xs capitalize ${o.paymentStatus === "paid" ? "text-success-foreground" : "text-warning-foreground"}`}>Status: {o.paymentStatus}</p>
                                  {o.senderNumber && <p className="text-xs text-muted-foreground mt-1">From: <span className="font-mono">{o.senderNumber}</span></p>}
                                  {o.transactionId && <p className="text-xs text-muted-foreground font-mono mt-1">TxID: {o.transactionId}</p>}
                                  {o.status === "cancelled" && o.cancellationReason && (
                                    <div className="mt-2 bg-destructive/10 border border-destructive/20 rounded-lg p-2">
                                      <p className="text-xs font-semibold text-destructive">Cancel Reason:</p>
                                      <p className="text-xs text-destructive mt-0.5">{o.cancellationReason}</p>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  }
                  const cfg = statusConfig[o.orderStatus] ?? { color: "bg-muted text-muted-foreground border-border", icon: AlertCircle };
                  const StatusIcon = cfg.icon;
                  const isExpanded = expandedOrderId === o.id;
                  const addr = (o as any).shippingAddress as { fullName?: string; street?: string; line1?: string; city?: string; district?: string; phone?: string } | null;
                  const sellerName = (o as any).sellerBusinessName ?? null;
                  const sellerOwnerName = (o as any).sellerOwnerName ?? null;
                  const sellerEmail = (o as any).sellerContactEmail ?? null;
                  const sellerPhone = (o as any).sellerContactPhone ?? null;
                  const sellerStatus = (o as any).sellerStatus ?? null;
                  const itemTotal = ((o as any).items ?? []).reduce((n: number, it: any) => n + (it.quantity ?? 0), 0);
                  return (
                    <Fragment key={o.id}>
                      <tr className="hover:bg-primary/5 transition-colors cursor-pointer" onClick={() => setExpandedOrderId(isExpanded ? null : o.id)}>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-1.5">
                            <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground/70 transition-transform shrink-0 ${isExpanded ? "rotate-180" : ""}`} />
                            <div>
                              <p className="font-semibold text-foreground">#{o.id}</p>
                              {(o as any).trackingId && <p className="text-xs text-muted-foreground/70 font-mono">{(o as any).trackingId}</p>}
                              {itemTotal > 0 && <p className="text-[11px] text-muted-foreground/70 mt-0.5">{itemTotal} item{itemTotal === 1 ? "" : "s"}</p>}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3.5">
                          {(o as any).userName ? (
                            <div>
                              <p className="font-medium text-foreground text-xs">{(o as any).userName}</p>
                              {!(o as any).userEmail?.endsWith("@clerk.user") && (o as any).userEmail && (
                                <p className="text-xs text-muted-foreground/70">{(o as any).userEmail}</p>
                              )}
                            </div>
                          ) : (o as any).shippingAddress?.fullName ? (
                            <p className="text-xs text-muted-foreground">{(o as any).shippingAddress.fullName}</p>
                          ) : (
                            <p className="text-xs text-muted-foreground/70">-</p>
                          )}
                        </td>
                        {/* Seller column — the headline addition. Shows
                            business name + a status pill so admin can
                            tell at a glance if a stuck order is because
                            the seller is suspended / on vacation. */}
                        <td className="px-4 py-3.5">
                          {sellerName ? (
                            <div className="flex flex-col gap-1 min-w-0">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <Store className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
                                <span className="text-xs font-medium text-foreground truncate" title={sellerName}>{sellerName}</span>
                              </div>
                              {sellerStatus && (
                                <span className={`w-fit px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${SELLER_STATUS_STYLE[sellerStatus] ?? "bg-muted text-muted-foreground border-border"}`}>
                                  {SELLER_STATUS_LABEL[sellerStatus] ?? sellerStatus}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground/70 italic" title="Legacy order from before the marketplace migration, or seller record deleted">Unknown seller</span>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-muted-foreground text-xs">{new Date(o.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</td>
                        <td className="px-4 py-3.5">
                          <span className="text-xs bg-muted px-2 py-1 rounded-lg font-medium text-muted-foreground capitalize">{(o as any).paymentMethod ?? "-"}</span>
                        </td>
                        <td className="px-4 py-3.5">
                          <span className={`flex items-center gap-1.5 w-fit px-2.5 py-1 rounded-full text-xs font-medium border ${cfg.color}`}>
                            <StatusIcon className="h-3 w-3" />{o.orderStatus === "return_completed" ? "Refund Completed" : o.orderStatus}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 text-right font-semibold text-foreground">Tk{Number((o as any).totalAmount ?? (o as any).discountedPrice ?? 0).toLocaleString()}</td>
                        {/* Actions column — replaces the old "Update"
                            status dropdown. Admin shouldn't be the one
                            flipping fulfillment status post-Phase-2;
                            the seller does that. Admin's legitimate
                            intervention when an order is stuck is to
                            contact the seller directly, so we expose
                            that as a mailto: link. The whole row still
                            expands on click for full details. */}
                        <td className="px-4 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            {sellerEmail ? (
                              <a
                                href={`mailto:${sellerEmail}?subject=${encodeURIComponent(`Order #${o.id} — Tree Friend admin follow-up`)}&body=${encodeURIComponent(`Hi ${sellerOwnerName ?? sellerName},\n\nThis is the Tree Friend admin team. We're reaching out about order #${o.id} (tracking: ${(o as any).trackingId ?? "n/a"}).\n\nPlease advise on the current status.\n\nThanks,\nTree Friend Admin`)}`}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-foreground bg-muted hover:bg-primary/10 hover:text-primary border border-border transition-colors"
                                title={`Email ${sellerEmail}`}
                              >
                                <Mail className="h-3 w-3" />
                                <span className="hidden sm:inline">Contact</span>
                              </a>
                            ) : (
                              <span className="text-xs text-muted-foreground/50 italic" title="No seller email on file">No contact</span>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${o.id}-expanded`} className="bg-primary/5">
                          <td colSpan={8} className="px-8 py-4">
                            {/* "Fulfilled by" header — leads the expanded
                                view so admin instantly knows which seller
                                is responsible before reading the rest. */}
                            {sellerName && (
                              <div className="mb-5 pb-4 border-b border-primary/20 flex flex-wrap items-center gap-3">
                                <div className="flex items-center gap-2">
                                  <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                                    <Store className="h-4 w-4 text-primary" />
                                  </div>
                                  <div>
                                    <p className="text-[11px] uppercase tracking-wider text-primary/70 font-semibold">Fulfilled by</p>
                                    <p className="text-sm font-semibold text-foreground">{sellerName}{sellerOwnerName ? <span className="text-muted-foreground font-normal"> · {sellerOwnerName}</span> : null}</p>
                                  </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 ml-auto">
                                  {sellerStatus && (
                                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${SELLER_STATUS_STYLE[sellerStatus] ?? "bg-muted text-muted-foreground border-border"}`}>
                                      {SELLER_STATUS_LABEL[sellerStatus] ?? sellerStatus}
                                    </span>
                                  )}
                                  {sellerEmail && (
                                    <a
                                      href={`mailto:${sellerEmail}`}
                                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-foreground bg-card hover:bg-muted border border-border transition-colors"
                                    >
                                      <Mail className="h-3 w-3" /> {sellerEmail}
                                    </a>
                                  )}
                                  {sellerPhone && (
                                    <a
                                      href={`tel:${sellerPhone}`}
                                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-foreground bg-card hover:bg-muted border border-border transition-colors"
                                    >
                                      <Phone className="h-3 w-3" /> {sellerPhone}
                                    </a>
                                  )}
                                </div>
                              </div>
                            )}
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-sm">
                              {addr && (
                                <div>
                                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                    <MapPin className="h-3.5 w-3.5" /> Shipping Address
                                  </p>
                                  <p className="font-medium text-foreground">{addr.fullName}</p>
                                  <p className="text-muted-foreground text-xs">{addr.street ?? addr.line1}</p>
                                  <p className="text-muted-foreground text-xs">{addr.city}{addr.district ? `, ${addr.district}` : ""}</p>
                                  {addr.phone && <p className="text-muted-foreground text-xs mt-0.5">📞 {addr.phone}</p>}
                                </div>
                              )}
                              <div>
                                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Items Ordered</p>
                                <div className="space-y-1">
                                  {((o as any).items ?? []).slice(0, 4).map((item: any) => (
                                    <p key={item.productId} className="text-xs text-muted-foreground">
                                      {item.productName} × {item.quantity} - Tk{(item.price * item.quantity).toLocaleString()}
                                    </p>
                                  ))}
                                  {((o as any).items ?? []).length > 4 && (
                                    <p className="text-xs text-muted-foreground/70">+{((o as any).items ?? []).length - 4} more items</p>
                                  )}
                                </div>
                              </div>
                              <div>
                                {(o.giftWrap === "true" || (o.giftWrap as any) === true) && (
                                  <div className="mb-3 p-2 bg-primary/5 border border-primary/20 rounded-lg">
                                    <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-1">🎁 Gift Wrapping</p>
                                    {o.giftMessage && <p className="text-sm text-foreground">{o.giftMessage}</p>}
                                  </div>
                                )}
                                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Payment Info</p>
                                <p className="text-xs text-muted-foreground capitalize">Method: {(o as any).paymentMethod}</p>
                                <p className={`text-xs capitalize ${(o as any).paymentStatus === "paid" ? "text-success-foreground" : "text-warning-foreground"}`}>
                                  Status: {(o as any).paymentStatus}
                                </p>
                                {(o as any).senderNumber && (
                                  <p className="text-xs text-muted-foreground mt-1">From: <span className="font-mono">{(o as any).senderNumber}</span></p>
                                )}
                                {(o as any).paidAt && (
                                  <p className="text-xs text-muted-foreground mt-0.5">Paid: {new Date((o as any).paidAt).toLocaleString()}</p>
                                )}
                                {(o as any).transactionId && (
                                  <p className="text-xs text-muted-foreground font-mono mt-1">{(o as any).transactionId}</p>
                                )}
                                {(o as any).couponCode && (
                                  <p className="text-xs text-primary mt-1">Coupon: {(o as any).couponCode} (-Tk{(o as any).discountAmount})</p>
                                )}
                              </div>
                              {o.orderStatus === "cancelled" && (o as any).cancellationReason && (
                                <div className="col-span-full mt-2 p-2 bg-destructive/10 border border-destructive/20 rounded-lg">
                                  <p className="text-xs font-semibold text-destructive uppercase tracking-wider mb-1 flex items-center gap-1.5">
                                    <XCircle className="h-3.5 w-3.5" /> Cancelled by Customer
                                  </p>
                                  <p className="text-xs text-destructive">Reason: {(o as any).cancellationReason}</p>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {visibleOrders.length === 0 && (
                  <tr><td colSpan={8} className="text-center text-muted-foreground/70 py-12">No orders found</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {ordersHasMore && !orderSearch && sellerFilter === "all" && ordersTotal - orders.length > 0 && (
            <div className="p-4 border-t text-center">
              <button
                onClick={() => fetchOrders(ordersPage + 1, true)}
                disabled={ordersLoading}
                className="px-6 py-2 text-sm font-medium rounded-xl border border-border hover:bg-muted transition-colors disabled:opacity-50"
              >
                {ordersLoading ? "Loading..." : `Load More (${Math.max(0, ordersTotal - orders.length)} remaining)`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Help banner — explains why the admin can no longer update order
          status directly. Placed at the bottom so it doesn't push the
          table down, but is still visible to a confused admin. */}
      <div className="mt-5 flex items-start gap-3 p-4 bg-info border border-info-border rounded-xl text-sm text-info-foreground">
        <div className="h-7 w-7 rounded-lg bg-info/70 flex items-center justify-center shrink-0">
          <AlertCircle className="h-4 w-4 text-info-foreground" />
        </div>
        <div>
          <p className="font-semibold mb-1">Why can't I update order status here?</p>
          <p className="text-info-foreground/80 leading-relaxed">
            Since the marketplace migration, each order belongs to the seller
            who listed the items — they set the price, delivery charge, and
            quantity, and they fulfill the order end-to-end. Sellers update
            status from their own Seller Dashboard. As admin, your role here
            is oversight: use the <strong>Seller</strong> column to see who's
            responsible, and the <strong>Contact</strong> button to reach out
            when an order needs your intervention.
          </p>
        </div>
      </div>
    </div>
  );
}

// Small stat card used by the summary bar at the top of the tab. Kept
// inline rather than promoted to a shared component because it's only
// used here -- if the dashboard tab wants the same look, it can be
// lifted later.
function StatCard({ label, value, icon, tint }: { label: string; value: string; icon: React.ReactNode; tint: string }) {
  return (
    <div className="bg-card border rounded-xl px-4 py-3 flex items-center gap-3">
      <div className={`h-9 w-9 rounded-lg bg-muted/50 flex items-center justify-center ${tint}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium truncate">{label}</p>
        <p className="text-base font-semibold text-foreground truncate">{value}</p>
      </div>
    </div>
  );
}
