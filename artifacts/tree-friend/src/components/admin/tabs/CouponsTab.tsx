import { useAdminContext } from "@/contexts/AdminContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Plus, Tag, Pencil, Trash2, ToggleLeft, ToggleRight } from "lucide-react";

export function CouponsTab() {
const {
    coupons,
    couponsLoading,
    couponSearch,
    setCouponSearch,
    editingCoupon,
    setEditingCoupon,
    showCouponModal,
    setShowCouponModal,
    couponSaving,
    setCouponSaving,
    setCoupons,
    askConfirm,
    getToken,
    filteredCoupons,
    handleDeleteCoupon,
    handleToggleCoupon,
  } = useAdminContext();

return (
  <div>
    <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
      <div>
        <p className="text-sm text-muted-foreground">Create and manage discount coupons for your customers.</p>
        {/* Marketplace-awareness note: coupons are platform-wide (no
            sellerId on couponsTable), so they apply to every seller's
            listings at checkout. Per-seller coupons would need a schema
            migration -- flagged here so admins don't ask "which seller
            does this coupon apply to?" and find no answer. */}
        <p className="text-xs text-muted-foreground/70 mt-0.5">Coupons apply platform-wide across all sellers.</p>
      </div>
      <Button onClick={() => { setEditingCoupon(null); setShowCouponModal(true); }} className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shrink-0">
        <Plus className="h-4 w-4 mr-1.5" /> New Coupon
      </Button>
    </div>


    {/* Coupon search */}
    <div className="relative mb-4 max-w-sm">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        placeholder="Search coupons by code..."
        className="pl-10"
        value={couponSearch}
        onChange={e => setCouponSearch(e.target.value)}
      />
    </div>
    {couponsLoading ? (
      <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
    ) : filteredCoupons.length === 0 ? (
      <div className="bg-card rounded-2xl border p-12 text-center">
        <Tag className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
        <p className="font-semibold text-muted-foreground mb-1">No coupons yet</p>
        <p className="text-sm text-muted-foreground/70 mb-4">Create your first discount coupon to boost sales.</p>
        <Button onClick={() => { setEditingCoupon(null); setShowCouponModal(true); }} className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground">
          <Plus className="h-4 w-4 mr-1.5" /> Create Coupon
        </Button>
      </div>
    ) : (
      <div className="bg-card rounded-2xl border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Code</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Discount</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Min Order</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Expiry</th>
                <th className="px-5 py-3.5 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="px-5 py-3.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-muted/50">
              {filteredCoupons.map((c) => {
                const isExpired = c.expiryDate && new Date(c.expiryDate) < new Date();
                return (
                  <tr key={c.id} className={`hover:bg-primary/5 transition-colors ${!c.isActive ? "opacity-60" : ""}`}>
                    <td className="px-5 py-3.5">
                      <span className="font-mono font-bold text-foreground bg-muted px-2.5 py-1 rounded-lg text-sm">{c.code}</span>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="font-semibold text-primary">
                        {c.discountType === "percentage" ? `${c.discountValue}%` : `Tk${c.discountValue}`}
                      </span>
                      <span className="text-xs text-muted-foreground/70 ml-1 capitalize">{c.discountType}</span>
                    </td>
                    <td className="px-5 py-3.5 text-muted-foreground text-xs">
                      {c.minOrderAmount ? `Tk${c.minOrderAmount}` : "-"}
                    </td>
                    <td className="px-5 py-3.5">
                      {c.expiryDate ? (
                        <span className={`text-xs ${isExpired ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                          {isExpired ? "Expired · " : ""}{new Date(c.expiryDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground/70">No expiry</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      <button
                        onClick={() => handleToggleCoupon(c.id)}
                        title={c.isActive ? "Deactivate" : "Activate"}
                        className="inline-flex items-center gap-1.5 text-xs font-medium"
                      >
                        {c.isActive
                          ? <><ToggleRight className="h-5 w-5 text-success-foreground" /><span className="text-success-foreground">Active</span></>
                          : <><ToggleLeft className="h-5 w-5 text-muted-foreground/70" /><span className="text-muted-foreground/70">Inactive</span></>
                        }
                      </button>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => { setEditingCoupon(c); setShowCouponModal(true); }}
                          className="p-1.5 rounded-lg text-muted-foreground/70 hover:text-info-foreground hover:bg-info/10 transition-colors"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteCoupon(c.id)}
                          className="p-1.5 rounded-lg text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
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
    )}
  </div>
);
}
