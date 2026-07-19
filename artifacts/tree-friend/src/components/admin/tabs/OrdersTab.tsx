import { useAdminContext } from "@/contexts/AdminContext";
import { Fragment } from "react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, ChevronDown, MapPin, AlertCircle } from "lucide-react";
import { apiClient } from "@/lib/apiClient";

const API = import.meta.env.VITE_API_BASE_URL ?? "";

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
    handleOrderStatusChange,
    cancelModal,
    setCancelModal,
    askConfirm,
    getToken,
    statusConfig,
    fetchOrders,
    fetchAdminPreOrders,
    orders,
  } = useAdminContext();

return (
  <div>
    <div className="flex items-center justify-between mb-4 gap-3">
      <div className="relative flex-1 max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          placeholder="Search by order ID, customer, or status..."
          value={orderSearch}
          onChange={e => setOrderSearch(e.target.value)}
          className="pl-9 rounded-xl"
        />
      </div>
      <div className="flex gap-2">
        {["all","pending","delivered"].map(s => (
          <button
            key={s}
            onClick={() => setOrderSearch(s === "all" ? "" : s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${
              (s === "all" && !orderSearch) || orderSearch === s
                ? "bg-pink-100 text-pink-600"
                : "bg-gray-100 text-gray-500 hover:bg-gray-200"
            }`}
          >
            {s}
          </button>
        ))}
      </div>
    </div>

    {ordersLoading ? (
      <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
    ) : (
      <div className="bg-white rounded-2xl border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Order</th>
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Customer</th>
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Payment</th>
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Total</th>
                <th className="px-4 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Update</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filteredOrders.map((o) => {
              if ((o as any)._type === "preorder") {
                const isPreExpanded = expandedOrderId === `pre-${o.id}`;
                return (
                  <Fragment key={`pre-${o.id}`}>
                    <tr className="hover:bg-blue-50/30 transition-colors cursor-pointer" onClick={() => setExpandedOrderId(isPreExpanded ? null : `pre-${o.id}`)}>
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-1.5">
                          <ChevronDown className={`h-3.5 w-3.5 text-blue-400 transition-transform shrink-0 ${isPreExpanded ? "rotate-180" : ""}`} />
                          <div>
                            <span className="text-xs font-bold bg-blue-100 text-blue-700 rounded-full px-2 py-0.5">PRE-ORDER</span>
                            <p className="text-xs font-mono text-gray-500 mt-0.5">{o.trackingId}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        <p className="font-medium text-gray-800 text-xs">{o.shippingAddress?.fullName ?? "Guest"}</p>
                        <p className="text-xs text-gray-400">{o.whatsappPhone ?? o.shippingAddress?.phone}</p>
                      </td>
                      <td className="px-4 py-3.5 text-xs text-gray-500">{new Date(o.createdAt).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" })}</td>
                      <td className="px-4 py-3.5">
                        <span className="text-xs bg-gray-100 px-2 py-1 rounded-lg font-medium text-gray-600 capitalize">{o.paymentMethod}</span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className={`flex items-center gap-1.5 w-fit px-2.5 py-1 rounded-full text-xs font-medium border ${
                          o.status === "delivered" ? "bg-green-50 text-green-700 border-green-200" :
                          o.status === "cancelled" ? "bg-red-50 text-red-700 border-red-200" :
                          o.status === "shipped" ? "bg-blue-50 text-blue-700 border-blue-200" :
                          o.status === "arrived_in_bd" ? "bg-purple-50 text-purple-700 border-purple-200" :
                          o.status === "confirmed" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                          "bg-yellow-50 text-yellow-700 border-yellow-200"
                        }`}>{o.status === "arrived_in_bd" ? "Arrived in BD" : o.status.charAt(0).toUpperCase() + o.status.slice(1)}</span>
                      </td>
                      <td className="px-4 py-3.5 text-right font-semibold text-gray-800">Tk{(Number(o.discountedPrice) * Number(o.quantity) + Number(o.deliveryCharge)).toLocaleString()}</td>
                      <td className="px-4 py-3.5 text-right" onClick={e => e.stopPropagation()}>
                        <Select value={o.status} onValueChange={async (newStatus) => {
                            let cancellationReason: string | undefined;
                            if (newStatus === "cancelled") {
                              const reason = window.prompt("Enter cancellation reason (optional):");
                              cancellationReason = reason ?? undefined;
                            }
                            const token = await getToken();
                            await fetch(`${API}/api/pre-orders/${o.id}/status`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                              body: JSON.stringify({ status: newStatus, cancellationReason }),
                            });
                            fetchAdminPreOrders();
                          }} disabled={o.status === "delivered" || o.status === "cancelled"}>
                          <SelectTrigger className={`w-34 text-xs h-8 rounded-lg border-gray-200 ${(o.status === "delivered" || o.status === "cancelled") ? "opacity-50 cursor-not-allowed" : ""}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {["pending","confirmed","arrived_in_bd","shipped","delivered","cancelled"].map(s => (
                              <SelectItem key={s} value={s} className="text-xs">{s === "arrived_in_bd" ? "Arrived in BD" : s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                    </tr>
                    {isPreExpanded && (
                      <tr key={`pre-${o.id}-expanded`} className="bg-blue-50/40">
                        <td colSpan={7} className="px-8 py-4">
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-sm">
                            <div>
                              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                <MapPin className="h-3.5 w-3.5" /> Shipping Address
                              </p>
                              <p className="font-medium text-gray-800">{o.shippingAddress?.fullName}</p>
                              <p className="text-gray-500 text-xs">{o.shippingAddress?.street}</p>
                              <p className="text-gray-500 text-xs">{o.shippingAddress?.city}{o.shippingAddress?.district ? `, ${o.shippingAddress.district}` : ""}</p>
                              {o.shippingAddress?.phone && <p className="text-gray-500 text-xs mt-0.5">📞 {o.shippingAddress.phone}</p>}
                              {o.whatsappPhone && <p className="text-gray-500 text-xs mt-0.5">💬 WhatsApp: {o.whatsappPhone}</p>}
                            </div>
                            <div>
                              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Product</p>
                              <p className="text-xs text-gray-600">{o.productName} × {o.quantity}</p>
                              <p className="text-xs text-gray-500 mt-1">Price: Tk{Number(o.discountedPrice).toLocaleString()}</p>
                              <p className="text-xs text-gray-500">Delivery: Tk{Number(o.deliveryCharge).toLocaleString()}</p>
                              <p className="text-xs font-semibold text-gray-700 mt-1">Total: Tk{(Number(o.discountedPrice) * Number(o.quantity) + Number(o.deliveryCharge)).toLocaleString()}</p>
                            </div>
                            <div>
                              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Payment Info</p>
                              <p className="text-xs text-gray-600 capitalize">Method: {o.paymentMethod}</p>
                              <p className={`text-xs capitalize ${o.paymentStatus === "paid" ? "text-green-600" : "text-amber-600"}`}>Status: {o.paymentStatus}</p>
                              {o.senderNumber && <p className="text-xs text-gray-500 mt-1">From: <span className="font-mono">{o.senderNumber}</span></p>}
                              {o.transactionId && <p className="text-xs text-gray-500 font-mono mt-1">TxID: {o.transactionId}</p>}
                              {o.status === "cancelled" && o.cancellationReason && (
                                <div className="mt-2 bg-red-50 border border-red-200 rounded-lg p-2">
                                  <p className="text-xs font-semibold text-red-600">Cancel Reason:</p>
                                  <p className="text-xs text-red-500 mt-0.5">{o.cancellationReason}</p>
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
                const cfg = statusConfig[o.orderStatus] ?? { color: "bg-gray-100 text-gray-600 border-gray-200", icon: AlertCircle };
                const StatusIcon = cfg.icon;
                const isExpanded = expandedOrderId === o.id;
                const addr = (o as any).shippingAddress as { fullName?: string; street?: string; line1?: string; city?: string; district?: string; phone?: string } | null;
                return (
                  <Fragment key={o.id}>
                    <tr className="hover:bg-pink-50/30 transition-colors cursor-pointer" onClick={() => setExpandedOrderId(isExpanded ? null : o.id)}>
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-1.5">
                          <ChevronDown className={`h-3.5 w-3.5 text-gray-400 transition-transform shrink-0 ${isExpanded ? "rotate-180" : ""}`} />
                          <div>
                            <p className="font-semibold text-gray-800">#{o.id}</p>
                            {(o as any).trackingId && <p className="text-xs text-gray-400 font-mono">{(o as any).trackingId}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        {(o as any).userName ? (
                          <div>
                            <p className="font-medium text-gray-800 text-xs">{(o as any).userName}</p>
                            {!(o as any).userEmail?.endsWith("@clerk.user") && (o as any).userEmail && (
                              <p className="text-xs text-gray-400">{(o as any).userEmail}</p>
                            )}
                          </div>
                        ) : (o as any).shippingAddress?.fullName ? (
                          <p className="text-xs text-gray-600">{(o as any).shippingAddress.fullName}</p>
                        ) : (
                          <p className="text-xs text-gray-400">-</p>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-gray-500 text-xs">{new Date(o.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</td>
                      <td className="px-4 py-3.5">
                        <span className="text-xs bg-gray-100 px-2 py-1 rounded-lg font-medium text-gray-600 capitalize">{(o as any).paymentMethod ?? "-"}</span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className={`flex items-center gap-1.5 w-fit px-2.5 py-1 rounded-full text-xs font-medium border ${cfg.color}`}>
                          <StatusIcon className="h-3 w-3" />{o.orderStatus === "return_completed" ? "Refund Completed" : o.orderStatus}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-right font-semibold text-gray-800">Tk{Number((o as any).totalAmount ?? (o as any).discountedPrice ?? 0).toLocaleString()}</td>
                      <td className="px-4 py-3.5 text-right" onClick={e => e.stopPropagation()}>
                        <Select value={o.orderStatus} onValueChange={(v) => handleOrderStatusChange(o.id, v)} disabled={o.orderStatus === "delivered" || o.orderStatus === "cancelled" || o.orderStatus === "return_completed"}>
                          <SelectTrigger className={`w-34 text-xs h-8 rounded-lg border-gray-200 ${(o.orderStatus === "delivered" || o.orderStatus === "cancelled" || o.orderStatus === "return_completed") ? "opacity-50 cursor-not-allowed" : ""}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {["pending","confirmed","processing","shipped","delivered","cancelled"].map(s => (
                              <SelectItem key={s} value={s} className="text-xs capitalize">{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${o.id}-expanded`} className="bg-pink-50/40">
                        <td colSpan={7} className="px-8 py-4">
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-sm">
                            {addr && (
                              <div>
                                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                  <MapPin className="h-3.5 w-3.5" /> Shipping Address
                                </p>
                                <p className="font-medium text-gray-800">{addr.fullName}</p>
                                <p className="text-gray-500 text-xs">{addr.street ?? addr.line1}</p>
                                <p className="text-gray-500 text-xs">{addr.city}{addr.district ? `, ${addr.district}` : ""}</p>
                                {addr.phone && <p className="text-gray-500 text-xs mt-0.5">📞 {addr.phone}</p>}
                              </div>
                            )}
                            <div>
                              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Items Ordered</p>
                              <div className="space-y-1">
                                {((o as any).items ?? []).slice(0, 4).map((item: any) => (
                                  <p key={item.productId} className="text-xs text-gray-600">
                                    {item.productName} × {item.quantity} - Tk{(item.price * item.quantity).toLocaleString()}
                                  </p>
                                ))}
                                {((o as any).items ?? []).length > 4 && (
                                  <p className="text-xs text-gray-400">+{((o as any).items ?? []).length - 4} more items</p>
                                )}
                              </div>
                            </div>
                            <div>
                              {(o.giftWrap === "true" || (o.giftWrap as any) === true) && (
                                <div className="mb-3 p-2 bg-pink-50 border border-pink-200 rounded-lg">
                                  <p className="text-xs font-semibold text-pink-600 uppercase tracking-wider mb-1">🎁 Gift Wrapping</p>
                                  {o.giftMessage && <p className="text-sm text-gray-700">{o.giftMessage}</p>}
                                </div>
                              )}
                              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Payment Info</p>
                              <p className="text-xs text-gray-600 capitalize">Method: {(o as any).paymentMethod}</p>
                              <p className={`text-xs capitalize ${(o as any).paymentStatus === "paid" ? "text-green-600" : "text-amber-600"}`}>
                                Status: {(o as any).paymentStatus}
                              </p>
                              {(o as any).senderNumber && (
                                <p className="text-xs text-gray-500 mt-1">From: <span className="font-mono">{(o as any).senderNumber}</span></p>
                              )}
                              {(o as any).paidAt && (
                                <p className="text-xs text-gray-500 mt-0.5">Paid: {new Date((o as any).paidAt).toLocaleString()}</p>
                              )}
                              {(o as any).transactionId && (
                                <p className="text-xs text-gray-500 font-mono mt-1">{(o as any).transactionId}</p>
                              )}
                              {(o as any).couponCode && (
                                <p className="text-xs text-pink-500 mt-1">Coupon: {(o as any).couponCode} (-Tk{(o as any).discountAmount})</p>
                              )}
                            </div>
                            {o.orderStatus === "cancelled" && (o as any).cancellationReason && (
                              <div className="col-span-full mt-2 p-2 bg-red-50 border border-red-200 rounded-lg">
                                <p className="text-xs font-semibold text-red-600 uppercase tracking-wider mb-1">⚠️ Cancelled by Customer</p>
                                <p className="text-xs text-red-700">Reason: {(o as any).cancellationReason}</p>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {filteredOrders.length === 0 && (
                <tr><td colSpan={7} className="text-center text-gray-400 py-12">No orders found</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {ordersHasMore && !orderSearch && ordersTotal - orders.length > 0 && (
          <div className="p-4 border-t text-center">
            <button
              onClick={() => fetchOrders(ordersPage + 1, true)}
              disabled={ordersLoading}
              className="px-6 py-2 text-sm font-medium rounded-xl border border-gray-200 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              {ordersLoading ? "Loading..." : `Load More (${Math.max(0, ordersTotal - orders.length)} remaining)`}
            </button>
          </div>
        )}
      </div>
    )}
  </div>
);
}
