import { useState, useEffect } from "react";
import { useAuth } from "@clerk/react";
import { Store, Mail, Phone } from "lucide-react";

const API = import.meta.env.VITE_API_BASE_URL ?? "";

// Mirrors the SELLER_STATUS_STYLE / SELLER_STATUS_LABEL maps in OrdersTab
// and ArchivedOrdersTab. Kept local for the same reason -- if a fourth
// consumer appears, lift to a shared file.
const SELLER_STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  pending_verification: "bg-amber-50 text-amber-700 border-amber-200",
  suspended: "bg-rose-50 text-rose-700 border-rose-200",
  vacation: "bg-sky-50 text-sky-700 border-sky-200",
};
const SELLER_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  pending_verification: "Pending",
  suspended: "Suspended",
  vacation: "On vacation",
};

export function ReturnsTab() {
  const { getToken } = useAuth();
  const [returns, setReturns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [refundInputs, setRefundInputs] = useState<Record<number, string>>({});

  useEffect(() => {
    getToken().then(token =>
      fetch(API + "/api/admin/returns", { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => { if (Array.isArray(d)) setReturns(d); })
        .catch(() => {})
        .finally(() => setLoading(false))
    );
  }, []);

  async function updateStatus(id: number, status: string, adminNote?: string, refundAmount?: string) {
    setUpdatingId(id);
    try {
      const r = await fetch(`${API}/api/admin/returns/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
        body: JSON.stringify({ status, adminNote, refundAmount }),
      });
      if (r.ok) {
        const updated = await r.json();
        setReturns(prev => prev.map(ret => ret.id === id ? { ...ret, ...updated } : ret));
      }
    } finally { setUpdatingId(null); }
  }

  const statusColors: Record<string, string> = {
    requested: "bg-amber-100 text-amber-700 border border-amber-200",
    approved:  "bg-blue-100 text-blue-700 border border-blue-200",
    rejected:  "bg-red-100 text-red-700 border border-red-200",
    completed: "bg-emerald-100 text-emerald-700 border border-emerald-200",
  };

  if (loading) return (
    <div className="space-y-4">
      {[1,2].map(i => <div key={i} className="h-36 bg-muted animate-pulse rounded-xl" />)}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Return Requests</h2>
        <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-full">{returns.length} total</span>
      </div>
      {returns.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="text-4xl mb-3">📋</div>
          <p className="text-sm text-muted-foreground">No return requests yet.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {returns.map(ret => {
            const items: any[] = ret.orderItems ?? [];
            const deliveredAt = ret.orderDeliveredAt ? new Date(ret.orderDeliveredAt) : null;
            const requestedAt = new Date(ret.createdAt);
            const sellerName = ret.sellerBusinessName ?? null;
            const sellerOwnerName = ret.sellerOwnerName ?? null;
            const sellerEmail = ret.sellerContactEmail ?? null;
            const sellerPhone = ret.sellerContactPhone ?? null;
            const sellerStatus = ret.sellerStatus ?? null;
            return (
              <div key={ret.id} className="bg-card border rounded-2xl overflow-hidden shadow-sm">
                {/* Header: return # + order # + customer + status badge */}
                <div className="flex items-center justify-between px-4 py-3 bg-muted/40 border-b">
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
                  {/* Seller context — the return is for items this seller
                      listed, so admin needs to know who to coordinate with
                      (approve the return, arrange pickup, issue refund from
                      the seller's account). Renders business name + status
                      pill + email + phone, or "Unknown seller" for legacy
                      pre-Phase-2 orders with no sellerId. */}
                  {sellerName ? (
                    <div className="bg-pink-50/50 border border-pink-100 rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="h-8 w-8 rounded-lg bg-pink-100 flex items-center justify-center shrink-0">
                          <Store className="h-4 w-4 text-pink-700" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-[10px] uppercase tracking-wider text-pink-700/70 font-semibold">Fulfilled by</p>
                          <p className="text-sm font-semibold text-gray-800 truncate">{sellerName}{sellerOwnerName ? <span className="text-gray-500 font-normal"> · {sellerOwnerName}</span> : null}</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 ml-auto">
                        {sellerStatus && (
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${SELLER_STATUS_STYLE[sellerStatus] ?? "bg-gray-50 text-gray-600 border-gray-200"}`}>
                            {SELLER_STATUS_LABEL[sellerStatus] ?? sellerStatus}
                          </span>
                        )}
                        {sellerEmail && (
                          <a
                            href={`mailto:${sellerEmail}?subject=${encodeURIComponent(`Return #${ret.id} (Order #${ret.orderId}) — Tree Friend admin follow-up`)}&body=${encodeURIComponent(`Hi ${sellerOwnerName ?? sellerName},\n\nThis is the Tree Friend admin team. We're reaching out about return request #${ret.id} for order #${ret.orderId}.\n\nPlease advise on how to proceed (pickup arrangement, refund authorization, etc).\n\nThanks,\nTree Friend Admin`)}`}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-gray-700 bg-white hover:bg-pink-50 hover:text-pink-700 border border-gray-200 transition-colors"
                          >
                            <Mail className="h-3 w-3" /> Contact
                          </a>
                        )}
                        {sellerPhone && (
                          <a
                            href={`tel:${sellerPhone}`}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-gray-700 bg-white hover:bg-pink-50 hover:text-pink-700 border border-gray-200 transition-colors"
                          >
                            <Phone className="h-3 w-3" /> Call
                          </a>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="bg-gray-50 border border-gray-100 rounded-xl px-4 py-2.5 text-xs text-gray-400 italic">
                      Unknown seller — legacy order from before the marketplace migration, or seller record deleted.
                    </div>
                  )}
                  {items.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Items in order</p>
                      <div className="space-y-2">
                        {items.map((item: any, idx: number) => (
                          <div key={idx} className="flex items-center gap-3 bg-muted/30 rounded-xl p-2.5">
                            {item.productImage && (
                              <img src={item.productImage} alt={item.productName}
                                className="w-12 h-12 rounded-lg object-cover shrink-0 border" />
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
                  <div className="flex flex-wrap gap-2 text-xs">
                    {ret.orderTotal != null && (
                      <div className="flex items-center gap-1.5 bg-muted/40 rounded-lg px-3 py-1.5">
                        <span className="text-muted-foreground">Order total</span>
                        <span className="font-semibold">Tk{Number(ret.orderTotal).toLocaleString()}</span>
                      </div>
                    )}
                    {deliveredAt && (
                      <div className="flex items-center gap-1.5 bg-green-50 text-green-700 rounded-lg px-3 py-1.5">
                        <span>✅ Delivered</span>
                        <span className="font-medium">{deliveredAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 bg-muted/40 rounded-lg px-3 py-1.5">
                      <span className="text-muted-foreground">Requested</span>
                      <span>{requestedAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
                    </div>
                  </div>
                  <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3">
                    <p className="text-xs font-medium text-amber-700 mb-1">Customer reason</p>
                    <p className="text-sm text-foreground">{ret.reason}</p>
                  </div>
                  {ret.adminNote && (
                    <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
                      <p className="text-xs font-medium text-blue-700 mb-1">Admin note</p>
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
                      <button onClick={() => updateStatus(ret.id, "approved")} disabled={updatingId === ret.id}
                        className="flex-1 text-sm font-medium bg-blue-500 text-white px-4 py-2 rounded-xl hover:bg-blue-600 transition-colors disabled:opacity-50">
                        Approve Return
                      </button>
                      <button onClick={() => { const note = prompt("Rejection reason?"); if (note) updateStatus(ret.id, "rejected", note); }} disabled={updatingId === ret.id}
                        className="flex-1 text-sm font-medium bg-red-500 text-white px-4 py-2 rounded-xl hover:bg-red-600 transition-colors disabled:opacity-50">
                        Reject
                      </button>
                    </div>
                  )}
                  {ret.status === "approved" && (
                    <div className="space-y-2 pt-1">
                      <p className="text-xs text-muted-foreground">Enter refund amount to mark as completed</p>
                      <div className="flex gap-2">
                        <input type="number" placeholder="Refund amount (Tk)" min="0"
                          value={refundInputs[ret.id] ?? ""}
                          onChange={(e) => setRefundInputs(prev => ({ ...prev, [ret.id]: e.target.value }))}
                          className="flex-1 text-sm border rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-400" />
                        <button onClick={() => { const amt = refundInputs[ret.id]; if (amt) updateStatus(ret.id, "completed", undefined, amt); }}
                          disabled={updatingId === ret.id || !refundInputs[ret.id]}
                          className="text-sm font-medium bg-emerald-500 text-white px-4 py-2 rounded-xl hover:bg-emerald-600 transition-colors disabled:opacity-50">
                          Complete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
