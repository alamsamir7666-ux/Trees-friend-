import { useState } from "react";
import { PackageX, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  useListSellerReturns,
  useUpdateSellerReturn,
  getListSellerReturnsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * Seller "Returns" tab. Mirrors the shape and interaction pattern of admin's
 * ReturnsTab.tsx (approve/reject/complete-with-refund) but scoped to the
 * seller's own orders via GET/PUT /api/seller/returns -- server-side
 * ownership is enforced by requireSeller + an explicit orders.sellerId
 * check, this component just renders what the API already scoped for us.
 *
 * Status colors intentionally match admin's ReturnsTab.tsx exactly, since
 * both are describing the same returnsTable.status vocabulary.
 */

const statusColors: Record<string, string> = {
  requested: "bg-amber-100 text-amber-700 border border-amber-200",
  approved: "bg-blue-100 text-blue-700 border border-blue-200",
  rejected: "bg-red-100 text-red-700 border border-red-200",
  completed: "bg-emerald-100 text-emerald-700 border border-emerald-200",
};

const STATUS_FILTERS = ["all", "requested", "approved", "rejected", "completed"] as const;

export function SellerReturnsTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [page, setPage] = useState(1);
  const [refundInputs, setRefundInputs] = useState<Record<number, string>>({});

  const { data, isLoading } = useListSellerReturns({
    status: statusFilter === "all" ? undefined : statusFilter,
    page,
    limit: 15,
  });
  const updateReturn = useUpdateSellerReturn();

  function invalidate() {
    qc.invalidateQueries({ queryKey: getListSellerReturnsQueryKey() });
  }

  function updateStatus(id: number, status: "approved" | "rejected" | "completed", adminNote?: string, refundAmount?: string) {
    updateReturn.mutate(
      { id, data: { status, adminNote, refundAmount: refundAmount ? Number(refundAmount) : undefined } },
      {
        onSuccess: () => {
          toast.success(
            status === "approved" ? "Return approved" : status === "rejected" ? "Return rejected" : "Return marked completed",
          );
          invalidate();
        },
        onError: (err: any) => {
          toast.error(err?.message ?? "Failed to update return");
        },
      },
    );
  }

  const returns = data?.returns ?? [];
  const totalPages = data?.totalPages ?? 1;

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <div key={i} className="h-32 bg-muted animate-pulse rounded-2xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-lg font-semibold text-gray-900">Return Requests</h2>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v as typeof statusFilter); setPage(1); }}>
          <SelectTrigger className="w-40 rounded-xl">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((s) => (
              <SelectItem key={s} value={s}>
                {s === "all" ? "All statuses" : s.charAt(0).toUpperCase() + s.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {returns.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center bg-white rounded-2xl border">
          <PackageX className="h-10 w-10 text-gray-200 mb-3" />
          <p className="text-sm text-muted-foreground">No return requests yet.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {returns.map((ret) => {
            const items = ret.orderItems ?? [];
            const isUpdating = updateReturn.isPending && updateReturn.variables?.id === ret.id;
            return (
              <div key={ret.id} className="bg-white border rounded-2xl overflow-hidden shadow-sm">
                <div className="flex items-center justify-between px-4 py-3 bg-muted/40 border-b flex-wrap gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm">Return #{ret.id}</span>
                    <span className="text-muted-foreground text-xs">·</span>
                    <span className="text-xs text-muted-foreground">Order #{ret.orderId}</span>
                    {ret.customerName && (
                      <>
                        <span className="text-muted-foreground text-xs">·</span>
                        <span className="text-xs text-muted-foreground">{ret.customerName}</span>
                      </>
                    )}
                  </div>
                  <span className={`text-xs px-2.5 py-1 rounded-full font-medium shrink-0 ${statusColors[ret.status] ?? "bg-muted"}`}>
                    {ret.status}
                  </span>
                </div>
                <div className="p-4 space-y-4">
                  {items.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Items in order</p>
                      <div className="space-y-2">
                        {items.map((item: any, idx: number) => (
                          <div key={idx} className="flex items-center gap-3 bg-muted/30 rounded-xl p-2.5">
                            {item.productImage && (
                              <img src={item.productImage} alt={item.productName} className="w-12 h-12 rounded-lg object-cover shrink-0 border" />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{item.productName}</p>
                              <p className="text-xs text-muted-foreground">Qty: {item.quantity}</p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-sm font-semibold">Tk{(item.price * item.quantity).toLocaleString()}</p>
                              <p className="text-xs text-muted-foreground">Tk{item.price} each</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3">
                    <p className="text-xs font-medium text-amber-700 mb-1">Customer reason</p>
                    <p className="text-sm text-foreground">{ret.reason}</p>
                  </div>

                  {ret.adminNote && (
                    <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
                      <p className="text-xs font-medium text-blue-700 mb-1">Note</p>
                      <p className="text-sm">{ret.adminNote}</p>
                    </div>
                  )}

                  {ret.refundAmount != null && ret.status === "completed" && (
                    <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-3 flex items-center justify-between">
                      <span className="text-xs font-medium text-emerald-700">Refund issued</span>
                      <span className="text-lg font-bold text-emerald-700">Tk{Number(ret.refundAmount).toLocaleString()}</span>
                    </div>
                  )}

                  {ret.status === "requested" && (
                    <div className="flex gap-2 pt-1">
                      <Button
                        onClick={() => updateStatus(ret.id, "approved")}
                        disabled={isUpdating}
                        className="flex-1 rounded-xl bg-blue-500 hover:bg-blue-600"
                      >
                        {isUpdating ? <Loader2 className="h-4 w-4 animate-spin" /> : "Approve Return"}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          const note = prompt("Rejection reason (min 3 characters)?");
                          if (note && note.trim().length >= 3) updateStatus(ret.id, "rejected", note);
                          else if (note !== null) toast.error("Please provide a reason (min 3 characters)");
                        }}
                        disabled={isUpdating}
                        className="flex-1 rounded-xl border-red-200 text-red-600 hover:bg-red-50"
                      >
                        Reject
                      </Button>
                    </div>
                  )}

                  {ret.status === "approved" && (
                    <div className="space-y-2 pt-1">
                      <p className="text-xs text-muted-foreground">Enter refund amount to mark as completed</p>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          placeholder="Refund amount (Tk)"
                          min="0"
                          value={refundInputs[ret.id] ?? ""}
                          onChange={(e) => setRefundInputs((prev) => ({ ...prev, [ret.id]: e.target.value }))}
                          className="flex-1 text-sm border rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                        />
                        <Button
                          onClick={() => {
                            const amt = refundInputs[ret.id];
                            if (amt) updateStatus(ret.id, "completed", undefined, amt);
                          }}
                          disabled={isUpdating || !refundInputs[ret.id]}
                          className="rounded-xl bg-emerald-500 hover:bg-emerald-600"
                        >
                          {isUpdating ? <Loader2 className="h-4 w-4 animate-spin" /> : "Complete"}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <Button variant="outline" size="sm" className="rounded-xl" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground">Page {page} of {totalPages}</span>
          <Button variant="outline" size="sm" className="rounded-xl" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
