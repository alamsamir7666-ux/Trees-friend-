/**
 * useAdminOrders — fetches and manages admin orders + pre-orders.
 *
 * EXTRACTED from AdminPage.tsx to reduce the god-component's state surface.
 * Previously AdminPage had 8+ useState calls just for orders; now it's
 * encapsulated in this hook.
 */
import { useState, useCallback, useEffect } from "react";
import { useApiJson } from "@/lib/useApiFetch";
import type { AdminOrder, AdminPreOrder } from "@/contexts/AdminContext";

export function useAdminOrders() {
  const apiJson = useApiJson();
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [adminPreOrders, setAdminPreOrders] = useState<AdminPreOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersHasMore, setOrdersHasMore] = useState(false);
  const [ordersTotal, setOrdersTotal] = useState(0);

  const fetchOrders = useCallback(async (page: number, append = false) => {
    setOrdersLoading(true);
    try {
      const data = await apiJson<{ orders?: AdminOrder[]; total?: number; hasMore?: boolean } | AdminOrder[]>(`/api/admin/orders?page=${page}`);
      const list: AdminOrder[] = Array.isArray(data) ? data : (data.orders ?? []);
      setOrders(prev => append ? [...prev, ...list] : list);
      setOrdersHasMore(Array.isArray(data) ? list.length === 20 : (data.hasMore ?? list.length === 20));
      if (!append) setOrdersTotal(Array.isArray(data) ? list.length : (data.total ?? list.length));
      setOrdersPage(page);
    } catch (e) {
      console.error("fetchOrders error:", e instanceof Error ? e.message : e);
    }
    setOrdersLoading(false);
  }, [apiJson]);

  const fetchAdminPreOrders = useCallback(async () => {
    try {
      const data = await apiJson<AdminPreOrder[]>("/api/admin/pre-orders");
      if (Array.isArray(data)) setAdminPreOrders(data);
    } catch {}
  }, [apiJson]);

  useEffect(() => {
    fetchOrders(1);
    fetchAdminPreOrders();
  }, [fetchOrders, fetchAdminPreOrders]);

  return {
    orders,
    adminPreOrders,
    ordersLoading,
    ordersPage,
    ordersHasMore,
    ordersTotal,
    fetchOrders,
    fetchAdminPreOrders,
  };
}
