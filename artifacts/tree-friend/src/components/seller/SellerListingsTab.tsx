import { useState } from "react";
import { Plus, Sprout, Eye, EyeOff, Pencil, Trash2, Clock, CheckCircle2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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

const APPROVAL_BADGE: Record<string, { icon: React.ElementType; className: string; label: string }> = {
  pending: { icon: Clock, className: "bg-amber-100 text-amber-700", label: "Pending Review" },
  approved: { icon: CheckCircle2, className: "bg-emerald-100 text-emerald-700", label: "Approved" },
  rejected: { icon: XCircle, className: "bg-red-100 text-red-700", label: "Rejected" },
};

/**
 * Phase 3a compile fix (not a redesign -- see phase prompt's "Do NOT touch
 * this phase" note on this file): price/stock moved off the listing onto a
 * nested `variants` array, so this read-only inventory row can no longer
 * show a single price/stock pair. Summarizes across all variants (price
 * range, using each variant's discount price when set, + total stock) so
 * the seller still sees enough at a glance; a full per-variant breakdown is
 * Phase 3b's job if wanted.
 */
function variantPriceStockSummary(variants: SellerListing["variants"]): string {
  if (variants.length === 0) return "No variants";
  const prices = variants.map((v) => v.discountPrice ?? v.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const priceLabel = min === max ? `Tk${min}` : `Tk${min}–${max}`;
  const totalStock = variants.reduce((sum, v) => sum + v.stock, 0);
  return `${priceLabel} · Stock: ${totalStock} (${variants.length} variant${variants.length === 1 ? "" : "s"})`;
}

/**
 * Listings management -- functionally identical to the pre-redesign inline
 * tab in SellerDashboardPage.tsx (same hooks, same actions, same gating),
 * restyled to admin's rounded-2xl card / Skeleton loading conventions.
 */
export function SellerListingsTab() {
  const qc = useQueryClient();
  const { data: listings, isLoading: listingsLoading } = useListMySellerListings();
  const updateListing = useUpdateSellerListing();
  const deleteListing = useDeleteSellerListing();

  const [showForm, setShowForm] = useState(false);
  const [editingListing, setEditingListing] = useState<SellerListing | undefined>(undefined);

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
        onSuccess: () => { toast.success(nextVisibility === "public" ? "Listing is now visible" : "Listing hidden"); invalidate(); },
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

  return (
    <div>
      <div className="flex items-center justify-end mb-4">
        {!showForm && (
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium bg-pink-500 hover:bg-pink-600 text-white transition-colors"
          >
            <Plus className="h-4 w-4" /> Add Listing
          </button>
        )}
      </div>

      {showForm ? (
        <SellerListingForm editing={editingListing} onDone={closeForm} onCancel={closeForm} />
      ) : listingsLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-white rounded-2xl border p-4 flex items-center gap-4">
              <Skeleton className="h-16 w-16 rounded-xl shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      ) : !listings || listings.length === 0 ? (
        <div className="bg-white rounded-2xl border p-12 text-center">
          <Sprout className="h-10 w-10 text-gray-200 mx-auto mb-3" />
          <p className="font-semibold text-gray-500 mb-1">No listings yet</p>
          <p className="text-sm text-gray-400">Add your first listing against an existing variety to start selling.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {listings.map((l) => {
            const approval = APPROVAL_BADGE[l.approvalStatus] ?? APPROVAL_BADGE.pending;
            const ApprovalIcon = approval.icon;
            return (
              <div key={l.id} className="bg-white rounded-2xl border p-4 flex items-center gap-4">
                {l.images[0] ? (
                  <img src={l.images[0]} alt="" className="h-16 w-16 rounded-xl object-cover shrink-0" />
                ) : (
                  <div className="h-16 w-16 rounded-xl bg-gray-100 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-sm text-gray-900">Product #{l.productId}</p>
                    <Badge className={`${approval.className} gap-1`}>
                      <ApprovalIcon className="h-3 w-3" /> {approval.label}
                    </Badge>
                    <Badge variant={l.visibility === "public" ? "secondary" : "outline"}>
                      {l.visibility === "public" ? "Visible" : "Hidden"}
                    </Badge>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {variantPriceStockSummary(l.variants)}
                  </p>
                  {l.approvalStatus === "rejected" && l.rejectionReason && (
                    <p className="text-xs text-red-600 mt-1">Rejected: {l.rejectionReason}</p>
                  )}
                  {l.hiddenReason === "subscription_expired" && (
                    <p className="text-xs text-amber-600 mt-1">Hidden automatically — subscription expired</p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => toggleVisibility(l)}
                    disabled={updateListing.isPending}
                    className="p-2 rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-700 transition-colors"
                    title={l.visibility === "public" ? "Hide listing" : "Show listing"}
                  >
                    {l.visibility === "public" ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                  <button onClick={() => openEdit(l)} className="p-2 rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-700 transition-colors" title="Edit">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(l)}
                    disabled={deleteListing.isPending}
                    className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
