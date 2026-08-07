import { useAdminContext } from "@/contexts/AdminContext";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Archive, Calendar } from "lucide-react";

export function MonthlyHistoryTab() {
const {
    monthlyRecords,
    monthlyLoading,
    handleArchiveNow,
  } = useAdminContext();

  const monthNames = ["", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm text-muted-foreground">
            Monthly revenue and order snapshots. Stats reset at the start of each month. Dashboard shows current month only.
          </p>
        </div>
        <Button variant="outline" onClick={handleArchiveNow} className="rounded-xl text-sm shrink-0">
          <Archive className="h-4 w-4 mr-1.5" /> Archive Last Month
        </Button>
      </div>

      {monthlyLoading ? (
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
      ) : monthlyRecords.length === 0 ? (
        <div className="bg-card rounded-2xl border p-14 text-center">
          <Calendar className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <p className="font-semibold text-muted-foreground mb-1">No monthly records yet</p>
          <p className="text-sm text-muted-foreground/70 mb-4">Records are archived automatically on the 1st of each month, or manually via the button above.</p>
        </div>
      ) : (
        <div className="bg-card rounded-2xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Month</th>
                  <th className="px-5 py-3.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Total Orders</th>
                  <th className="px-5 py-3.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Revenue (Delivered)</th>
                  <th className="px-5 py-3.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Archived On</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-muted/50">
                {monthlyRecords.map((r) => (
                  <tr key={r.id} className="hover:bg-primary/5 transition-colors">
                    <td className="px-5 py-4">
                      <p className="font-semibold text-foreground">{monthNames[r.month]} {r.year}</p>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <span className="font-semibold text-foreground">{r.totalOrders}</span>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <span className="font-semibold text-success-foreground">Tk{Number(r.totalRevenue).toLocaleString()}</span>
                    </td>
                    <td className="px-5 py-4 text-right text-xs text-muted-foreground/70">
                      {r.archivedAt ? new Date(r.archivedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
