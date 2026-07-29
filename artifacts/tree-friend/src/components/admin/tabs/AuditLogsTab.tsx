import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@clerk/react";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollText, Search, ShieldCheck, UserCog, Package, Tag, ShoppingBag, Truck, XCircle, CheckCircle2 } from "lucide-react";
import { Input } from "@/components/ui/input";

const API = import.meta.env.VITE_API_BASE_URL ?? "";

// Action palette — covers every action type the backend actually emits
// (logAudit calls in admin.ts, adminSellers.ts, sellers.ts, etc.). Each
// entry has an icon + tailwind tint. Anything not listed falls back to
// the gray default in the render.
const ACTION_META: Record<string, { icon: typeof ShieldCheck; tint: string; label?: string }> = {
  // Order actions
  "order.status_changed":   { icon: Truck,        tint: "bg-blue-50 text-blue-700 border-blue-200" },
  "order.payment_updated":  { icon: ShoppingBag,  tint: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  // Product actions
  "product.created":        { icon: Package,      tint: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  "product.updated":        { icon: Package,      tint: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  "product.deleted":        { icon: XCircle,       tint: "bg-rose-50 text-rose-700 border-rose-200" },
  // User actions
  "user.blocked":           { icon: UserCog,       tint: "bg-orange-50 text-orange-700 border-orange-200" },
  "user.unblocked":         { icon: UserCog,       tint: "bg-amber-50 text-amber-700 border-amber-200" },
  // Seller actions
  "seller.approved":        { icon: CheckCircle2,  tint: "bg-emerald-50 text-emerald-700 border-emerald-200", label: "Seller approved" },
  "seller.rejected":        { icon: XCircle,       tint: "bg-rose-50 text-rose-700 border-rose-200", label: "Seller rejected" },
  "seller.suspended":       { icon: UserCog,       tint: "bg-rose-50 text-rose-700 border-rose-200", label: "Seller suspended" },
  "seller.subscription_paid": { icon: ShieldCheck, tint: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  // Category actions
  "category.created":       { icon: Tag,           tint: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  "category.updated":       { icon: Tag,           tint: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  "category.deleted":       { icon: XCircle,       tint: "bg-rose-50 text-rose-700 border-rose-200" },
};

// Pretty-print the audit log's before/after JSON. The old version ran
// `JSON.stringify(...).replace(/[{}"]/g, '')` which produced unreadable
// mush like `id:5,name:Keitt Mango`. This version parses the object and
// renders each key/value as a small chip so admins can actually see what
// changed.
function JsonDiff({ label, value, struck }: { label: string; value: unknown; struck?: boolean }) {
  if (value == null) return null;
  let entries: [string, unknown][] = [];
  if (typeof value === "object" && !Array.isArray(value) && value !== null) {
    entries = Object.entries(value as Record<string, unknown>);
  } else {
    entries = [[label, value]];
  }
  if (entries.length === 0) return null;
  return (
    <div className={`mt-1 flex flex-wrap gap-1.5 ${struck ? "opacity-60" : ""}`}>
      <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70 mt-0.5 mr-1">{label}:</span>
      {entries.map(([k, v]) => {
        const valStr = typeof v === "string" ? v : JSON.stringify(v);
        const valDisplay = valStr.length > 32 ? valStr.slice(0, 30) + "..." : valStr;
        return (
          <span
            key={k}
            className={`inline-flex items-center gap-1 text-[11px] rounded-md px-1.5 py-0.5 border ${struck ? "line-through text-muted-foreground bg-muted/30 border-border" : "text-foreground bg-muted/40 border-border"}`}
            title={`${k}: ${valStr}`}
          >
            <span className="font-medium text-muted-foreground">{k}</span>
            <span className={struck ? "" : "text-foreground"}>{valDisplay}</span>
          </span>
        );
      })}
    </div>
  );
}

export function AuditLogsTab() {
  const { getToken } = useAuth();
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    getToken()
      .then(token =>
        fetch(API + "/api/admin/audit-logs?limit=50", { headers: { Authorization: `Bearer ${token}` } })
      )
      .then(r => r.json())
      .then(d => setLogs(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Filter by search across action / adminEmail / targetType / targetId
  // -- matches the same shape of search the other tabs (Reviews, Blog)
  // already offer, so admins have a consistent way to find a specific
  // admin action.
  const filtered = useMemo(() => {
    if (!search.trim()) return logs;
    const q = search.trim().toLowerCase();
    return logs.filter(l =>
      String(l.action ?? "").toLowerCase().includes(q) ||
      String(l.adminEmail ?? "").toLowerCase().includes(q) ||
      String(l.adminId ?? "").toLowerCase().includes(q) ||
      String(l.targetType ?? "").toLowerCase().includes(q) ||
      String(l.targetId ?? "").toLowerCase().includes(q)
    );
  }, [logs, search]);

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header + search */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ScrollText className="h-5 w-5 text-muted-foreground" />
            Audit Logs
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">Last 50 admin actions. Searchable.</p>
        </div>
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by action, admin, or target..."
            className="pl-9 rounded-xl"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border p-12 text-center">
          <ScrollText className="h-12 w-12 text-gray-200 mx-auto mb-4" />
          <p className="font-semibold text-gray-500 mb-1">
            {search ? "No actions match your search." : "No audit logs yet"}
          </p>
          {!search && <p className="text-sm text-gray-400">Admin actions will appear here as they happen.</p>}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(log => {
            const meta = ACTION_META[log.action] ?? { icon: ShieldCheck, tint: "bg-muted text-muted-foreground border-border" };
            const Icon = meta.icon;
            const label = meta.label ?? log.action;
            return (
              <div key={log.id} className="bg-card border rounded-xl p-4 flex items-start gap-3 hover:bg-muted/20 transition-colors">
                {/* Action icon + colored tint */}
                <div className={`shrink-0 h-9 w-9 rounded-lg border flex items-center justify-center ${meta.tint}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  {/* Top row: action label + who + when */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${meta.tint}`}>
                      {label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      by <span className="font-medium text-foreground">{log.adminEmail ?? (log.adminId ? String(log.adminId).slice(0, 8) : "unknown")}</span>
                    </span>
                    {log.targetType && (
                      <span className="text-xs text-muted-foreground">
                        → <span className="font-mono">{log.targetType} #{log.targetId}</span>
                      </span>
                    )}
                    {/* en-GB is widely supported in browsers/Node; the old
                        "en-BD" locale was unsupported in many runtimes and
                        fell back to ISO format silently. */}
                    <span className="text-xs text-muted-foreground/70 ml-auto whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                    </span>
                  </div>
                  {/* Before / After diff — rendered as chips, not raw JSON
                      stringified-and-stripped. */}
                  {(log.before || log.after) && (
                    <div className="mt-2 space-y-1">
                      {log.before && <JsonDiff label="before" value={log.before} struck />}
                      {log.after  && <JsonDiff label="after"  value={log.after} />}
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

// ─── Q&A Tab ────────────────────────────────────────────────────────────
