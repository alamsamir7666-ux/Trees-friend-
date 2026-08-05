import { useState, useMemo } from "react";
import {
  PackageX, Loader2, ChevronLeft, ChevronRight, Clock, CheckCircle2,
  XCircle, PackageCheck, RotateCcw, Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
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

const STATUS_META: Record<
  string,
  { label: string; icon: React.ElementType; chip: string; dot: string }
> = {
  requested: { label: "Requested", icon: Clock, chip: "bg-warning text-warning-foreground ring-warning-border/60", dot: "bg-warning-foreground" },
  approved: { label: "Approved", icon: CheckCircle2, chip: "bg-info text-info-foreground ring-info-border/60", dot: "bg-info-foreground" },
  rejected: { label: "Rejected", icon: XCircle, chip: "bg-destructive/10 text-destructive ring-destructive/20", dot: "bg-destructive" },
  completed: { label: "Completed", icon: PackageCheck, chip: "bg-success text-success-foreground ring-success-border/60", dot: "bg-success-foreground" },
};

const STATUS_FILTERS = ["all", "requested", "approved", "rejected", "completed"] as const;

function formatTk(n: number): string {
  return `Tk${Math.round(Number(n) || 0).toLocaleString()}`;
}

export function SellerReturnsTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [refundInputs, setRefundInputs] = useState<Record<number, string>>({});
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  const { data, isLoading } = useListSellerReturns({
    status: statusFilter === "all" ? undefined : statusFilter,
    page,
    limit: 15,
  });
  const updateReturn = useUpdateSellerReturn();

  function invalidate() {
    qc.invalidateQueries({ queryKey: getListSellerReturnsQueryKey() });
  }

  function updateStatus(
    id: number,
    status: "approved" | "rejected" | "completed",
    adminNote?: string,
    refundAmount?: string,
  ) {
    updateReturn.mutate(
      { id, data: { status, adminNote, refundAmount: refundAmount ? Number(refundAmount) : undefined } },
      {
        onSuccess: () => {
          toast.success(
            status === "approved" ? "Return approved" : status === "rejected" ? "Return rejected" : "Return marked completed",
          );
          invalidate();
          if (status === "rejected") {
            setRejectingId(null);
            setRejectNote("");
          }
        },
        onError: (err: any) => toast.error(err?.message ?? "Failed to update return"),
      },
    );
  }

  const returns = data?.returns ?? [];
  const totalPages = data?.totalPages ?? 1;

  const filtered = useMemo(() => {
    if (!search.trim()) return returns;
    const q = search.trim().toLowerCase();
    return returns.filter(
      (r: any) =>
        `#${r.id}`.toLowerCase().includes(q) ||
        `#${r.orderId}`.toLowerCase().includes(q) ||
        r.customerName?.toLowerCase().includes(q),
    );
  }, [returns, search]);

  // Stats
  const stats = useMemo(() => {
    const all = data?.returns ?? [];
    return {
      total: all.length,
      requested: all.filter((r: any) => r.status === "requested").length,
      approved: all.filter((r: any) => r.status === "approved").length,
      completed: all.filter((r: any) => r.status === "completed").length,
    };
  }, [data]);

  const statCards = [
    { label: "Total Returns", value: stats.total, icon: RotateCcw, color: "bg-info text-info-foreground" },
    { label: "Pending Action", value: stats.requested, icon: Clock, color: "bg-warning text-warning-foreground" },
    { label: "Approved", value: stats.approved, icon: CheckCircle2, color: "bg-info text-info-foreground" },
    { label: "Completed", value: stats.completed, icon: PackageCheck, color: "bg-success text-success-foreground" },
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

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by return ID, order ID, or customer…"
            className="pl-9 h-10 rounded-xl bg-card"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => { setStatusFilter(v as typeof statusFilter); setPage(1); }}
        >
          <SelectTrigger className="h-10 w-full sm:w-[180px] rounded-xl">
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

      {/* Content */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-40 rounded-2xl" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-card rounded-2xl border border-border p-12 text-center">
          <div className="h-16 w-16 mx-auto mb-4 rounded-2xl bg-muted flex items-center justify-center">
            <PackageX className="h-8 w-8 text-muted-foreground/50" />
          </div>
          <p className="font-semibold text-foreground mb-1">No return requests</p>
          <p className="text-sm text-muted-foreground">
            {statusFilter !== "all" || search ? "Try clearing your filters." : "Returns will appear here when buyers request them."}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((ret: any) => {
            const items = ret.orderItems ?? [];
            const isUpdating = updateReturn.isPending && updateReturn.variables?.id === ret.id;
            const meta = STATUS_META[ret.status] ?? STATUS_META.requested;
            const StatusIcon = meta.icon;
            return (
              <div key={ret.id} className="bg-card border border-border rounded-2xl overflow-hidden">
                {/* Card header */}
                <div className="flex items-center justify-between px-5 py-3.5 bg-muted/40 border-b border-border gap-2 flex-wrap">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center shrink-0", meta.chip.split(" ")[0])}>
                      <StatusIcon className="h-4 w-4" />
                    </div>
                    <span className="font-semibold text-sm text-foreground">Return #{ret.id}</span>
                    <span className="text-muted-foreground text-xs">·</span>
                    <span className="text-xs text-muted-foreground">Order #{ret.orderId}</span>
                    {ret.customerName && (
                      <>
                        <span className="text-muted-foreground text-xs">·</span>
                        <span className="text-xs text-muted-foreground">{ret.customerName}</span>
                      </>
                    )}
                  </div>
                  <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-2.5 py-1 ring-1 capitalize shrink-0", meta.chip)}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
                    {meta.label}
                  </span>
                </div>

                {/* Body */}
                <div className="p-5 space-y-4">
                  {items.length > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Items in order</p>
                      <div className="space-y-1.5">
                        {items.map((item: any, idx: number) => (
                          <div key={idx} className="flex items-center gap-3 bg-muted/40 rounded-lg p-2.5 border border-border/60">
                            {item.productImage ? (
                              <img src={item.productImage} alt={item.productName} className="w-12 h-12 rounded-lg object-cover shrink-0 border border-border" />
                            ) : (
                              <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center shrink-0 border border-border">
                                <PackageX className="h-4 w-4 text-muted-foreground/50" />
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-foreground truncate">{item.productName}</p>
                              <p className="text-xs text-muted-foreground">Qty: {item.quantity} · {formatTk(item.price)} each</p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-sm font-semibold text-foreground tabular-nums">
                                {formatTk(item.price * item.quantity)}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Reason */}
                  <div className="bg-warning border border-warning-border rounded-xl px-4 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-warning-foreground mb-1">Customer reason</p>
                    <p className="text-sm text-foreground">{ret.reason}</p>
                  </div>

                  {ret.adminNote && (
                    <div className="bg-info border border-info-border rounded-xl px-4 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-info-foreground mb-1">Internal note</p>
                      <p className="text-sm text-foreground">{ret.adminNote}</p>
                    </div>
                  )}

                  {ret.refundAmount != null && ret.status === "completed" && (
                    <div className="bg-success border border-success-border rounded-xl px-4 py-3 flex items-center justify-between">
                      <span className="text-sm font-medium text-success-foreground">Refund issued</span>
                      <span className="text-lg font-bold text-success-foreground tabular-nums">{formatTk(Number(ret.refundAmount))}</span>
                    </div>
                  )}

                  {/* Actions: requested */}
                  {ret.status === "requested" && (
                    <div className="flex flex-col sm:flex-row gap-2 pt-1">
                      <Button
                        onClick={() => updateStatus(ret.id, "approved")}
                        disabled={isUpdating}
                        className="flex-1 rounded-xl"
                      >
                        {isUpdating ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <CheckCircle2 className="h-4 w-4 mr-1.5" />}
                        Approve Return
                      </Button>
                      {rejectingId === ret.id ? (
                        <div className="flex-1 flex items-center gap-2 bg-destructive/10 border border-destructive/20 rounded-xl p-2">
                          <input
                            autoFocus
                            value={rejectNote}
                            onChange={(e) => setRejectNote(e.target.value)}
                            placeholder="Reason (min 3 chars)…"
                            className="flex-1 bg-card rounded-lg border border-border px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-destructive/30"
                          />
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-7 rounded-lg text-xs"
                            disabled={isUpdating || rejectNote.trim().length < 3}
                            onClick={() => updateStatus(ret.id, "rejected", rejectNote.trim())}
                          >
                            Confirm
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 rounded-lg text-xs"
                            onClick={() => { setRejectingId(null); setRejectNote(""); }}
                          >
                            Back
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          onClick={() => { setRejectingId(ret.id); setRejectNote(""); }}
                          disabled={isUpdating}
                          className="flex-1 rounded-xl border-destructive/20 text-destructive hover:bg-destructive/10"
                        >
                          <XCircle className="h-4 w-4 mr-1.5" />
                          Reject
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Actions: approved (complete with refund) */}
                  {ret.status === "approved" && (
                    <div className="space-y-2 pt-1">
                      <p className="text-xs text-muted-foreground">Enter refund amount to mark as completed</p>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">Tk</span>
                          <Input
                            type="number"
                            placeholder="0"
                            min="0"
                            value={refundInputs[ret.id] ?? ""}
                            onChange={(e) => setRefundInputs((prev) => ({ ...prev, [ret.id]: e.target.value }))}
                            className="pl-9 rounded-xl"
                          />
                        </div>
                        <Button
                          onClick={() => {
                            const amt = refundInputs[ret.id];
                            if (amt) updateStatus(ret.id, "completed", undefined, amt);
                          }}
                          disabled={isUpdating || !refundInputs[ret.id]}
                          className="rounded-xl"
                        >
                          {isUpdating ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <PackageCheck className="h-4 w-4 mr-1.5" />}
                          Complete
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

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <Button
            variant="outline"
            size="sm"
            className="rounded-xl"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">Page {page} of {totalPages}</span>
          <Button
            variant="outline"
            size="sm"
            className="rounded-xl"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
