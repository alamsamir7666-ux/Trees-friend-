import { useCallback, useEffect, useMemo, useState } from "react";
import { useApiFetch } from "@/lib/useApiFetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Search, Plus, Tag, Pencil, Trash2, ToggleLeft, ToggleRight, X,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────
interface SellerCoupon {
  id: number;
  code: string;
  discountType: "percentage" | "fixed";
  discountValue: number;
  minOrderAmount: number | null;
  expiryDate: string | null;
  isActive: boolean;
  sellerId: number | null;
  createdAt: string;
}

interface CouponForm {
  code: string;
  discountType: "percentage" | "fixed";
  discountValue: string;
  minOrderAmount: string;
  expiryDate: string;
}

const EMPTY_FORM: CouponForm = {
  code: "",
  discountType: "percentage",
  discountValue: "",
  minOrderAmount: "",
  expiryDate: "",
};

// ── Error helpers ──────────────────────────────────────────────────────────
// 404 from /api/sellers/me/coupons* almost always means the deployed backend
// is stale (frontend was redeployed on Vercel but the api-server on Render
// hasn't picked up the new seller-scoped coupon routes yet). Surface a clear
// message instead of a generic "Not found".
const DEPLOY_HINT =
  "Coupons API not available on the server. If you just deployed the frontend, " +
  "make sure the backend (api-server) is also redeployed -- the seller coupon " +
  "routes were added in a recent commit.";

async function readApiError(res: Response, fallback: string): Promise<string> {
  if (res.status === 404) return DEPLOY_HINT;
  const body = await res.json().catch(() => ({}));
  return body?.error ?? fallback;
}

// ── Component ────────────────────────────────────────────────────────────
/**
 * Seller-scoped Coupons tab.
 *
 * Renders a list of coupons owned by the current seller (coupons where
 * seller_id === req.dbSeller.id), with create / edit / toggle / delete
 * actions hitting the seller-scoped routes:
 *   GET    /api/sellers/me/coupons
 *   POST   /api/sellers/me/coupons
 *   PUT    /api/sellers/me/coupons/:id
 *   PATCH  /api/sellers/me/coupons/:id/toggle
 *   DELETE /api/sellers/me/coupons/:id
 *
 * Adapted from the old admin CouponsTab + inline CouponModal (now removed
 * from the admin panel). Sellers can only see and manage their own
 * coupons; platform-wide coupons (created by the referral system etc.)
 * are not visible here.
 */
