import { useState, useEffect } from "react";
import { useAuth } from "@clerk/react";

const API = import.meta.env.VITE_API_BASE_URL ?? "";

export function AuditLogsTab() {
  const { getToken } = useAuth();
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getToken().then(token => fetch(API+"/api/admin/audit-logs?limit=50", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setLogs(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false)));
  }, []);

  if (loading) return <div className="h-40 bg-muted animate-pulse rounded-xl" />;

  const actionColors: Record<string, string> = {
    "order.status_changed": "bg-blue-100 text-blue-700",
    "product.deleted": "bg-red-100 text-red-700",
    "product.created": "bg-green-100 text-green-700",
    "user.blocked": "bg-orange-100 text-orange-700",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Admin Audit Logs</h2>
        <span className="text-xs text-muted-foreground">Last 50 actions</span>
      </div>
      {logs.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No audit logs yet. Admin actions will appear here.</p>
      ) : (
        <div className="space-y-2">
          {logs.map(log => (
            <div key={log.id} className="bg-card border rounded-xl p-4 flex items-start gap-3">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 mt-0.5 ${actionColors[log.action] ?? "bg-muted text-muted-foreground"}`}>
                {log.action}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground">
                  by <span className="font-medium text-foreground">{log.adminEmail ?? log.adminId?.slice(0, 8)}</span>
                  {log.targetType && <> → {log.targetType} #{log.targetId}</>}
                </p>
                {(log.after || log.before) && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {log.before && <span className="line-through mr-1">{JSON.stringify(log.before).replace(/[{}"]/g, '')}</span>}
                  {log.after && <span className="text-foreground">{JSON.stringify(log.after).replace(/[{}"]/g, '')}</span>}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-0.5">
                  {new Date(log.createdAt).toLocaleString("en-BD")}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ??? Q&A Tab ??????????????????????????????????????????????????????????????????
