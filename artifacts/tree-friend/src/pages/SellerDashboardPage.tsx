import { useState } from "react";
import { Link } from "wouter";
import {
  Plus, Sprout, Loader2, Eye, EyeOff, Pencil, Trash2, Clock, CheckCircle2, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { updateSEO } from "@/lib/seo";
import {
  useGetMySeller,
  useListMySellerListings,
  useUpdateSellerListing,
  useDeleteSellerListing,
  getListMySellerListingsQueryKey,
  type SellerListing,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SellerListingForm } from "@/components/seller/SellerListingForm";
import { SellerOrdersTab } from "@/components/seller/SellerOrdersTab";
import { CourierSettingsForm } from "@/components/seller/CourierSettingsForm";
import { PaymentSettingsForm } from "@/components/seller/PaymentSettingsForm";
import { BusinessProfileForm } from "@/components/seller/BusinessProfileForm";

updateSEO({ title: "Seller Dashboard", noIndex: true });

const APPROVAL_BADGE: Record<string, { icon: React.ElementType; className: string; label: string }> = {
  pending: { icon: Clock, className: "bg-amber-100 text-amber-700", label: "Pending Review" },
  approved: { icon: CheckCircle2, className: "bg-emerald-100 text-emerald-700", label: "Approved" },
  rejected: { icon: XCircle, className: "bg-red-100 text-red-700", label: "Rejected" },
};

/**
 * Seller dashboard -- plan doc §4's "Upload Listing" + "Manage Inventory"
 * (phase 2), plus Manage Orders + Courier Settings (plan doc §8, Part 4),
 * plus Payment Settings (plan doc §7, seller_payment_configs, Part 6),
 * plus Business Profile / Vacation Mode / Business Verification doc
 * upload (plan doc §4 items 1/2/3/5, Part 7 -- Store Settings folded into
 * Business Profile since no sellers-table field was left uncovered).
 * Manage Discounts (plan §4 item 4) is NOT a separate section here --
 * satisfied by the existing per-listing discountPrice field above.
 */
export function SellerDashboardPage() {
  const qc = useQueryClient();
  const { data: seller, isLoading: sellerLoading } = useGetMySeller();
  const { data: listings, isLoading: listingsLoading } = useListMySellerListings({
    query: { enabled: seller?.status === "active" },
  } as any);
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

  if (sellerLoading) {
    return (
      <div className="container mx-auto px-4 py-16 flex justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // No seller account, or a status where nothing here applies yet
  // (pending review / suspended) -- send them to the become-seller status
  // page rather than showing an empty dashboard. "vacation" is NOT
  // included here -- a vacationing seller still needs to reach Business
  // Profile to turn vacation off, so they fall through to the dashboard
  // below with only that tab enabled instead of being locked out entirely.
  if (!seller || (seller.status !== "active" && seller.status !== "vacation")) {
    return (
      <div className="container mx-auto px-4 py-16 max-w-lg text-center">
        <Sprout className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
        <h1 className="font-serif text-xl font-medium mb-2">Seller dashboard unavailable</h1>
        <p className="text-sm text-muted-foreground mb-4">
          {!seller
            ? "You don't have a seller account yet."
            : `Your seller account status is "${seller.status}" — the dashboard is only available for active sellers.`}
        </p>
        <Link href="/become-seller">
          <Button className="rounded-full">
            {!seller ? "Become a Seller" : "View Application Status"}
          </Button>
        </Link>
      </div>
    );
  }

  const onVacation = seller.status === "vacation";

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <PageBreadcrumb crumbs={[{ label: "Seller Dashboard", icon: <Sprout className="h-3 w-3" /> }]} className="mb-4" />

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-serif text-2xl font-medium flex items-center gap-2">
            <Sprout className="h-6 w-6 text-accent" /> {seller.businessName}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">{seller.nurseryName} · {seller.location}</p>
        </div>
      </div>

      {onVacation && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 mb-6 text-sm text-amber-800">
          You're on vacation mode — your listings are hidden from buyers and Listings/Orders/Payment/Courier are
          paused until you turn it off in Business Profile below.
        </div>
      )}

      <Tabs defaultValue={onVacation ? "profile" : "listings"}>
        <TabsList className="mb-6">
          <TabsTrigger value="listings" disabled={onVacation}>Listings</TabsTrigger>
          <TabsTrigger value="orders" disabled={onVacation}>Orders</TabsTrigger>
          <TabsTrigger value="payment" disabled={onVacation}>Payment Settings</TabsTrigger>
          <TabsTrigger value="courier" disabled={onVacation}>Courier Settings</TabsTrigger>
          <TabsTrigger value="profile">Business Profile</TabsTrigger>
        </TabsList>

        <TabsContent value="listings">
          <div className="flex items-center justify-end mb-4">
            {!showForm && (
              <Button onClick={openCreate} className="rounded-full gap-1.5">
                <Plus className="h-4 w-4" /> Add Listing
              </Button>
            )}
          </div>

          {showForm ? (
            <SellerListingForm editing={editingListing} onDone={closeForm} onCancel={closeForm} />
          ) : listingsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <div key={i} className="h-24 rounded-2xl bg-muted animate-pulse" />)}
            </div>
          ) : !listings || listings.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground bg-card rounded-2xl border">
              <Sprout className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="font-medium text-sm">No listings yet</p>
              <p className="text-xs mt-1">Add your first listing against an existing variety to start selling.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {listings.map((l) => {
                const approval = APPROVAL_BADGE[l.approvalStatus] ?? APPROVAL_BADGE.pending;
                const ApprovalIcon = approval.icon;
                return (
                  <div key={l.id} className="bg-card rounded-2xl border p-4 flex items-center gap-4">
                    {l.images[0] ? (
                      <img src={l.images[0]} alt="" className="h-16 w-16 rounded-xl object-cover shrink-0" />
                    ) : (
                      <div className="h-16 w-16 rounded-xl bg-muted shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-sm">Product #{l.productId}</p>
                        <Badge className={`${approval.className} gap-1`}>
                          <ApprovalIcon className="h-3 w-3" /> {approval.label}
                        </Badge>
                        <Badge variant={l.visibility === "public" ? "secondary" : "outline"}>
                          {l.visibility === "public" ? "Visible" : "Hidden"}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        Tk{l.discountPrice ?? l.price}{l.discountPrice && <span className="line-through ml-1">Tk{l.price}</span>}
                        {" · "}Stock: {l.stock}
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
                        className="p-2 rounded-lg text-muted-foreground hover:bg-muted transition-colors"
                        title={l.visibility === "public" ? "Hide listing" : "Show listing"}
                      >
                        {l.visibility === "public" ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                      <button onClick={() => openEdit(l)} className="p-2 rounded-lg text-muted-foreground hover:bg-muted transition-colors" title="Edit">
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(l)}
                        disabled={deleteListing.isPending}
                        className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-red-50 transition-colors"
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
        </TabsContent>

        <TabsContent value="orders">
          <SellerOrdersTab />
        </TabsContent>

        <TabsContent value="payment">
          <PaymentSettingsForm />
        </TabsContent>

        <TabsContent value="courier">
          <CourierSettingsForm />
        </TabsContent>

        <TabsContent value="profile">
          <BusinessProfileForm />
        </TabsContent>
      </Tabs>
    </div>
  );
}
