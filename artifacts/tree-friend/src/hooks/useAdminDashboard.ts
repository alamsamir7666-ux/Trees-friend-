/**
 * useAdminDashboard — fetches dashboard stats (total sales, orders, etc.)
 *
 * EXTRACTED from AdminPage.tsx.
 */
import { useState, useEffect } from "react";
import { useApiJson } from "@/lib/useApiFetch";

interface DashStats {
  totalSales: number;
  totalOrders: number;
  pendingOrders: number;
  deliveredOrders: number;
}

export function useAdminDashboard() {
  const apiJson = useApiJson();
  const [dashStats, setDashStats] = useState<DashStats>({
    totalSales: 0,
    totalOrders: 0,
    pendingOrders: 0,
    deliveredOrders: 0,
  });
  const [dashStatsLoading, setDashStatsLoading] = useState(true);

  useEffect(() => {
    setDashStatsLoading(true);
    apiJson<{ totalSales?: number; totalOrders?: number; pendingOrders?: number }>("/api/admin/dashboard")
      .then((data) => {
        const totalOrders = data.totalOrders ?? 0;
        const pendingOrders = data.pendingOrders ?? 0;
        setDashStats({
          totalSales: data.totalSales ?? 0,
          totalOrders,
          pendingOrders,
          deliveredOrders: totalOrders - pendingOrders,
        });
      })
      .catch((e) => console.error("Dashboard stats error:", e instanceof Error ? e.message : e))
      .finally(() => setDashStatsLoading(false));
  }, [apiJson]);

  return { dashStats, dashStatsLoading };
}
