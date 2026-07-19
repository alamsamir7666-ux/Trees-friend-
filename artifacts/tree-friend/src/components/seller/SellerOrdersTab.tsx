import { useState } from "react";
import { Package2, Truck, ChevronDown, Loader2, Copy, Check, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

/**
 * Manage Orders tab (plan doc §4, §8 — Part 4). Mirrors OrdersPage.tsx's
 * statusColors palette exactly, for the same order-status vocabulary
 * (pending/confirmed/processing/shipped/delivered/cancelled) so a seller
 * sees the identical color language the buyer sees on their own order.
 */

const orderStatusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  confirmed: "bg-blue-100 text-blue-800",
  processing: "bg-purple-100 text-purple-800",
  shipped: "bg-indigo-100 text-indigo-800",
  delivered: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
};

const shipmentStatusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  picked_up: "bg-blue-100 text-blue-800",
  in_transit: "bg-indigo-100 text-indigo-800",
  delivered: "bg-green-100 text-green-800",
  returned: "bg-orange-100 text-orange-800",
  failed: "bg-red-100 text-red-800",
};

const ORDER_STATUS_OPTIONS = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];
const SHIPMENT_STATUS_OPTIONS = ["pending", "picked_up", "in_transit", "delivered", "returned", "failed"];

function OrderRow({ order }: { order: SellerOrder }) {
  const qc = useQueryClient();
  const { data: courierConfig } = useGetMySellerCourierConfig();
  const updateStatus = useUpdateSellerOrderStatus();
  const bookCourier = useBookCourierForOrder();
  const updateShipmentStatus = useUpdateShipmentStatus();
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

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

  return (
    <div className="bg-card rounded-2xl border p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={copyTrackingId} className="flex items-center gap-1 text-sm font-medium hover:text-accent transition-colors">
              {order.trackingId} {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
            </button>
            <Badge className={`${orderStatusColors[order.orderStatus] ?? "bg-muted"} capitalize`}>{order.orderStatus}</Badge>
            {order.paymentStatus === "pending" && order.paymentMethod !== "cod" && (
              <Badge variant="outline" className="text-amber-700 border-amber-300">Payment pending</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {order.shippingAddress?.fullName} · {order.shippingAddress?.phone}
            {order.buyerEmail ? ` · ${order.buyerEmail}` : ""}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {order.items.length} item{order.items.length !== 1 ? "s" : ""} · Tk{order.totalAmount} · {order.paymentMethod.toUpperCase()}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
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

      {cancelling && (
        <div className="mt-3 flex items-center gap-2 bg-red-50 rounded-xl p-2.5">
          <input
            autoFocus
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Reason for cancelling…"
            className="flex-1 bg-background rounded-lg border px-2.5 py-1.5 text-xs"
          />
          <Button size="sm" variant="destructive" className="h-7 rounded-lg text-xs" onClick={confirmCancel} disabled={updateStatus.isPending}>
            Confirm cancel
          </Button>
          <Button size="sm" variant="ghost" className="h-7 rounded-lg text-xs" onClick={() => setCancelling(false)}>
            Back
          </Button>
        </div>
      )}

      <div className="mt-3 pt-3 border-t flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Truck className="h-3.5 w-3.5 text-muted-foreground" />
          {hasBooking && order.shipment ? (
            <>
              <Badge className={`${shipmentStatusColors[order.shipment.status] ?? "bg-muted"} capitalize`}>
                {order.shipment.status.replace("_", " ")}
              </Badge>
              <span className="text-xs text-muted-foreground capitalize">
                {order.shipment.courierProvider} · {order.shipment.courierTrackingId}
              </span>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">Not shipped yet</span>
          )}
        </div>

        <div className="flex items-center gap-2">
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
        <p className="text-xs text-red-600 mt-2">Cancelled: {order.cancellationReason}</p>
      )}
    </div>
  );
}

export function SellerOrdersTab() {
  const [filter, setFilter] = useState<string>("all");
  const { data: orders, isLoading } = useListSellerOrders(
    filter === "all" ? {} : { orderStatus: filter as any },
  );
  const { data: courierConfig } = useGetMySellerCourierConfig();

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="h-8 w-[160px] rounded-lg text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">All orders</SelectItem>
            {ORDER_STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s} className="text-xs capitalize">{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!courierConfig && (
          <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-1.5">
            No courier account connected — set one up in Courier Settings to book shipments automatically, or update status manually below.
          </p>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-28 rounded-2xl bg-muted animate-pulse" />)}
        </div>
      ) : !orders || orders.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground bg-card rounded-2xl border">
          <Package2 className="h-8 w-8 mx-auto mb-2 opacity-30" />
          <p className="font-medium text-sm">No orders {filter !== "all" ? `with status "${filter}"` : "yet"}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((o) => <OrderRow key={o.id} order={o} />)}
        </div>
      )}
    </div>
  );
}
