import { Package2, ShoppingCart, TrendingUp, ChevronRight, Clock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useListMySellerListings,
  useListSellerOrders,
  type Seller,
} from "@workspace/api-client-react";

/**
 * Seller dashboard landing/overview section, matching admin's DashboardTab
 * pattern (stat cards + a recent-activity list). Only surfaces data already
 * fetchable from existing seller API hooks (useListMySellerListings,
 * useListSellerOrders) -- no new backend endpoints, per task scope.
 */

const orderStatusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  confirmed: "bg-blue-100 text-blue-800",
  processing: "bg-purple-100 text-purple-800",
  shipped: "bg-indigo-100 text-indigo-800",
  delivered: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
};

export function SellerOverviewTab({
  seller,
  onNavigate,
}: {
  seller: Seller;
  onNavigate: (section: string) => void;
}) {
  const { data: listings, isLoading: listingsLoading } = useListMySellerListings();
  const { data: orders, isLoading: ordersLoading } = useListSellerOrders({});

  const loading = listingsLoading || ordersLoading;

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-white rounded-2xl border p-5 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-24 rounded-full" />
                <Skeleton className="h-9 w-9 rounded-xl" />
              </div>
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-3 w-28 rounded-full" />
            </div>
          ))}
        </div>
        <div className="bg-white rounded-2xl border overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <Skeleton className="h-5 w-32" />
          </div>
          <div className="divide-y">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-3">
                <Skeleton className="h-8 w-8 rounded-lg shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const activeListingsCount = (listings ?? []).length;
  const allOrders = orders ?? [];
  const pendingOrdersCount = allOrders.filter((o) => o.orderStatus === "pending").length;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonthSales = allOrders
    .filter((o) => o.orderStatus !== "cancelled" && new Date(o.createdAt) >= startOfMonth)
    .reduce((sum, o) => sum + Number(o.totalAmount ?? 0), 0);

  const recentOrders = [...allOrders]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Active Listings</span>
            <div className="h-9 w-9 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center">
              <Package2 className="h-4 w-4" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900">{activeListingsCount > 0 ? activeListingsCount : "-"}</p>
          <p className="text-xs text-gray-500">{activeListingsCount > 0 ? "listed products" : "No listings yet"}</p>
        </div>

        <div className="bg-white rounded-2xl border p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Pending Orders</span>
            <div className="h-9 w-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
              <ShoppingCart className="h-4 w-4" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900">{pendingOrdersCount > 0 ? pendingOrdersCount : "-"}</p>
          <p className="text-xs text-gray-500">{pendingOrdersCount > 0 ? "need action" : "No pending orders"}</p>
        </div>

        <div className="bg-white rounded-2xl border p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Sales (This Month)</span>
            <div className="h-9 w-9 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <TrendingUp className="h-4 w-4" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900">{thisMonthSales > 0 ? `Tk${thisMonthSales.toLocaleString()}` : "-"}</p>
          <p className="text-xs text-gray-500">{thisMonthSales > 0 ? "from non-cancelled orders" : "No sales yet this month"}</p>
        </div>
      </div>

      {recentOrders.length > 0 ? (
        <div className="bg-white rounded-2xl border overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <h3 className="font-semibold text-gray-800">Recent Orders</h3>
            <button onClick={() => onNavigate("orders")} className="text-xs text-pink-500 hover:underline flex items-center gap-1">
              View all <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          <div className="divide-y">
            {recentOrders.map((o) => (
              <div key={o.id} className="flex items-center gap-4 px-5 py-3">
                <div className="h-8 w-8 rounded-lg bg-gray-50 border flex items-center justify-center shrink-0">
                  <Clock className="h-3.5 w-3.5 text-gray-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{o.trackingId}</p>
                  <p className="text-xs text-gray-400">{new Date(o.createdAt).toLocaleDateString()}</p>
                </div>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${orderStatusColors[o.orderStatus] ?? "bg-gray-100 text-gray-600"}`}>
                  {o.orderStatus}
                </span>
                <span className="text-sm font-semibold text-gray-800 shrink-0">Tk{Number(o.totalAmount ?? 0).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border p-12 text-center">
          <ShoppingCart className="h-12 w-12 text-gray-200 mx-auto mb-4" />
          <p className="font-semibold text-gray-500 mb-1">No orders yet</p>
          <p className="text-sm text-gray-400">Orders will appear here once buyers start purchasing your listings.</p>
        </div>
      )}

      {activeListingsCount === 0 && (
        <div className="bg-white rounded-2xl border p-6 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="font-semibold text-gray-800 text-sm">You don't have any listings yet</p>
            <p className="text-xs text-gray-500 mt-0.5">Add your first listing to start selling on Tree Friend.</p>
          </div>
          <button
            onClick={() => onNavigate("listings")}
            className="px-4 py-2 rounded-xl text-sm font-medium bg-pink-500 hover:bg-pink-600 text-white transition-colors shrink-0"
          >
            Add a Listing
          </button>
        </div>
      )}
    </div>
  );
}
