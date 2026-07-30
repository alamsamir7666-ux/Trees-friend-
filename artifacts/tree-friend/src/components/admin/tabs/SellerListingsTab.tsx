import { useState, useMemo } from "react";
import {
  Loader2, Clock, CheckCircle2, XCircle, Search, ChevronDown,
  ChevronLeft, ChevronRight, Filter, Check, X, Sprout,
  ArrowUpDown, Store, Package2, Eye, EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  useListAdminSellerListings,
  useApproveSellerListing,
  useRejectSellerListing,
  getListAdminSellerListingsQueryKey,
  ListAdminSellerListingsApprovalStatus,
  type AdminSellerListing,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/* ─── Constants ────────────────────────────────────────────────────────── */

const PAGE_SIZE = 20;

const STATUS_FILTERS = [
  { value: undefined as ListAdminSellerListingsApprovalStatus | undefined, label: "All" },
  { value: ListAdminSellerListingsApprovalStatus.pending, label: "Pending" },
  { value: ListAdminSellerListingsApprovalStatus.approved, label: "Approved" },
  { value: ListAdminSellerListingsApprovalStatus.rejected, label: "Rejected" },
] as const;

const STATUS_META: Record<string, { icon: React.ElementType; chip: string; dot: string }> = {
  pending:  { icon: Clock,       chip: "bg-amber-50 text-amber-700 ring-amber-200/60", dot: "bg-amber-500" },
  approved: { icon: CheckCircle2, chip: "bg-emerald-50 text-emerald-700 ring-emerald-200/60", dot: "bg-emerald-500" },
  rejected: { icon: XCircle,     chip: "bg-rose-50 text-rose-700 ring-rose-200/60", dot: "bg-rose-500" },
};

type SortKey = "newest" | "oldest" | "name_asc" | "name_desc";

/* ─── Helpers ──────────────────────────────────────────────────────────── */

function formatTk(n: number): string {
  return `Tk${Math.round(Number(n) || 0).toLocaleString()}`;
}

function variantSummary(variants: { price: number; discountPrice?: number | null; stock: number }[]): {
  priceLabel: string; totalStock: number; variantCount: number;
} {
  if (variants.length === 0) return { priceLabel: "—", totalStock: 0, variantCount: 0 };
  const prices = variants.map((v) => v.discountPrice ?? v.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return {
    priceLabel: min === max ? formatTk(min) : `${formatTk(min)}–${formatTk(max)}`,
    totalStock: variants.reduce((sum, v) => sum + v.stock, 0),
    variantCount: variants.length,
  };
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/* ─── Component ────────────────────────────────────────────────────────── */

export function SellerListingsTab() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<ListAdminSellerListingsApprovalStatus | undefined>(
    ListAdminSellerListingsApprovalStatus.pending,
  );
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const { data: listings, isLoading } = useListAdminSellerListings({ approvalStatus: filter });
  const approve = useApproveSellerListing();
  const reject = useRejectSellerListing();

  function invalidate() {
    qc.invalidateQueries({ queryKey: getListAdminSellerListingsQueryKey({ approvalStatus: filter }) });
  }

  function handleApprove(id: number) {
    approve.mutate(
      { id },
      {
        onSuccess: () => { toast.success("Listing approved"); invalidate(); },
        onError: (err: any) => toast.error(err?.message ?? "Failed to approve"),
      },
    );
  }

  function handleReject(id: number) {
    reject.mutate(
      { id, data: { reason: rejectReason.trim() || undefined } },
      {
        onSuccess: () => { toast.success("Listing rejected"); setRejectingId(null); setRejectReason(""); invalidate(); },
        onError: (err: any) => toast.error(err?.message ?? "Failed to reject"),
      },
    );
  }

  /* Bulk approve */
  function handleBulkApprove() {
    if (selected.size === 0) return;
    let count = 0;
    selected.forEach((id) => {
      const l = listings?.find((x) => x.id === id);
      if (l?.approvalStatus === "pending") {
        approve.mutate(
          { id },
          {
            onSuccess: () => { count++; if (count === selected.size) { toast.success(`${count} listings approved`); setSelected(new Set()); invalidate(); } },
            onError: (err: any) => toast.error(err?.message ?? "Failed to approve"),
          },
        );
      }
    });
  }

  /* Selection helpers */
  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (!listings) return;
    const pendingIds = listings.filter((l) => l.approvalStatus === "pending").map((l) => l.id);
    if (selected.size === pendingIds.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(pendingIds));
    }
  }

  /* Derived: filtered + sorted + paginated */
  const processed = useMemo(() => {
    if (!listings) return [];
    let result = [...listings];

    // Search
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(
        (l) =>
          l.productName.toLowerCase().includes(q) ||
          l.sellerBusinessName.toLowerCase().includes(q) ||
          (l as any).description?.toLowerCase().includes(q),
      );
    }

    // Sort
    switch (sort) {
      case "newest":
        result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        break;
      case "oldest":
        result.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        break;
      case "name_asc":
        result.sort((a, b) => a.productName.localeCompare(b.productName));
        break;
      case "name_desc":
        result.sort((a, b) => b.productName.localeCompare(a.productName));
        break;
    }

    return result;
  }, [listings, search, sort]);

  const totalPages = Math.max(1, Math.ceil(processed.length / PAGE_SIZE));
  const paged = processed.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pendingCount = listings?.filter((l) => l.approvalStatus === "pending").length ?? 0;

  /* ─── Stats ─────────────────────────────────────────────────────────── */
  const stats = useMemo(() => {
    if (!listings) return { total: 0, pending: 0, approved: 0, rejected: 0 };
    return {
      total: listings.length,
      pending: listings.filter((l) => l.approvalStatus === "pending").length,
      approved: listings.filter((l) => l.approvalStatus === "approved").length,
      rejected: listings.filter((l) => l.approvalStatus === "rejected").length,
    };
  }, [listings]);

  const statCards = [
    { label: "Total", value: stats.total, icon: Package2, color: "bg-violet-50 text-violet-700" },
    { label: "Pending", value: stats.pending, icon: Clock, color: "bg-amber-50 text-amber-700" },
    { label: "Approved", value: stats.approved, icon: CheckCircle2, color: "bg-emerald-50 text-emerald-700" },
    { label: "Rejected", value: stats.rejected, icon: XCircle, color: "bg-rose-50 text-rose-700" },
  ];

  /* ─── Render ────────────────────────────────────────────────────────── */

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
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by product name, seller, or description…"
            className="pl-9 h-10 rounded-xl bg-card"
          />
        </div>
        <div className="flex items-center gap-2">
          <Select value={filter ?? "all"} onValueChange={(v) => { setFilter(v === "all" ? undefined : v as ListAdminSellerListingsApprovalStatus); setPage(1); setSelected(new Set()); }}>
            <SelectTrigger className="h-10 w-[160px] rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((f) => (
                <SelectItem key={f.label} value={f.label === "All" ? "all" : f.value!}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="h-10 w-[160px] rounded-xl">
              <ArrowUpDown className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
              <SelectItem value="name_asc">Name A–Z</SelectItem>
              <SelectItem value="name_desc">Name Z–A</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 bg-primary/5 border border-primary/20 rounded-xl px-4 py-2.5">
          <span className="text-sm font-medium text-foreground">{selected.size} selected</span>
          <div className="h-4 w-px bg-border" />
          <Button size="sm" className="h-7 rounded-lg text-xs" onClick={handleBulkApprove} disabled={approve.isPending}>
            {approve.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
            Approve all
          </Button>
          <Button size="sm" variant="ghost" className="h-7 rounded-lg text-xs" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      {/* Table header */}
      <div className="hidden md:grid grid-cols-[36px_1fr_140px_120px_90px_100px_110px] gap-3 px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground font-semibold border-b border-border">
        <div className="flex items-center">
          <input
            type="checkbox"
            checked={selected.size > 0 && selected.size === pendingCount}
            onChange={toggleSelectAll}
            className="h-4 w-4 rounded border-border accent-primary"
          />
        </div>
        <div>Listing</div>
        <div>Seller</div>
        <div>Price</div>
        <div>Stock</div>
        <div>Status</div>
        <div className="text-right">Actions</div>
      </div>

      {/* Listings */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : processed.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 gap-4 bg-card rounded-2xl border border-border">
          <div className="h-20 w-20 rounded-full bg-muted/60 flex items-center justify-center">
            <Sprout className="h-9 w-9 text-muted-foreground/60" />
          </div>
          <div className="text-center max-w-xs">
            <p className="text-foreground font-semibold text-base mb-1">
              {search ? "No listings match your search" : `No ${filter ?? ""} listings`}
            </p>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {search ? "Try adjusting your search terms or filters." : "Listings will appear here when sellers submit products for approval."}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          {paged.map((l) => {
            const meta = STATUS_META[l.approvalStatus] ?? STATUS_META.pending;
            const StatusIcon = meta.icon;
            const vs = variantSummary(l.variants);
            const isPending = l.approvalStatus === "pending";
            const img = (l as any).images?.[0] || (l as any).productImage;

            return (
              <div key={l.id} className="group">
                {/* Desktop row */}
                <div className="hidden md:grid grid-cols-[36px_1fr_140px_120px_90px_100px_110px] gap-3 items-center px-4 py-3 rounded-xl hover:bg-muted/30 transition-colors">
                  {/* Checkbox */}
                  <div className="flex items-center">
                    {isPending && (
                      <input
                        type="checkbox"
                        checked={selected.has(l.id)}
                        onChange={() => toggleSelect(l.id)}
                        className="h-4 w-4 rounded border-border accent-primary"
                      />
                    )}
                  </div>

                  {/* Listing info */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-10 w-10 rounded-lg bg-muted/40 overflow-hidden shrink-0">
                      {img ? (
                        <img src={img} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center">
                          <Package2 className="h-4 w-4 text-muted-foreground/40" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{l.productName}</p>
                      <p className="text-[11px] text-muted-foreground">{vs.variantCount} variant{vs.variantCount !== 1 ? "s" : ""} · {formatDate(l.createdAt)}</p>
                    </div>
                  </div>

                  {/* Seller */}
                  <div className="min-w-0">
                    <p className="text-sm text-foreground truncate">{l.sellerBusinessName}</p>
                  </div>

                  {/* Price */}
                  <p className="text-sm font-medium text-foreground tabular-nums">{vs.priceLabel}</p>

                  {/* Stock */}
                  <p className={cn("text-sm tabular-nums", vs.totalStock === 0 ? "text-rose-600 font-medium" : "text-foreground")}>
                    {vs.totalStock}
                  </p>

                  {/* Status */}
                  <span className={cn("inline-flex items-center gap-1 text-xs font-medium rounded-full px-2 py-0.5 ring-1 w-fit", meta.chip)}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
                    {l.approvalStatus}
                  </span>

                  {/* Actions */}
                  <div className="flex items-center justify-end gap-1.5">
                    {isPending && (
                      <>
                        <Button size="sm" className="h-7 rounded-lg text-xs px-2.5" onClick={() => handleApprove(l.id)} disabled={approve.isPending}>
                          <Check className="h-3 w-3 mr-1" /> Approve
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 rounded-lg text-xs px-2.5" onClick={() => setRejectingId(rejectingId === l.id ? null : l.id)}>
                          <X className="h-3 w-3 mr-1" /> Reject
                        </Button>
                      </>
                    )}
                    {l.approvalStatus === "approved" && (
                      <span className="text-[11px] text-muted-foreground">No actions</span>
                    )}
                    {l.approvalStatus === "rejected" && l.rejectionReason && (
                      <span className="text-[11px] text-rose-600 truncate max-w-[100px]" title={l.rejectionReason}>{l.rejectionReason}</span>
                    )}
                  </div>
                </div>

                {/* Mobile card */}
                <div className="md:hidden rounded-2xl border border-border bg-card p-4">
                  <div className="flex items-start gap-3">
                    {isPending && (
                      <input
                        type="checkbox"
                        checked={selected.has(l.id)}
                        onChange={() => toggleSelect(l.id)}
                        className="h-4 w-4 rounded border-border accent-primary mt-1"
                      />
                    )}
                    <div className="h-12 w-12 rounded-lg bg-muted/40 overflow-hidden shrink-0">
                      {img ? (
                        <img src={img} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center">
                          <Package2 className="h-5 w-5 text-muted-foreground/40" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-foreground">{l.productName}</p>
                        <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium rounded-full px-2 py-0.5 ring-1", meta.chip)}>
                          <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
                          {l.approvalStatus}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {l.sellerBusinessName} · {vs.priceLabel} · Stock: {vs.totalStock}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{vs.variantCount} variant{vs.variantCount !== 1 ? "s" : ""} · {formatDate(l.createdAt)}</p>
                    </div>
                  </div>

                  {/* Rejection reason */}
                  {l.rejectionReason && (
                    <p className="text-xs text-rose-600 mt-2 bg-rose-50 rounded-lg px-2.5 py-1.5">
                      <span className="font-medium">Rejected:</span> {l.rejectionReason}
                    </p>
                  )}

                  {/* Actions */}
                  {isPending && (
                    <div className="mt-3 flex items-center gap-2">
                      <Button size="sm" className="h-7 rounded-lg text-xs flex-1" onClick={() => handleApprove(l.id)} disabled={approve.isPending}>
                        {approve.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />} Approve
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 rounded-lg text-xs flex-1" onClick={() => setRejectingId(rejectingId === l.id ? null : l.id)}>
                        <X className="h-3 w-3 mr-1" /> Reject
                      </Button>
                    </div>
                  )}
                </div>

                {/* Reject reason inline */}
                {rejectingId === l.id && (
                  <div className="mt-1 flex items-center gap-2 bg-rose-50 border border-rose-200 rounded-xl p-2.5">
                    <input
                      autoFocus
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="Reason for rejection (optional, shown to seller)"
                      className="flex-1 bg-card rounded-lg border border-border px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-rose-300"
                    />
                    <Button size="sm" variant="destructive" className="h-7 rounded-lg text-xs shrink-0" onClick={() => handleReject(l.id)} disabled={reject.isPending}>
                      {reject.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirm"}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 rounded-lg text-xs shrink-0" onClick={() => setRejectingId(null)}>
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {processed.length > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3 pt-2">
          <p className="text-xs text-muted-foreground">
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, processed.length)} of {processed.length}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0 rounded-lg"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let pageNum: number;
              if (totalPages <= 5) {
                pageNum = i + 1;
              } else if (page <= 3) {
                pageNum = i + 1;
              } else if (page >= totalPages - 2) {
                pageNum = totalPages - 4 + i;
              } else {
                pageNum = page - 2 + i;
              }
              return (
                <Button
                  key={pageNum}
                  variant={page === pageNum ? "default" : "outline"}
                  size="sm"
                  className="h-8 w-8 p-0 rounded-lg text-xs"
                  onClick={() => setPage(pageNum)}
                >
                  {pageNum}
                </Button>
              );
            })}
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0 rounded-lg"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
