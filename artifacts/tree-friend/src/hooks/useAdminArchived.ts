/**
 * useAdminArchived — fetches and manages archived orders + pre-orders.
 *
 * EXTRACTED from AdminPage.tsx. Previously 8 useState calls for archived
 * state; now encapsulated here.
 */
import { useState, useCallback, useEffect } from "react";
import { useApiJson } from "@/lib/useApiFetch";
import type { AdminPreOrder, ArchivedOrder } from "@/contexts/AdminContext";

export function useAdminArchived() {
  const apiJson = useApiJson();
  const [archivedOrders, setArchivedOrders] = useState<ArchivedOrder[]>([]);
  const [archivedPreOrders, setArchivedPreOrders] = useState<AdminPreOrder[]>([]);
  const [archivedPage, setArchivedPage] = useState(1);
  const [archivedHasMore, setArchivedHasMore] = useState(false);
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  const [activeOrdersCount, setActiveOrdersCount] = useState(0);

  const fetchArchivedOrders = useCallback(async (page: number, append = false) => {
    setArchivedLoading(true);
    try {
      const data = await apiJson<{
        orders: ArchivedOrder[];
        preOrders?: AdminPreOrder[];
        hasMore: boolean;
        total: number;
        error?: string;
      }>(`/api/admin/orders/archived?page=${page}`);
      setArchivedOrders(prev => append ? [...prev, ...data.orders] : data.orders);
      if (Array.isArray(data.preOrders)) setArchivedPreOrders(data.preOrders);
      setArchivedHasMore(data.hasMore);
      setArchivedTotal(data.total);
      setArchivedPage(page);
      setArchivedError(null);
    } catch (e) {
      setArchivedError(e instanceof Error ? e.message : "Failed to load");
    }
    setArchivedLoading(false);
  }, [apiJson]);

  useEffect(() => {
    fetchArchivedOrders(1);
    apiJson<{ activeOrders?: number; archivedOrders?: number }>("/api/admin/orders/stats")
      .then((data) => {
        setActiveOrdersCount(data.activeOrders ?? 0);
        setArchivedTotal(data.archivedOrders ?? 0);
      })
      .catch(() => {});
  }, [apiJson, fetchArchivedOrders]);

  return {
    archivedOrders,
    archivedPreOrders,
    archivedPage,
    archivedHasMore,
    archivedTotal,
    archivedLoading,
    archivedError,
    activeOrdersCount,
    fetchArchivedOrders,
  };
}
