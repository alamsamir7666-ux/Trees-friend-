import { useState, useEffect } from "react";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";

const API = import.meta.env.VITE_API_BASE_URL ?? "";

export function CashoutsSection() {
  const { getToken } = useAuth();
  const [cashouts, setCashouts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getToken().then(token =>
      fetch(API + "/api/admin/cashouts", { headers: { Authorization: `Bearer ${token}` } })
        .then(r => { console.log("[cashouts] status:", r.status); return r.json(); })
        .then(d => { console.log("[cashouts] data:", d); if (Array.isArray(d)) setCashouts(d); })
        .catch(e => console.log("[cashouts] error:", e))
        .finally(() => setLoading(false))
    );
  }, []);

  async function handleAction(id: number, status: "approved" | "rejected" | "paid", note?: string) {
    const token = await getToken();
    const r = await fetch(`${API}/api/admin/cashouts/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status, note }),
    });
    if (r.ok) {
      const updated = await r.json();
      setCashouts(prev => prev.map(c => c.id === id ? { ...c, ...updated } : c));
    }
  }

  if (loading) return <div className="h-20 rounded-xl bg-muted animate-pulse" />;

  const pending = cashouts.filter(c => c.status === "pending");
  const processed = cashouts.filter(c => c.status !== "pending");

  return (
    <div className="mt-8">
      <h3 className="font-semibold text-base mb-4">Cashout Requests</h3>
      {cashouts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No cashout requests yet.</p>
      ) : (
        <div className="space-y-3">
          {pending.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2 font-medium">Pending ({pending.length})</p>
              {pending.map(co => (
                <div key={co.id} className="border rounded-xl p-4 bg-yellow-50/50 space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-sm">{co.affiliateName} <span className="text-muted-foreground font-normal">({co.affiliateEmail})</span></p>
                      <p className="text-xs text-muted-foreground">Code: {co.affiliateCode} ? {new Date(co.createdAt).toLocaleDateString()}</p>
                    </div>
                    <p className="font-bold text-lg">Tk{Number(co.amount).toLocaleString()}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" className="flex-1 rounded-full bg-green-600 hover:bg-green-700" onClick={() => handleAction(co.id, "approved")}>Approve</Button>
                    <Button size="sm" variant="outline" className="flex-1 rounded-full text-destructive border-destructive/30 hover:bg-destructive/5" onClick={() => {
                      const note = prompt("Rejection reason (optional):");
                      handleAction(co.id, "rejected", note ?? undefined);
                    }}>Reject</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {processed.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2 font-medium">Processed</p>
              {processed.map(co => (
                <div key={co.id} className="border rounded-xl p-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{co.affiliateName}</p>
                    <p className="text-xs text-muted-foreground">{new Date(co.createdAt).toLocaleDateString()} {co.note && `? ${co.note}`}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold">Tk{Number(co.amount).toLocaleString()}</p>
                    <div className="flex flex-col items-end gap-1">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${co.status === "approved" ? "bg-green-100 text-green-700" : co.status === "paid" ? "bg-blue-100 text-blue-700" : "bg-red-100 text-red-600"}`}>{co.status}</span>
                {co.status === "approved" && (
                  <button onClick={() => handleAction(co.id, "paid")} className="text-xs px-2 py-0.5 rounded-full bg-blue-600 text-white hover:bg-blue-700">Mark Paid</button>
                )}
              </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