export function SellerCouponsTab() {
  const apiFetch = useApiFetch();

  const [coupons, setCoupons] = useState<SellerCoupon[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<SellerCoupon | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<SellerCoupon | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch ────────────────────────────────────────────────────────────
  const fetchCoupons = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/sellers/me/coupons");
      if (!res.ok) {
        throw new Error(await readApiError(res, "Failed to fetch coupons"));
      }
      const data = await res.json();
      setCoupons(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load coupons");
      setCoupons([]);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    fetchCoupons();
  }, [fetchCoupons]);

  // ── Filter ───────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!search.trim()) return coupons;
    const q = search.toLowerCase();
    return coupons.filter((c) => c.code.toLowerCase().includes(q));
  }, [coupons, search]);

  // ── Save (create or update) ──────────────────────────────────────────
  async function handleSave(form: CouponForm) {
    setSaving(true);
    setError(null);
    try {
      const url = editing
        ? `/api/sellers/me/coupons/${editing.id}`
        : "/api/sellers/me/coupons";
      const method = editing ? "PUT" : "POST";
      const body = {
        code: form.code,
        discountType: form.discountType,
        discountValue: parseFloat(form.discountValue),
        minOrderAmount: form.minOrderAmount ? parseFloat(form.minOrderAmount) : null,
        expiryDate: form.expiryDate || null,
      };
      const res = await apiFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(await readApiError(res, `Failed to ${editing ? "update" : "create"} coupon`));
      }
      setShowModal(false);
      setEditing(null);
      fetchCoupons();
    } catch (e: any) {
      setError(e?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // ── Toggle active ────────────────────────────────────────────────────
  async function handleToggle(id: number) {
    try {
      const res = await apiFetch(`/api/sellers/me/coupons/${id}/toggle`, {
        method: "PATCH",
      });
      if (!res.ok) throw new Error(await readApiError(res, "Failed to toggle coupon"));
      fetchCoupons();
    } catch (e: any) {
      setError(e?.message ?? "Toggle failed");
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────
  async function handleDelete(id: number) {
    try {
      const res = await apiFetch(`/api/sellers/me/coupons/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await readApiError(res, "Failed to delete coupon"));
      setConfirmDelete(null);
      fetchCoupons();
    } catch (e: any) {
      setError(e?.message ?? "Delete failed");
    }
  }

  function openCreate() {
    setEditing(null);
    setShowModal(true);
  }

  function openEdit(c: SellerCoupon) {
    setEditing(c);
    setShowModal(true);
  }

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-serif text-2xl font-medium">Coupons</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Create discount codes your customers can apply at checkout. These coupons apply only to your listings.
          </p>
        </div>
        <Button
          onClick={openCreate}
          className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
        >
          <Plus className="h-4 w-4 mr-1.5" /> New Coupon
        </Button>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <p className="font-medium mb-0.5">Couldn't load coupons</p>
          <p className="text-destructive/90">{error}</p>
        </div>
      )}

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search coupons by code..."
          className="pl-10"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Body */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-card rounded-2xl border p-12 text-center">
          <Tag className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <p className="font-semibold text-muted-foreground mb-1">
            {search ? "No coupons match your search" : "No coupons yet"}
          </p>
          <p className="text-sm text-muted-foreground/70 mb-4">
            {search
              ? "Try a different code or clear the search."
              : "Create your first discount coupon to boost sales."}
          </p>
          {!search && (
            <Button
              onClick={openCreate}
              className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              <Plus className="h-4 w-4 mr-1.5" /> Create Coupon
            </Button>
          )}
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
                {filtered.map((c) => {
                  const isExpired = c.expiryDate && new Date(c.expiryDate) < new Date();
                  return (
                    <tr key={c.id} className={`hover:bg-primary/5 transition-colors ${!c.isActive ? "opacity-60" : ""}`}>
                      <td className="px-5 py-3.5">
                        <span className="font-mono font-bold text-foreground bg-muted px-2.5 py-1 rounded-lg text-sm">
                          {c.code}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="font-semibold text-primary">
                          {c.discountType === "percentage"
                            ? `${c.discountValue}%`
                            : `Tk${c.discountValue}`}
                        </span>
                        <span className="text-xs text-muted-foreground/70 ml-1 capitalize">
                          {c.discountType}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground text-xs">
                        {c.minOrderAmount ? `Tk${c.minOrderAmount}` : "-"}
                      </td>
                      <td className="px-5 py-3.5">
                        {c.expiryDate ? (
                          <span className={`text-xs ${isExpired ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                            {isExpired ? "Expired · " : ""}
                            {new Date(c.expiryDate).toLocaleDateString("en-GB", {
                              day: "2-digit", month: "short", year: "numeric",
                            })}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground/70">No expiry</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-center">
                        <button
                          onClick={() => handleToggle(c.id)}
                          title={c.isActive ? "Deactivate" : "Activate"}
                          className="inline-flex items-center gap-1.5 text-xs font-medium"
                        >
                          {c.isActive ? (
                            <><ToggleRight className="h-5 w-5 text-emerald-600" /><span className="text-emerald-600">Active</span></>
                          ) : (
                            <><ToggleLeft className="h-5 w-5 text-muted-foreground/70" /><span className="text-muted-foreground/70">Inactive</span></>
                          )}
                        </button>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => openEdit(c)}
                            className="p-1.5 rounded-lg text-muted-foreground/70 hover:text-info-foreground hover:bg-info/10 transition-colors"
                            title="Edit"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => setConfirmDelete(c)}
                            className="p-1.5 rounded-lg text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 transition-colors"
                            title="Delete"
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

      {/* Coupon modal */}
      {showModal && (
        <CouponModal
          coupon={editing}
          saving={saving}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSave={handleSave}
        />
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <DeleteConfirm
          coupon={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => handleDelete(confirmDelete.id)}
        />
      )}
    </div>
  );
}

// ── Coupon modal (create/edit) ───────────────────────────────────────────
function CouponModal({
  coupon,
  saving,
  onClose,
  onSave,
}: {
  coupon: SellerCoupon | null;
  saving: boolean;
  onClose: () => void;
  onSave: (form: CouponForm) => void;
}) {
  const [form, setForm] = useState<CouponForm>({
    code: coupon?.code ?? "",
    discountType: coupon?.discountType ?? "percentage",
    discountValue: coupon?.discountValue != null ? String(coupon.discountValue) : "",
    minOrderAmount: coupon?.minOrderAmount != null ? String(coupon.minOrderAmount) : "",
    expiryDate: coupon?.expiryDate ? coupon.expiryDate.slice(0, 10) : "",
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave(form);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="font-semibold text-lg">{coupon ? "Edit Coupon" : "New Coupon"}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
            <X className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Coupon Code *
            </Label>
            <Input
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
              required
              className="mt-1.5 rounded-xl font-mono"
              placeholder="SAVE20"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Discount Type *
              </Label>
              <Select
                value={form.discountType}
                onValueChange={(v) => setForm((f) => ({ ...f, discountType: v as "percentage" | "fixed" }))}
              >
                <SelectTrigger className="mt-1.5 rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">Percentage (%)</SelectItem>
                  <SelectItem value="fixed">Fixed Amount (Tk)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Value {form.discountType === "percentage" ? "(%)" : "(Tk)"} *
              </Label>
              <Input
                type="number"
                value={form.discountValue}
                onChange={(e) => setForm((f) => ({ ...f, discountValue: e.target.value }))}
                required
                className="mt-1.5 rounded-xl"
                placeholder={form.discountType === "percentage" ? "20" : "500"}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Min Order (Tk)
              </Label>
              <Input
                type="number"
                value={form.minOrderAmount}
                onChange={(e) => setForm((f) => ({ ...f, minOrderAmount: e.target.value }))}
                className="mt-1.5 rounded-xl"
                placeholder="Optional"
              />
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Expiry Date
              </Label>
              <Input
                type="date"
                value={form.expiryDate}
                onChange={(e) => setForm((f) => ({ ...f, expiryDate: e.target.value }))}
                className="mt-1.5 rounded-xl"
              />
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <Button
              type="submit"
              disabled={saving}
              className="flex-1 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving ? "Saving..." : coupon ? "Update Coupon" : "Create Coupon"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose} className="rounded-xl">
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Delete confirmation dialog ───────────────────────────────────────────
function DeleteConfirm({
  coupon,
  onCancel,
  onConfirm,
}: {
  coupon: SellerCoupon;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-card rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="h-10 w-10 rounded-full bg-destructive/10 flex items-center justify-center">
            <Trash2 className="h-5 w-5 text-destructive" />
          </div>
          <h3 className="font-semibold text-lg">Delete coupon?</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-5">
          Coupon <Badge variant="secondary" className="font-mono">{coupon.code}</Badge> will be permanently deleted.
          Customers will no longer be able to apply this code at checkout.
        </p>
        <div className="flex gap-3">
          <Button
            onClick={onConfirm}
            className="flex-1 rounded-xl bg-destructive hover:bg-destructive/90 text-destructive-foreground"
          >
            Delete
          </Button>
          <Button variant="outline" onClick={onCancel} className="rounded-xl">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
