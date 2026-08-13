/**
 * useAdminMonthly — fetches monthly records for the Monthly History tab.
 *
 * EXTRACTED from AdminPage.tsx.
 */
import { useState, useCallback, useEffect } from "react";
import { useApiJson } from "@/lib/useApiFetch";
import type { MonthlyRecord } from "@/contexts/AdminContext";

export function useAdminMonthly(activeTab: string) {
  const apiJson = useApiJson();
  const [monthlyRecords, setMonthlyRecords] = useState<MonthlyRecord[]>([]);
  const [monthlyLoading, setMonthlyLoading] = useState(false);

  const fetchMonthlyRecords = useCallback(async () => {
    setMonthlyLoading(true);
    try {
      const data = await apiJson<MonthlyRecord[]>("/api/admin/monthly-records");
      setMonthlyRecords(Array.isArray(data) ? data : []);
    } catch {
      setMonthlyRecords([]);
    } finally {
      setMonthlyLoading(false);
    }
  }, [apiJson]);

  useEffect(() => {
    if (activeTab === "monthly") fetchMonthlyRecords();
  }, [activeTab, fetchMonthlyRecords]);

  return { monthlyRecords, monthlyLoading, fetchMonthlyRecords };
}
