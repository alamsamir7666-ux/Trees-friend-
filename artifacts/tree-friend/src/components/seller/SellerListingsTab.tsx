import { useState, useMemo } from "react";
import {
  Plus, Sprout, Eye, EyeOff, Pencil, Trash2, Clock, CheckCircle2, XCircle,
  Package2, Search, LayoutGrid, List, AlertCircle, Loader2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  useListMySellerListings,
  useUpdateSellerListing,
  useDeleteSellerListing,
  getListMySellerListingsQueryKey,
  type SellerListing,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SellerListingForm } from "@/components/seller/SellerListingForm";

const APPROVAL_BADGE: Record<
  string,
  { icon: React.ElementType; className: string; label: string }
> = {
  pending: { icon: Clock, className: "bg-amber-50 text-amber-700 ring-amber-200/60", label: "Pending" },
  approved: { icon: CheckCircle2, className: "bg-emerald-50 text-emerald-700 ring-emerald-200/60", label: "Approved" },
  rejected: { icon: XCircle, className: "bg-rose-50 text-rose-700 ring-rose-200/60", label: "Rejected" },
};

function variantPriceStockSummary(variants: SellerListing["variants"]): {
  priceLabel: string;
  totalStock: number;
  variantCount: number;
} {
  if (variants.length === 0) return { priceLabel: "—", totalStock: 0, variantCount: 0 };
  const prices = variants.map((v) => v.discountPrice ?? v.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const priceLabel = min === max ? `Tk${min}` : `Tk${min}–${max}`;
  const totalStock = variants.reduce((sum, v) => sum + v.stock, 0);
  return { priceLabel, totalStock, variantCount: variants.length };
}

function formatTk(n: number): string {
  return `Tk${Math.round(n).toLocaleString()}`;
}

export function SellerListingsTab() {
  const qc = useQueryClient();
  const { data: listings, isLoading: listingsLoading } = useListMySellerListings();
  const updateListing = useUpdateSellerListing();
  const deleteListing = useDeleteSellerListing();

  const [showForm, setShowForm] = useState(false);
  const [editingListing, setEditingListing] = useState<SellerListing | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "approved" | "pending" | "rejected">("all");
  const [view, setView] = useState<"list" | "grid">("list");

  function invalidate() {
    qc.invalidateQueries({ queryKey: getListMySellerListingsQueryKey() });
  }

  function openCreate() {
    setEditingListing(undefined);
    setShowForm(true);
  }

  function openEdit(l: SellerListing) {
    setEditingListing(l);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingListing(undefined);
  }

  function toggleVisibility(l: SellerListing) {
    const nextVisibility = l.visibility === "public" ? "hidden" : "public";
    updateListing.mutate(
      { id: l.id, data: { visibility: nextVisibility } },
      {
        onSuccess: () => {
          toast.success(nextVisibility === "public" ? "Listing is now visible" : "Listing hidden");
          invalidate();
        },
        onError: (err: any) => toast.error(err?.message ?? "Failed to update visibility"),
      },
    );
  }

  function handleDelete(l: SellerListing) {
    if (!confirm("Delete this listing? This cannot be undone.")) return;
    deleteListing.mutate(
      { id: l.id },
      {
        onSuccess: () => { toast.success("Listing deleted"); invalidate(); },
        onError: (err: any) => toast.error(err?.message ?? "Failed to delete listing"),
      },
    );
  }

  const filtered = useMemo(() => {
    if (!listings) return [];
    return listings.filter((l) => {
      if (statusFilter !== "all" && l.approvalStatus !== statusFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (!`Product #${l.productId}`.toLowerCase().includes(q) &&
            !(l.description ?? "").toLowerCase().includes(q) &&
            !l.tags.some((t) => t.toLowerCase().includes(q))) {
          return false;
        }
      }
      return true;
    });
  }, [listings, statusFilter, search]);

  // Stats summary
  const stats = useMemo(() => {
    if (!listings) return { total: 0, approved: 0, pending: 0, rejected: 0, lowStock: 0, hidden: 0 };
    return {
      total: listings.length,
      approved: listings.filter((l) => l.approvalStatus === "approved").length,
      pending: listings.filter((l) => l.approvalStatus === "pending").length,
      rejected: listings.filter((l) => l.approvalStatus === "rejected").length,
      lowStock: listings.filter((l) =>
        l.variants.length > 0 && l.variants.every((v) => v.stock <= 5),
      ).length,
      hidden: listings.filter((l) => l.visibility === "hidden").length,
    };
  }, [listings]);

  if (showForm) {
    return <SellerListingForm editing={editingListing} onDone={closeForm} onCancel={closeForm} />;
  }

  const statCards = [
    { label: "Total Listings", value: stats.total, icon: Package2, color: "bg-violet-50 text-violet-700" },
    { label: "Approved", value: stats.approved, icon: CheckCircle2, color: "bg-emerald-50 text-emerald-700" },
    { label: "Pending Review", value: stats.pending, icon: Clock, color: "bg-amber-50 text-amber-700" },
    { label: "Low Stock", value: stats.lowStock, icon: AlertCircle, color: "bg-rose-50 text-rose-700" },
  ];

  return (
    <div className="space-y-5">
      {/* Stat strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {statCards.map((s) => (
          <div
            key={s.label}
            className="rounded-2xl border border-border bg-card p-4 flex items-center gap-3"
          >
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
            placeholder="Search by product ID or name…"
            className="pl-9 h-10 rounded-xl bg-card"
          />
        </div>

        <div className="inline-flex rounded-xl bg-muted p-1 self-start sm:self-auto">
          {(["all", "approved", "pending", "rejected"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-all",
                statusFilter === s
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s === "all" ? "All" : s}
            </button>
          ))}
        </div>

        <div className="hidden sm:inline-flex rounded-xl bg-muted p-1">
          <button
            onClick={() => setView("list")}
            className={cn(
              "p-1.5 rounded-md transition-all",
              view === "list" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
            aria-label="List view"
          >
            <List className="h-4 w-4" />
          </button>
          <button
            onClick={() => setView("grid")}
            className={cn(
              "p-1.5 rounded-md transition-all",
              view === "grid" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
            aria-label="Grid view"
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
        </div>

        <Button onClick={openCreate} className="h-10 rounded-xl shrink-0">
          <Plus className="h-4 w-4 mr-1.5" />
          Add Listing
        </Button>
      </div>

      {/* Content */}
      {listingsLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-card rounded-2xl border border-border p-4 flex items-center gap-4">
              <Skeleton className="h-16 w-16 rounded-xl shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40 rounded-full" />
                <Skeleton className="h-3 w-24 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-card rounded-2xl border border-border p-12 text-center">
          <div className="h-16 w-16 mx-auto mb-4 rounded-2xl bg-muted flex items-center justify-center">
            <Sprout className="h-8 w-8 text-muted-foreground/50" />
          </div>
          <p className="font-semibold text-foreground mb-1">
            {listings && listings.length > 0 ? "No listings match your filters" : "No listings yet"}
          </p>
          <p className="text-sm text-muted-foreground mb-4">
            {listings && listings.length > 0
              ? "Try clearing your search or status filter."
              : "Add your first listing against an existing variety to start selling."}
          </p>
          {(!listings || listings.length === 0) && (
            <Button onClick={openCreate} className="rounded-xl">
              <Plus className="h-4 w-4 mr-1.5" />
              Add your first listing
            </Button>
          )}
        </div>
      ) : view === "list" ? (
        <div className="bg-card rounded-2xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead>
                <tr className="border-b border-border text-left bg-muted/40">
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Product</th>
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Price</th>
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Stock</th>
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Visibility</th>
                  <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {filtered.map((l) => {
                  const approval = APPROVAL_BADGE[l.approvalStatus] ?? APPROVAL_BADGE.pending;
                  const ApprovalIcon = approval.icon;
                  const { priceLabel, totalStock, variantCount } = variantPriceStockSummary(l.variants);
                  const isLowStock = variantCount > 0 && l.variants.every((v) => v.stock <= 5);
                  return (
                    <tr key={l.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          {l.images[0] ? (
                            <img
                              src={l.images[0]}
                              alt=""
                              className="h-12 w-12 rounded-lg object-cover border border-border shrink-0"
                            />
                          ) : (
                            <div className="h-12 w-12 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                              <Sprout className="h-4 w-4 text-muted-foreground" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-foreground">
                              {l.description?.trim() ? l.description.split("\\n")[0].slice(0, 60) : `Product #${l.productId}`}
                            </p>
                            <p className="text-[11px] text-muted-foreground">ID #{l.productId}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={cn("inline-flex items-center gap-1 text-xs font-medium rounded-full px-2 py-0.5 ring-1 capitalize", approval.className)}>
                          <ApprovalIcon className="h-3 w-3" />
                          {approval.label}
                        </span>
                        {l.approvalStatus === "rejected" && l.rejectionReason && (
                          <p className="text-[10px] text-rose-600 mt-1 max-w-[160px] truncate" title={l.rejectionReason}>
                            {l.rejectionReason}
                          </p>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-sm font-medium text-foreground tabular-nums">
                        {priceLabel}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={cn(
                          "text-sm font-semibold tabular-nums",
                          isLowStock && totalStock > 0 && "text-rose-600",
                          totalStock === 0 && "text-muted-foreground",
                        )}>
                          {totalStock}
                        </span>
                        <span className="text-[11px] text-muted-foreground ml-1">
                          · {variantCount} var
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        {l.visibility === "public" ? (
                          <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                            <Eye className="h-3 w-3" /> Visible
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <EyeOff className="h-3 w-3" /> Hidden
                          </span>
                        )}
                        {l.hiddenReason === "subscription_expired" && (
                          <p className="text-[10px] text-amber-600 mt-0.5">Auto: sub expired</p>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => toggleVisibility(l)}
                            disabled={updateListing.isPending}
                            className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                            title={l.visibility === "public" ? "Hide listing" : "Show listing"}
                          >
                            {l.visibility === "public" ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                          <button
                            onClick={() => openEdit(l)}
                            className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                            title="Edit"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(l)}
                            disabled={deleteListing.isPending}
                            className="p-1.5 rounded-lg text-muted-foreground hover:bg-rose-50 hover:text-rose-600 transition-colors"
                            title="Delete"
                          >
                            {deleteListing.isPending && deleteListing.variables?.id === l.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        // Grid view
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((l) => {
            const approval = APPROVAL_BADGE[l.approvalStatus] ?? APPROVAL_BADGE.pending;
            const ApprovalIcon = approval.icon;
            const { priceLabel, totalStock } = variantPriceStockSummary(l.variants);
            return (
              <div
                key={l.id}
                className="rounded-2xl border border-border bg-card overflow-hidden hover:shadow-md transition-shadow"
              >
                <div className="relative aspect-[4/3] bg-muted">
                  {l.images[0] ? (
                    <img src={l.images[0]} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="h-full w-full flex items-center justify-center">
                      <Sprout className="h-8 w-8 text-muted-foreground/40" />
                    </div>
                  )}
                  <span className={cn("absolute top-2 left-2 inline-flex items-center gap-1 text-[10px] font-medium rounded-full px-2 py-0.5 ring-1 capitalize backdrop-blur bg-card/80", approval.className)}>
                    <ApprovalIcon className="h-3 w-3" />
                    {approval.label}
                  </span>
                  {l.visibility === "hidden" && (
                    <span className="absolute top-2 right-2 inline-flex items-center gap-1 text-[10px] font-medium rounded-full px-2 py-0.5 ring-1 ring-border bg-card/80 backdrop-blur text-muted-foreground">
                      <EyeOff className="h-3 w-3" /> Hidden
                    </span>
                  )}
                </div>
                <div className="p-4">
                  <p className="text-sm font-medium text-foreground truncate mb-1">
                    {l.description?.trim() ? l.description.split("\n")[0].slice(0, 60) : `Product #${l.productId}`}
                  </p>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-foreground tabular-nums">{priceLabel}</span>
                    <span className="text-xs text-muted-foreground">Stock: {totalStock}</span>
                  </div>
                  <div className="mt-3 pt-3 border-t border-border/60 flex items-center justify-end gap-1">
                    <button
                      onClick={() => toggleVisibility(l)}
                      disabled={updateListing.isPending}
                      className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                      title={l.visibility === "public" ? "Hide" : "Show"}
                    >
                      {l.visibility === "public" ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                    <button
                      onClick={() => openEdit(l)}
                      className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                      title="Edit"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(l)}
                      disabled={deleteListing.isPending}
                      className="p-1.5 rounded-lg text-muted-foreground hover:bg-rose-50 hover:text-rose-600 transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
