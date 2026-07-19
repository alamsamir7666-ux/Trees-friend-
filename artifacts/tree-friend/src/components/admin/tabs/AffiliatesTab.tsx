import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@clerk/react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, Search, Save, Pencil, Trash2 } from "lucide-react";
import { CashoutsSection } from "./CashoutsSection";

const API = import.meta.env.VITE_API_BASE_URL ?? "";

export function AffiliatesTab() {
  const { getToken } = useAuth();
  const [affiliates, setAffiliates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", code: "", commissionRate: "10" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: "", email: "", commissionRate: "" });
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  useEffect(() => {
    getToken().then(token => fetch(API+"/api/admin/affiliates", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { if (Array.isArray(d)) setAffiliates(d); }).catch(() => {}).finally(() => setLoading(false)));
  }, []);

  async function handleCreate() {
    setSaving(true); setError("");
    try {
      const r = await fetch(API+"/api/admin/affiliates", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
        body: JSON.stringify(form),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error ?? "Failed"); return; }
      setAffiliates(prev => [data, ...prev]);
      setShowForm(false); setForm({ name: "", email: "", code: "", commissionRate: "10" });
    } finally { setSaving(false); }
  }

  async function handleEdit(a: any) {
    setEditingId(a.id);
    setEditForm({ name: a.name, email: a.email, commissionRate: String(a.commissionRate) });
  }

  async function handleSaveEdit(id: number) {
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/admin/affiliates/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
        body: JSON.stringify(editForm),
      });
      if (r.ok) {
        const updated = await r.json();
        setAffiliates(prev => prev.map(a => a.id === id ? updated : a));
        setEditingId(null);
      }
    } finally { setSaving(false); }
  }

  async function handleDelete(id: number) {
    const r = await fetch(`${API}/api/admin/affiliates/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${await getToken()}` } });
    if (r.ok) {
      setAffiliates(prev => prev.filter(a => a.id !== id));
      setDeleteConfirm(null);
    }
  }

  async function toggleAffiliate(id: number) {
    const r = await fetch(`${API}/api/admin/affiliates/${id}/toggle`, { method: "PATCH", headers: { Authorization: `Bearer ${await getToken()}` } });
    if (r.ok) {
      const updated = await r.json();
      setAffiliates(prev => prev.map(a => a.id === id ? updated : a));
    }
  }

  const filtered = useMemo(() =>
    affiliates.filter(a =>
      !searchQ ||
      a.name.toLowerCase().includes(searchQ.toLowerCase()) ||
      a.email.toLowerCase().includes(searchQ.toLowerCase()) ||
      a.code.toLowerCase().includes(searchQ.toLowerCase())
    ), [affiliates, searchQ]);

  if (loading) return <div className="h-40 bg-muted animate-pulse rounded-xl" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold">Affiliates & Influencers</h2>
        <button onClick={() => setShowForm(v => !v)}
          className="flex items-center gap-1.5 text-sm bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90 transition-colors">
          <Plus className="h-4 w-4" />Add Affiliate
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name, email, or code?"
          className="pl-10"
          value={searchQ}
          onChange={e => setSearchQ(e.target.value)}
        />
      </div>

      {showForm && (
        <div className="bg-card border rounded-xl p-5 space-y-3">
          <h3 className="font-medium text-sm">New Affiliate</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input placeholder="Name" value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))} />
            <Input placeholder="Email" type="email" value={form.email} onChange={e => setForm(f => ({...f, email: e.target.value}))} />
            <Input placeholder="Affiliate Code (e.g. JOHN2024)" value={form.code ?? ""} onChange={e => setForm(f => ({...f, code: e.target.value.toUpperCase()}))} />
            <Input placeholder="Commission %" type="number" min="1" max="50" value={form.commissionRate} onChange={e => setForm(f => ({...f, commissionRate: e.target.value}))} />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={saving}
              className="text-sm bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90 transition-colors">
              {saving ? "Creating?" : "Create Affiliate"}
            </button>
            <button onClick={() => setShowForm(false)} className="text-sm text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          {searchQ ? "No affiliates match your search." : "No affiliates yet. Add influencers to track their sales."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground border-b">
              <th className="pb-2 pr-4">Name</th><th className="pb-2 pr-4">Code</th>
              <th className="pb-2 pr-4">Commission</th><th className="pb-2 pr-4">Orders</th>
              <th className="pb-2 pr-4">Revenue</th><th className="pb-2 pr-4">Earned</th>
              <th className="pb-2 pr-4">Status</th><th className="pb-2">Actions</th>
            </tr></thead>
            <tbody className="divide-y">
              {filtered.map(a => (
                <tr key={a.id}>
                  {editingId === a.id ? (
                    <>
                      <td className="py-3 pr-4" colSpan={3}>
                        <div className="flex gap-2 flex-wrap">
                          <Input className="h-8 text-xs w-32" value={editForm.name} onChange={e => setEditForm(f => ({...f, name: e.target.value}))} placeholder="Name" />
                          <Input className="h-8 text-xs w-40" value={editForm.email} onChange={e => setEditForm(f => ({...f, email: e.target.value}))} placeholder="Email" />
                          <Input className="h-8 text-xs w-20" type="number" min="1" max="50" value={editForm.commissionRate} onChange={e => setEditForm(f => ({...f, commissionRate: e.target.value}))} placeholder="Rate %" />
                        </div>
                      </td>
                      <td className="py-3 pr-4">{a.totalOrders}</td>
                      <td className="py-3 pr-4 font-semibold">Tk{Number(a.totalSales).toLocaleString()}</td>
                      <td className="py-3 pr-4 text-green-600 font-semibold">Tk{Number(a.totalCommission ?? 0).toLocaleString()}</td>
                      <td className="py-3 pr-4">-</td>
                      <td className="py-3">
                        <div className="flex gap-1">
                          <button onClick={() => handleSaveEdit(a.id)} disabled={saving}
                            className="text-xs px-2 py-1 rounded bg-green-100 text-green-700 hover:bg-green-200 flex items-center gap-1">
                            <Save className="h-3 w-3" />{saving ? "..." : "Save"}
                          </button>
                          <button onClick={() => setEditingId(null)}
                            className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-muted/80">
                            Cancel
                          </button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="py-3 pr-4">
                        <p className="font-medium">{a.name}</p>
                        <p className="text-xs text-muted-foreground">{a.email}</p>
                      </td>
                      <td className="py-3 pr-4">
                        <span className="font-mono text-xs bg-muted/50 px-2 py-0.5 rounded">{a.code}</span>
                      </td>
                      <td className="py-3 pr-4">{a.commissionRate}%</td>
                      <td className="py-3 pr-4">{a.totalOrders}</td>
                      <td className="py-3 pr-4 font-semibold">Tk{Number(a.totalSales).toLocaleString()}</td>
                      <td className="py-3 pr-4 text-green-600 font-semibold">Tk{Number(a.totalCommission ?? 0).toLocaleString()}</td>
                      <td className="py-3 pr-4">
                        <button onClick={() => toggleAffiliate(a.id)}
                          className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${a.isActive ? "bg-green-100 text-green-700 hover:bg-green-200" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}>
                          {a.isActive ? "Active" : "Inactive"}
                        </button>
                      </td>
                      <td className="py-3">
                        <div className="flex gap-1">
                          <button onClick={() => handleEdit(a)} title="Edit"
                            className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          {deleteConfirm === a.id ? (
                            <div className="flex gap-1 items-center">
                              <button onClick={() => handleDelete(a.id)}
                                className="text-xs px-2 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200">Delete</button>
                              <button onClick={() => setDeleteConfirm(null)}
                                className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-muted/80">No</button>
                            </div>
                          ) : (
                            <button onClick={() => setDeleteConfirm(a.id)} title="Delete"
                              className="p-1.5 rounded hover:bg-red-50 transition-colors text-muted-foreground hover:text-red-600">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    <CashoutsSection />
    </div>
  );
}

// ??? Cashouts Tab (inside Affiliates) ????????????????????????????????????????
