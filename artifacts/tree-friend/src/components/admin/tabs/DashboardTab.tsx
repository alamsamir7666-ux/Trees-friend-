import { useAdminContext } from "@/contexts/AdminContext";
import { Skeleton } from "@/components/ui/skeleton";
import { DollarSign, ShoppingCart, Package2, Users, ChevronRight, AlertCircle } from "lucide-react";

export function DashboardTab() {
const {
    dashStats,
    dashStatsLoading,
    activeOrdersCount,
    orders,
    ordersLoading,
    totalRevenue,
    deliveredOrders,
    recentCombined,
    statusConfig,
    products,
    productsData,
    categories,
    users,
    pendingOrders,
    setActiveTab,
    totalOrdersThisMonth,
  } = useAdminContext();

  const dashLoading = dashStatsLoading;
  if (dashLoading) {
    return (
      <div className="space-y-6">
        {/* Stat cards skeleton */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-white rounded-2xl border p-5 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-24 rounded-full" />
                <Skeleton className="h-9 w-9 rounded-xl" />
              </div>
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-3 w-32 rounded-full" />
            </div>
          ))}
        </div>
        {/* Recent orders + chart skeleton */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 bg-white rounded-2xl border overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-16" />
            </div>
            <div className="divide-y">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-5 py-3">
                  <Skeleton className="h-8 w-8 rounded-lg shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                  <Skeleton className="h-6 w-20 rounded-full" />
                  <Skeleton className="h-4 w-16 shrink-0" />
                </div>
              ))}
            </div>
          </div>
          <div className="bg-white rounded-2xl border p-5">
            <Skeleton className="h-5 w-40 mb-5" />
            <div className="space-y-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Skeleton className="h-3.5 w-20" />
                    <Skeleton className="h-3 w-6" />
                  </div>
                  <Skeleton className="h-2 w-full rounded-full" />
                </div>
              ))}
            </div>
          </div>
        </div>
        {/* Category breakdown skeleton */}
        <div className="bg-white rounded-2xl border p-5">
          <div className="flex items-center justify-between mb-4">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-4 w-16" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-pink-50 rounded-xl p-4 text-center space-y-2">
                <Skeleton className="h-8 w-10 mx-auto" />
                <Skeleton className="h-3 w-16 mx-auto rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  return (
  <div className="space-y-6">
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {[
        {
          label: "Revenue (This Month)",
          value: totalRevenue > 0 ? `Tk${(totalRevenue / 1000).toFixed(1)}k` : "-",
          change: totalRevenue > 0 ? "from delivered orders" : "No delivered orders yet",
          icon: DollarSign,
          color: "bg-emerald-50 text-emerald-600",
        },
        {
          label: "Orders (This Month)",
          value: totalOrdersThisMonth > 0 ? totalOrdersThisMonth : "-",
          change: totalOrdersThisMonth > 0 ? `${pendingOrders} pending` : "No orders yet",
          icon: ShoppingCart,
          color: "bg-blue-50 text-blue-600",
        },
        {
          label: "Products",
          value: (productsData?.total ?? products.length) > 0 ? (productsData?.total ?? products.length) : "-",
          // Same Phase 2 marketplace-derived fix as ProductsTab.tsx's Stock
          // column: Product.inStock is frozen false post-Phase-2, so this
          // must read listingCount instead.
          change: products.length > 0 ? `${products.filter(p => ((p as any).listingCount ?? 0) === 0).length} low stock` : "No products yet",
          icon: Package2,
          color: "bg-violet-50 text-violet-600",
        },
        {
          label: "Customers",
          value: users && users.length > 0 ? users.length : "-",
          change: deliveredOrders > 0 ? `${deliveredOrders} delivered` : "No deliveries yet",
          icon: Users,
          color: "bg-pink-50 text-pink-600",
        },
      ].map(({ label, value, change, icon: Icon, color }) => (
        <div key={label} className="bg-white rounded-2xl border p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">{label}</span>
            <div className={`h-9 w-9 rounded-xl ${color} flex items-center justify-center`}>
              <Icon className="h-4 w-4" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
          <p className="text-xs text-gray-500">{change}</p>
        </div>
      ))}
    </div>

    {orders.length > 0 ? (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white rounded-2xl border overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <h3 className="font-semibold text-gray-800">Recent Orders</h3>
            <button onClick={() => setActiveTab("orders")} className="text-xs text-pink-500 hover:underline flex items-center gap-1">
              View all <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          <div className="divide-y">
            {recentCombined.map((o) => {
              const cfg = statusConfig[o.orderStatus] ?? { color: "bg-gray-100 text-gray-600", icon: AlertCircle };
              const StatusIcon = cfg.icon;
              return (
                <div key={o.id} className="flex items-center gap-4 px-5 py-3">
                  <div className="h-8 w-8 rounded-lg bg-gray-50 border flex items-center justify-center shrink-0">
                    <span className="text-xs font-bold text-gray-500">#{o.id}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">Order #{o.id}</p>
                    <p className="text-xs text-gray-400">{new Date(o.createdAt).toLocaleDateString()}</p>
                  </div>
                  <span className={`flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${cfg.color}`}>
                    <StatusIcon className="h-3 w-3" />{o.orderStatus}
                  </span>
                  <span className="text-sm font-semibold text-gray-800 shrink-0">Tk{o.totalAmount.toLocaleString()}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-white rounded-2xl border p-5">
          <h3 className="font-semibold text-gray-800 mb-4">Order Status Breakdown</h3>
          <div className="space-y-3">
            {Object.entries(
              orders.reduce<Record<string, number>>((acc, o) => {
                acc[o.orderStatus] = (acc[o.orderStatus] || 0) + 1;
                return acc;
              }, {})
            ).map(([status, count]) => (
              <div key={status}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm text-gray-600 capitalize">{status}</span>
                  <span className="text-xs font-semibold text-gray-800">{count}</span>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-pink-400 to-rose-400 transition-all"
                    style={{ width: `${(count / orders.length) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    ) : (
      <div className="bg-white rounded-2xl border p-12 text-center">
        <ShoppingCart className="h-12 w-12 text-gray-200 mx-auto mb-4" />
        <p className="font-semibold text-gray-500 mb-1">No orders yet</p>
        <p className="text-sm text-gray-400">Orders will appear here once customers start purchasing.</p>
      </div>
    )}

    {products.length > 0 && (
      <div className="bg-white rounded-2xl border p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-800">Products by Category</h3>
          <button onClick={() => setActiveTab("products")} className="text-xs text-pink-500 hover:underline flex items-center gap-1">
            Manage <ChevronRight className="h-3 w-3" />
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(
            products.reduce<Record<string, number>>((acc, p) => {
              const cat = categories.find((c: any) => c.id === p.categoryId);
              const catName = cat?.name ?? "Uncategorized";
              acc[catName] = (acc[catName] || 0) + 1;
              return acc;
            }, {})
          ).map(([cat, count]) => (
            <div key={cat} className="bg-pink-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-pink-600">{count}</p>
              <p className="text-xs text-gray-500 capitalize mt-1">{cat}</p>
            </div>
          ))}
        </div>
      </div>
    )}
  </div>
  );
};
