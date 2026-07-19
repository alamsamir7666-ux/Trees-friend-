import { useAdminContext } from "@/contexts/AdminContext";
import { Skeleton } from "@/components/ui/skeleton";
import { Archive } from "lucide-react";

export function ArchivedOrdersTab() {
const {
    archivedOrders,
    archivedPreOrders,
    archivedPage,
    archivedHasMore,
    archivedTotal,
    archivedLoading,
    archivedError,
    fetchArchivedOrders,
  } = useAdminContext();

return (
  <div>
    <div className="mb-4">
      <p className="text-sm text-gray-500">Orders marked as <strong>delivered</strong> or <strong>cancelled</strong> more than 2 days ago are automatically moved here.</p>
    </div>
    {archivedError ? (
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 text-center text-red-600 text-sm">{archivedError}</div>
    ) : archivedLoading && archivedOrders.length === 0 ? (
      <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div>
    ) : archivedOrders.length === 0 ? (
      <div className="bg-white rounded-2xl border p-14 text-center">
        <Archive className="h-12 w-12 text-gray-200 mx-auto mb-4" />
        <p className="font-semibold text-gray-500 mb-1">No archived orders yet</p>
        <p className="text-sm text-gray-400">Delivered orders older than 2 days will appear here automatically.</p>
      </div>
    ) : (
      <div className="bg-white rounded-2xl border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Order</th>
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Customer</th>
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Products</th>
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status / Date</th>
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Payment</th>
                <th className="px-4 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {[...archivedOrders, ...archivedPreOrders.map((o: any) => ({ ...o, _type: "preorder", orderStatus: o.status }))].sort((a,b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).map((o) => {
                const sAddr = (o as any).shippingAddress as { fullName?: string } | null;
                return (
                  <tr key={o.id} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3.5">
                      <p className="font-semibold text-gray-800">#{o.id}</p>
                      {(o as any).trackingId && <p className="text-xs text-gray-400 font-mono">{(o as any).trackingId}</p>}
                    </td>
                    <td className="px-4 py-3.5">
                      {(o as any).userName ? (
                        <div>
                          <p className="font-medium text-gray-800 text-xs">{(o as any).userName}</p>
                          {!(o as any).userEmail?.endsWith("@clerk.user") && (o as any).userEmail && (
                            <p className="text-xs text-gray-400">{(o as any).userEmail}</p>
                          )}
                        </div>
                      ) : sAddr?.fullName ? (
                        <p className="text-xs text-gray-600">{sAddr.fullName}</p>
                      ) : (
                        <p className="text-xs text-gray-400">-</p>
                      )}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="space-y-0.5 max-w-[180px]">
                        {(o as any)._type === "preorder" ? (
                          <p className="text-xs text-gray-600 truncate">{(o as any).productName} ×{(o as any).quantity ?? 1}</p>
                        ) : (
                          <>
                            {((o as any).items ?? []).slice(0, 2).map((item: any, idx: number) => (
                              <p key={idx} className="text-xs text-gray-600 truncate">{item.productName} ×{item.quantity}</p>
                            ))}
                            {((o as any).items ?? []).length > 2 && (
                              <p className="text-xs text-gray-400">+{((o as any).items ?? []).length - 2} more</p>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-xs">
                      <div>
                        {(o as any).orderStatus === "cancelled" ? (
                          <span className="inline-block bg-red-100 text-red-600 text-xs font-medium px-2 py-0.5 rounded-lg mb-1">Cancelled</span>
                        ) : (
                          <span className="inline-block bg-green-100 text-green-600 text-xs font-medium px-2 py-0.5 rounded-lg mb-1">Delivered</span>
                        )}
                        <p className="text-gray-400">{new Date(o.updatedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</p>
                        {(o as any).orderStatus === "cancelled" && (o as any).cancellationReason && (
                          <p className="text-red-400 text-xs mt-0.5 max-w-[120px] truncate" title={(o as any).cancellationReason}>⚠️ {(o as any).cancellationReason}</p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <div>
                        <span className="text-xs bg-gray-100 px-2 py-1 rounded-lg font-medium text-gray-600 capitalize">{(o as any).paymentMethod ?? "-"}</span>
                        <span className={`ml-1.5 text-xs font-medium capitalize ${(o as any).paymentStatus === "paid" ? "text-green-600" : "text-amber-500"}`}>
                          · {(o as any).paymentStatus}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-right font-semibold text-gray-800">Tk{Number((o as any).totalAmount ?? (o as any).discountedPrice ?? 0).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {archivedHasMore && (
          <div className="p-4 border-t text-center">
            <button
              onClick={() => fetchArchivedOrders(archivedPage + 1, true)}
              disabled={archivedLoading}
              className="px-6 py-2 text-sm font-medium rounded-xl border border-gray-200 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              {archivedLoading ? "Loading..." : `Load More (${archivedTotal - archivedOrders.length} remaining)`}
            </button>
          </div>
        )}
      </div>
    )}
  </div>
);
}
