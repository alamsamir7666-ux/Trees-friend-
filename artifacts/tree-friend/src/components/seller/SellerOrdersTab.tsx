import { useState, useMemo } from "react";
import {
  Package2, Truck, Loader2, Copy, Check, ChevronDown, ChevronRight,
  ShoppingCart, Clock, CheckCircle2, BarChart3, XCircle, PackageCheck,
  Search, AlertCircle, MapPin, Phone, Mail,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  useListSellerOrders,
  useUpdateSellerOrderStatus,
  useBookCourierForOrder,
  useUpdateShipmentStatus,
  useGetMySellerCourierConfig,
  getListSellerOrdersQueryKey,
  type SellerOrder,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

type OrderStatus = "pending" | "confirmed" | "processing" | "shipped" | "delivered" | "cancelled";

const ORDER_STATUS_META: Record<
  OrderStatus,
  { label: string; icon: React.ElementType; chip: string; dot: string }
> = {
  pending: { label: "Pending", icon: Clock, chip: "bg-warning text-warning-foreground ring-warning-border/60", dot: "bg-warning-foreground" },
  confirmed: { label: "Confirmed", icon: CheckCircle2, chip: "bg-info text-info-foreground ring-info-border/60", dot: "bg-info-foreground" },
  processing: { label: "Processing", icon: BarChart3, chip: "bg-info text-info-foreground ring-info-border/60", dot: "bg-info-foreground" },
  shipped: { label: "Shipped", icon: Truck, chip: "bg-info text-info-foreground ring-info-border/60", dot: "bg-info-foreground" },
  delivered: { label: "Delivered", icon: PackageCheck, chip: "bg-success text-success-foreground ring-success-border/60", dot: "bg-success-foreground" },
  cancelled: { label: "Cancelled", icon: XCircle, chip: "bg-destructive/10 text-destructive ring-destructive/20", dot: "bg-destructive" },
};

const SHIPMENT_STATUS_META: Record<string, { label: string; chip: string }> = {
  pending: { label: "Pending", chip: "bg-warning text-warning-foreground ring-warning-border/60" },
  picked_up: { label: "Picked up", chip: "bg-info text-info-foreground ring-info-border/60" },
  in_transit: { label: "In transit", chip: "bg-info text-info-foreground ring-info-border/60" },
  delivered: { label: "Delivered", chip: "bg-success text-success-foreground ring-success-border/60" },
  returned: { label: "Returned", chip: "bg-warning text-warning-foreground ring-warning-border/60" },
  failed: { label: "Failed", chip: "bg-destructive/10 text-destructive ring-destructive/20" },
};

const ORDER_STATUS_OPTIONS = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"] as const;
const SHIPMENT_STATUS_OPTIONS = ["pending", "picked_up", "in_transit", "delivered", "returned", "failed"] as const;

function formatTk(n: number): string {
  return `Tk${Math.round(Number(n) || 0).toLocaleString()}`;
}

function OrderRow({ order }: { order: SellerOrder }) {
  const qc = useQueryClient();
  const { data: courierConfig } = useGetMySellerCourierConfig();
  const updateStatus = useUpdateSellerOrderStatus();
  const bookCourier = useBookCourierForOrder();
  const updateShipmentStatus = useUpdateShipmentStatus();
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [expanded, setExpanded] = useState(false);

  function invalidate() {
    qc.invalidateQueries({ queryKey: getListSellerOrdersQueryKey() });
  }

  function handleOrderStatusChange(value: string) {
    if (value === "cancelled") {
      setCancelling(true);
      return;
    }
    updateStatus.mutate(
      { id: order.id, data: { orderStatus: value as any } },
      {
        onSuccess: () => { toast.success(`Order marked ${value}`); invalidate(); },
        onError: (err: any) => toast.error(err?.message ?? "Failed to update order status"),
      },
    );
  }

  function confirmCancel() {
    if (cancelReason.trim().length < 3) {
      toast.error("Enter a reason for cancelling (at least 3 characters)");
      return;
    }
    updateStatus.mutate(
      { id: order.id, data: { orderStatus: "cancelled", cancellationReason: cancelReason.trim() } },
      {
        onSuccess: () => { toast.success("Order cancelled"); setCancelling(false); setCancelReason(""); invalidate(); },
        onError: (err: any) => toast.error(err?.message ?? "Failed to cancel order"),
      },
    );
  }

  function handleBookCourier() {
    bookCourier.mutate(
      { orderId: order.id },
      {
        onSuccess: (shipment) => {
          toast.success(`Courier booked — tracking ID ${shipment.courierTrackingId}`);
          invalidate();
        },
        onError: (err: any) => toast.error(err?.message ?? "Courier booking failed"),
      },
    );
  }

  function handleShipmentStatusChange(value: string) {
    updateShipmentStatus.mutate(
      { orderId: order.id, data: { status: value as any } },
      {
        onSuccess: () => { toast.success(`Shipment marked ${value.replace("_", " ")}`); invalidate(); },
        onError: (err: any) => toast.error(err?.message ?? "Failed to update shipment status"),
      },
    );
  }

  function copyTrackingId() {
    navigator.clipboard.writeText(order.trackingId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const hasCourierConfig = !!courierConfig;
  const hasBooking = !!order.shipment?.courierTrackingId;
  const meta = ORDER_STATUS_META[order.orderStatus as OrderStatus] ?? ORDER_STATUS_META.pending;
  const StatusIcon = meta.icon;
  const paymentPending = order.paymentStatus === "pending" && order.paymentMethod !== "cod";

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      {/* Header row */}
      <div className="px-5 py-4">
        <div className="flex items-start gap-3">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-1 rounded-md text-muted-foreground hover:bg-muted transition-colors mt-0.5"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          <div className="h-9 w-9 rounded-xl bg-muted flex items-center justify-center shrink-0">
            <StatusIcon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={copyTrackingId}
                className="flex items-center gap-1.5 text-sm font-semibold text-foreground hover:text-accent-text transition-colors tabular-nums truncate max-w-[200px]"
              >
                <span className="truncate">{order.trackingId}</span>
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-success-foreground shrink-0" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
              </button>
              <span className={cn("inline-flex items-center gap-1 text-xs font-medium rounded-full px-2 py-0.5 ring-1 shrink-0", meta.chip)}>
                <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
                {meta.label}
              </span>
              {paymentPending && (
                <span className="inline-flex items-center gap-1 text-xs font-medium rounded-full px-2 py-0.5 ring-1 ring-warning-border/60 bg-warning text-warning-foreground shrink-0">
                  <AlertCircle className="h-3 w-3" />
                  Payment pending
                </span>
              )}
            </div>
            <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
              <span className="inline-flex items-center gap-1">
                <ShoppingCart className="h-3 w-3" />
                {order.items.length} item{order.items.length !== 1 ? "s" : ""}
              </span>
              <span className="font-medium text-foreground tabular-nums">{formatTk(order.totalAmount)}</span>
              <span className="uppercase">{order.paymentMethod}</span>
              <span>{new Date(order.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
            </div>
            {/* Order status dropdown - on its own line to prevent overlap */}
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Status</span>
              <Select value={order.orderStatus} onValueChange={handleOrderStatusChange} disabled={updateStatus.isPending}>
                <SelectTrigger className="h-8 w-[140px] rounded-lg text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ORDER_STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s} className="text-xs capitalize">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Cancel reason input */}
        {cancelling && (
          <div className="mt-3 flex items-center gap-2 bg-destructive/10 border border-destructive/20 rounded-xl p-2.5">
            <input
              autoFocus
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Reason for cancelling…"
              className="flex-1 bg-card rounded-lg border border-border px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-destructive/30"
            />
            <Button size="sm" variant="destructive" className="h-7 rounded-lg text-xs" onClick={confirmCancel} disabled={updateStatus.isPending}>
              Confirm
            </Button>
            <Button size="sm" variant="ghost" className="h-7 rounded-lg text-xs" onClick={() => setCancelling(false)}>
              Back
            </Button>
          </div>
        )}

        {/* Shipment row */}
        <div className="mt-3 pt-3 border-t border-border/60 space-y-2">
          <div className="flex items-center gap-2 min-w-0">
            <Truck className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            {hasBooking && order.shipment ? (
              <>
                <span className={cn("inline-flex items-center gap-1 text-xs font-medium rounded-full px-2 py-0.5 ring-1 capitalize shrink-0", (SHIPMENT_STATUS_META[order.shipment.status] ?? SHIPMENT_STATUS_META.pending).chip)}>
                  {(SHIPMENT_STATUS_META[order.shipment.status] ?? SHIPMENT_STATUS_META.pending).label}
                </span>
                <span className="text-xs text-muted-foreground truncate">
                  <span className="capitalize">{order.shipment.courierProvider}</span> · {order.shipment.courierTrackingId}
                </span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">Not shipped yet</span>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {!hasBooking && hasCourierConfig && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 rounded-lg text-xs gap-1"
                onClick={handleBookCourier}
                disabled={bookCourier.isPending}
              >
                {bookCourier.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Truck className="h-3 w-3" />}
                Book courier
              </Button>
            )}
            <Select
              value={order.shipment?.status ?? ""}
              onValueChange={handleShipmentStatusChange}
              disabled={updateShipmentStatus.isPending}
            >
              <SelectTrigger className="h-7 w-[150px] rounded-lg text-xs">
                <SelectValue placeholder="Set ship status" />
              </SelectTrigger>
              <SelectContent>
                {SHIPMENT_STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs capitalize">{s.replace("_", " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {order.cancellationReason && (
          <p className="text-xs text-destructive mt-2.5 bg-destructive/10 rounded-lg px-2.5 py-1.5">
            <span className="font-medium">Cancelled:</span> {order.cancellationReason}
          </p>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-border bg-muted/30 px-5 py-4 space-y-4">
          {/* Customer */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Customer</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div className="flex items-center gap-2 text-foreground">
                <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="truncate">{order.shippingAddress?.fullName}</span>
              </div>
              <div className="flex items-center gap-2 text-foreground">
                <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="truncate">{order.shippingAddress?.phone}</span>
              </div>
              {order.buyerEmail && (
                <div className="flex items-center gap-2 text-foreground">
                  <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{order.buyerEmail}</span>
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
              {order.shippingAddress?.street}
              {order.shippingAddress?.city ? `, ${order.shippingAddress.city}` : ""}
              {order.shippingAddress?.district ? `, ${order.shippingAddress.district}` : ""}
            </p>
          </div>

          {/* Items */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Items</p>
            <div className="space-y-1.5">
              {order.items.map((item: any, idx: number) => (
                <div
                  key={idx}
                  className="flex items-center gap-3 bg-card rounded-lg border border-border p-2.5"
                >
                  {item.productImage ? (
                    <img src={item.productImage} alt="" className="h-10 w-10 rounded-md object-cover border border-border shrink-0" />
                  ) : (
                    <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center shrink-0">
                      <Package2 className="h-4 w-4 text-muted-foreground/50" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{item.productName}</p>
                    <p className="text-[11px] text-muted-foreground">Qty {item.quantity} × {formatTk(item.price)}</p>
                  </div>
                  <span className="text-sm font-semibold text-foreground tabular-nums shrink-0">
                    {formatTk(item.price * item.quantity)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function SellerOrdersTab() {
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const { data: orders, isLoading } = useListSellerOrders(
    filter === "all" ? {} : { orderStatus: filter as any },
  );
  const { data: courierConfig } = useGetMySellerCourierConfig();

  const filtered = useMemo(() => {
    if (!orders) return [];
    if (!search.trim()) return orders;
    const q = search.trim().toLowerCase();
    return orders.filter(
      (o) =>
        o.trackingId.toLowerCase().includes(q) ||
        o.shippingAddress?.fullName?.toLowerCase().includes(q) ||
        o.shippingAddress?.phone?.toLowerCase().includes(q),
    );
  }, [orders, search]);

  // Stats
  const stats = useMemo(() => {
    if (!orders) return { total: 0, pending: 0, shipped: 0, delivered: 0 };
    return {
      total: orders.length,
      pending: orders.filter((o) => o.orderStatus === "pending").length,
      shipped: orders.filter((o) => o.orderStatus === "shipped").length,
      delivered: orders.filter((o) => o.orderStatus === "delivered").length,
    };
  }, [orders]);

  const statCards = [
    { label: "Total Orders", value: stats.total, icon: ShoppingCart, color: "bg-info text-info-foreground" },
    { label: "Pending", value: stats.pending, icon: Clock, color: "bg-warning text-warning-foreground" },
    { label: "Shipped", value: stats.shipped, icon: Truck, color: "bg-info text-info-foreground" },
    { label: "Delivered", value: stats.delivered, icon: PackageCheck, color: "bg-success text-success-foreground" },
  ];

  return (
    <div className="space-y-5">
      {/* Stat strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {statCards.map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-card p-4 flex items-center gap-3">
            <div className={cn("h-10 w-10 rounded-xl flex items-center justify-center shrink-0", s.color)}>
              <s.icon className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{s.label}</p>
              <p className="text-xl font-bold text-foreground tabular-nums">{s.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* No courier warning */}
      {!courierConfig && (
        <div className="bg-warning border border-warning-border rounded-2xl px-4 py-3 text-sm text-warning-foreground flex items-start gap-3">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">No courier account connected</p>
            <p className="text-xs text-warning-foreground mt-0.5">
              Set one up in Courier Settings to book shipments automatically, or update status manually below.
            </p>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by tracking ID, customer name, or phone…"
            className="pl-9 h-10 rounded-xl bg-card"
          />
        </div>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="h-10 w-full sm:w-[180px] rounded-xl">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All orders</SelectItem>
            {ORDER_STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Orders */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-card rounded-2xl border border-border p-12 text-center">
          <div className="h-16 w-16 mx-auto mb-4 rounded-2xl bg-muted flex items-center justify-center">
            <Package2 className="h-8 w-8 text-muted-foreground/50" />
          </div>
          <p className="font-semibold text-foreground mb-1">
            {orders && orders.length > 0 ? "No orders match your filters" : "No orders yet"}
          </p>
          <p className="text-sm text-muted-foreground">
            {filter !== "all" || search
              ? "Try clearing your search or status filter."
              : "Orders will appear here once buyers start purchasing."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((o) => (
            <OrderRow key={o.id} order={o} />
          ))}
        </div>
      )}
    </div>
  );
}
