import { useAdminContext } from "@/contexts/AdminContext";
import { Skeleton } from "@/components/ui/skeleton";
import { Archive, Store, Mail } from "lucide-react";

// Mirror of SELLER_STATUS_STYLE / SELLER_STATUS_LABEL in OrdersTab.tsx --
// kept local to avoid a shared module just for these two tabs. If a third
// consumer appears, lift to a shared file.
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
      <p className="text-sm text-muted-foreground">Orders marked as <strong>delivered</strong> or <strong>cancelled</strong> more than 2 days ago are automatically moved here.</p>
    </div>
    {archivedError ? (
      <div className="bg-destructive/10 border border-destructive/20 rounded-2xl p-6 text-center text-destructive text-sm">{archivedError}</div>
    ) : archivedLoading && archivedOrders.length === 0 ? (
      <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div>
    ) : archivedOrders.length === 0 ? (
      <div className="bg-card rounded-2xl border p-14 text-center">
        <Archive className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
        <p className="font-semibold text-muted-foreground mb-1">No archived orders yet</p>
        <p className="text-sm text-muted-foreground/70">Delivered orders older than 2 days will appear here automatically.</p>
      </div>
    ) : (
      <div className="bg-card rounded-2xl border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Order</th>
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Customer</th>
                {/* Seller column — added to match the redesigned Orders tab
                    and the new seller fields the /admin/orders/archived
                    endpoint now returns. Shows "—" for pre-orders (the
                    archived-preOrders response doesn't carry seller fields). */}
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Seller</th>
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Products</th>
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status / Date</th>
                <th className="px-4 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Payment</th>
                <th className="px-4 py-3.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-muted/50">
              {[...archivedOrders, ...archivedPreOrders.map((o: any) => ({ ...o, _type: "preorder", orderStatus: o.status }))].sort((a,b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).map((o) => {
                const sAddr = o.shippingAddress as { fullName?: string } | null;
                const sellerName = o.sellerBusinessName ?? null;
                const sellerStatus = o.sellerStatus ?? null;
                const sellerEmail = o.sellerContactEmail ?? null;
                const isPreOrder = o._type === "preorder";
                return (
                  <tr key={o.id} className="hover:bg-muted/40 transition-colors">
                    <td className="px-4 py-3.5">
                      <p className="font-semibold text-foreground">#{o.id}</p>
                      {o.trackingId && <p className="text-xs text-muted-foreground/70 font-mono">{o.trackingId}</p>}
                    </td>
                    <td className="px-4 py-3.5">
                      {o.userName ? (
                        <div>
                          <p className="font-medium text-foreground text-xs">{o.userName}</p>
                          {!o.userEmail?.endsWith("@clerk.user") && o.userEmail && (
                            <p className="text-xs text-muted-foreground/70">{o.userEmail}</p>
                          )}
                        </div>
                      ) : sAddr?.fullName ? (
                        <p className="text-xs text-muted-foreground">{sAddr.fullName}</p>
                      ) : (
                        <p className="text-xs text-muted-foreground/70">-</p>
                      )}
                    </td>
                    {/* Seller column — for archived regular orders AND
                        archived pre-orders, shows business name + status
                        pill + email link. Both /admin/orders/archived and
                        /admin/orders/archived's archivedPreOrders query now
                        join sellers (through sellerListingVariantId ->
                        variant -> listing -> seller for pre-orders, directly
                        via orders.sellerId for regular orders). "Unknown
                        seller" only appears for legacy rows where the join
                        hits null (deleted seller, or pre-Phase-6 pre-order
                        with no sellerListingVariantId). */}
                    <td className="px-4 py-3.5">
                      {!sellerName ? (
                        <span className="text-xs text-muted-foreground/70 italic" title="Legacy order from before the marketplace migration, pre-Phase-6 pre-order with no sellerListingVariantId, or seller record deleted">
                          Unknown seller
                        </span>
                      ) : (
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
                          {sellerEmail && (
                            <a
                              href={`mailto:${sellerEmail}`}
                              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors truncate"
                              title={sellerEmail}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Mail className="h-3 w-3 shrink-0" />
                              <span className="truncate">{sellerEmail}</span>
                            </a>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="space-y-0.5 max-w-[180px]">
                        {isPreOrder ? (
                          <p className="text-xs text-muted-foreground truncate">{o.productName} ×{o.quantity ?? 1}</p>
                        ) : (
                          <>
                            {(o.items ?? []).slice(0, 2).map((item: any, idx: number) => (
                              <p key={idx} className="text-xs text-muted-foreground truncate">{item.productName} ×{item.quantity}</p>
                            ))}
                            {(o.items ?? []).length > 2 && (
                              <p className="text-xs text-muted-foreground/70">+{(o.items ?? []).length - 2} more</p>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-xs">
                      <div>
                        {o.orderStatus === "cancelled" ? (
                          <span className="inline-block bg-destructive/10 text-destructive text-xs font-medium px-2 py-0.5 rounded-lg mb-1">Cancelled</span>
                        ) : (
                          <span className="inline-block bg-success text-success-foreground text-xs font-medium px-2 py-0.5 rounded-lg mb-1">Delivered</span>
                        )}
                        <p className="text-muted-foreground/70">{new Date(o.updatedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</p>
                        {o.orderStatus === "cancelled" && o.cancellationReason && (
                          <p className="text-destructive/70 text-xs mt-0.5 max-w-[120px] truncate" title={o.cancellationReason}>⚠️ {o.cancellationReason}</p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <div>
                        <span className="text-xs bg-muted px-2 py-1 rounded-lg font-medium text-muted-foreground capitalize">{o.paymentMethod ?? "-"}</span>
                        <span className={`ml-1.5 text-xs font-medium capitalize ${o.paymentStatus === "paid" ? "text-success-foreground" : "text-warning-foreground"}`}>
                          · {o.paymentStatus}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-right font-semibold text-foreground">Tk{Number(o.totalAmount ?? o.discountedPrice ?? 0).toLocaleString()}</td>
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
              className="px-6 py-2 text-sm font-medium rounded-xl border border-border hover:bg-muted transition-colors disabled:opacity-50"
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
