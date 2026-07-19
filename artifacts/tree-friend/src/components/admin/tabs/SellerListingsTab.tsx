import { useState } from "react";
import { Loader2, Clock, CheckCircle2, XCircle, Sprout } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  useListAdminSellerListings,
  useApproveSellerListing,
  useRejectSellerListing,
  getListAdminSellerListingsQueryKey,
  ListAdminSellerListingsApprovalStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const STATUS_FILTERS = [
  { value: undefined, label: "All" },
  { value: ListAdminSellerListingsApprovalStatus.pending, label: "Pending" },
  { value: ListAdminSellerListingsApprovalStatus.approved, label: "Approved" },
  { value: ListAdminSellerListingsApprovalStatus.rejected, label: "Rejected" },
] as const;

const STATUS_BADGE: Record<string, { icon: React.ElementType; className: string }> = {
  pending: { icon: Clock, className: "bg-amber-100 text-amber-700" },
  approved: { icon: CheckCircle2, className: "bg-emerald-100 text-emerald-700" },
  rejected: { icon: XCircle, className: "bg-red-100 text-red-700" },
};

/**
 * Admin-side counterpart to the seller dashboard's listing creation --
 * approve/reject queue for seller_listings. Mirrors SellersTab.tsx's
 * status-filter + card-list pattern (that tab does the same thing one
 * level up, for seller applications rather than individual listings).
 */
export function SellerListingsTab() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<ListAdminSellerListingsApprovalStatus | undefined>(
    ListAdminSellerListingsApprovalStatus.pending,
  );
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="font-serif text-xl font-medium flex items-center gap-2">
          <Sprout className="h-5 w-5 text-accent" /> Seller Listings
        </h2>
        <div className="flex gap-2">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.label}
              onClick={() => setFilter(f.value)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                filter === f.value ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-20 rounded-2xl bg-muted animate-pulse" />)}
        </div>
      ) : !listings || listings.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground bg-card rounded-2xl border">
          <Sprout className="h-8 w-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No listings {filter ? `with status "${filter}"` : ""}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {listings.map((l) => {
            const badge = STATUS_BADGE[l.approvalStatus] ?? STATUS_BADGE.pending;
            const Icon = badge.icon;
            return (
              <div key={l.id} className="bg-card rounded-2xl border p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-sm">{l.productName}</p>
                      <Badge className={`${badge.className} gap-1`}>
                        <Icon className="h-3 w-3" /> {l.approvalStatus}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Seller: {l.sellerBusinessName} · Tk{l.discountPrice ?? l.price} · Stock: {l.stock}
                    </p>
                    {l.rejectionReason && (
                      <p className="text-xs text-red-600 mt-1">Previously rejected: {l.rejectionReason}</p>
                    )}
                  </div>
                  {l.approvalStatus === "pending" && (
                    <div className="flex gap-2 shrink-0">
                      <Button size="sm" className="rounded-full" onClick={() => handleApprove(l.id)} disabled={approve.isPending}>
                        {approve.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Approve"}
                      </Button>
                      <Button size="sm" variant="outline" className="rounded-full" onClick={() => setRejectingId(rejectingId === l.id ? null : l.id)}>
                        Reject
                      </Button>
                    </div>
                  )}
                </div>
                {rejectingId === l.id && (
                  <div className="mt-3 flex gap-2 items-start">
                    <Textarea
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="Reason for rejection (optional, shown to seller)"
                      rows={2}
                      className="flex-1"
                    />
                    <Button size="sm" variant="destructive" className="rounded-full shrink-0" onClick={() => handleReject(l.id)} disabled={reject.isPending}>
                      {reject.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Confirm Reject"}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
