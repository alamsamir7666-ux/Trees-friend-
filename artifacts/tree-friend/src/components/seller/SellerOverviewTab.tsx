import {
  Package2, ShoppingCart, TrendingUp, ChevronRight, Clock, Users,
  DollarSign, ArrowUpRight, ArrowDownRight, CheckCircle2, Truck,
  XCircle, BarChart3, AlertTriangle, ShieldCheck, Wallet,
  CreditCard, AlertCircle, Sprout, Eye, Star, PackageCheck,
  RotateCcw, Settings, BadgeCheck,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar,
} from "recharts";
import {
  useListMySellerListings,
  useListSellerOrders,
  useGetPublicSeller,
  useGetSellerMonthlyHistory,
  useListSellerReturns,
  useGetMySellerCourierConfig,
  useGetMySellerPaymentConfig,
  type Seller,
} from "@workspace/api-client-react";

// ── Status helpers ──────────────────────────────────────────────────────────
const orderStatusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  confirmed: "bg-blue-100 text-blue-800",
  processing: "bg-purple-100 text-purple-800",
  shipped: "bg-indigo-100 text-indigo-800",
  delivered: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
};

const statusIcons: Record<string, React.ElementType> = {
  pending: Clock,
  confirmed: CheckCircle2,
  processing: BarChart3,
  shipped: Truck,
  delivered: CheckCircle2,
  cancelled: XCircle,
};

const statusColors: Record<string, string> = {
  pending: "bg-yellow-400",
  confirmed: "bg-blue-400",
  processing: "bg-violet-400",
  shipped: "bg-indigo-400",
  delivered: "bg-emerald-400",
  cancelled: "bg-red-400",
};

const statusTextColors: Record<string, string> = {
  pending: "text-yellow-700",
  confirmed: "text-blue-700",
  processing: "text-violet-700",
  shipped: "text-indigo-700",
  delivered: "text-emerald-700",
  cancelled: "text-red-700",
};

// ── Revenue trend data generator (simulated from orders) ───────────────────
function generateRevenueTrend(orders: any[]) {
  const now = new Date();
  const days: { date: string; revenue: number; orders: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const dayOrders = orders.filter((o: any) => {
      const od = new Date(o.createdAt);
      return od.toDateString() === d.toDateString() && o.orderStatus === "delivered";
    });
    days.push({
      date: dateStr,
      revenue: dayOrders.reduce((sum: number, o: any) => sum + Number(o.totalAmount ?? 0), 0),
      orders: dayOrders.length,
    });
  }
  return days;
}

// ── KPI card ────────────────────────────────────────────────────────────────
function KpiCard({
  label, value, change, changeLabel, icon: Icon, color, trend,
}: {
  label: string; value: string | number; change?: string; changeLabel?: string;
  icon: React.ElementType; color: string; trend?: "up" | "down" | "neutral";
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5 flex flex-col gap-3 hover:shadow-md transition-shadow duration-200">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">{label}</span>
        <div className={`h-9 w-9 rounded-xl ${color} flex items-center justify-center`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="text-2xl font-bold text-gray-900 tracking-tight">{value}</p>
      <div className="flex items-center gap-1.5">
        {trend === "up" && <ArrowUpRight className="h-3.5 w-3.5 text-emerald-500" />}
        {trend === "down" && <ArrowDownRight className="h-3.5 w-3.5 text-rose-500" />}
        {trend === "neutral" && <span className="h-3.5 w-3.5 rounded-full bg-gray-200" />}
        {change && (
          <span className={`text-xs font-medium ${trend === "up" ? "text-emerald-600" : trend === "down" ? "text-rose-600" : "text-gray-500"}`}>
            {change}
          </span>
        )}
        {changeLabel && <span className="text-[11px] text-gray-400">{changeLabel}</span>}
      </div>
    </div>
  );
}

// ── Custom tooltip for charts ───────────────────────────────────────────────
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white rounded-xl border shadow-lg px-4 py-3 text-xs">
      <p className="font-semibold text-gray-700 mb-1">{label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-gray-500">{p.name}:</span>
          <span className="font-semibold text-gray-800">
            {p.name === "revenue" ? `Tk${p.value.toLocaleString()}` : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Order funnel bar ────────────────────────────────────────────────────────
function OrderFunnel({ orders }: { orders: any[] }) {
  const statusOrder = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];
  const counts = statusOrder.map((s) => ({
    status: s,
    count: orders.filter((o) => o.orderStatus === s).length,
  }));
  const maxCount = Math.max(...counts.map((c) => c.count), 1);

  return (
    <div className="space-y-3">
      {counts.filter(c => c.count > 0).map((c) => {
        const Icon = statusIcons[c.status] ?? AlertCircle;
        const pct = Math.max((c.count / maxCount) * 100, 4);
        return (
          <div key={c.status} className="flex items-center gap-3">
            <div className={`h-7 w-7 rounded-lg ${statusColors[c.status]} flex items-center justify-center shrink-0`}>
              <Icon className="h-3.5 w-3.5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1">
                <span className={`text-xs font-medium capitalize ${statusTextColors[c.status]}`}>
                  {c.status.replace("_", " ")}
                </span>
                <span className="text-xs font-bold text-gray-700">{c.count}</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${statusColors[c.status]} transition-all duration-500`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          </div>
        );
      })}
      {counts.every(c => c.count === 0) && (
        <div className="text-center py-8 text-gray-300">
          <BarChart3 className="h-8 w-8 mx-auto mb-2" />
          <p className="text-sm">No orders yet</p>
        </div>
      )}
    </div>
  );
}

// ── Quick action card ───────────────────────────────────────────────────────
function QuickActionCard({
  icon: Icon, label, count, color, onClick,
}: {
  icon: React.ElementType; label: string; count: number; color: string; onClick: () => void;
}) {
  if (count === 0) return null;
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 bg-white rounded-xl border border-gray-100 p-4 hover:shadow-md transition-all duration-200 w-full text-left group"
    >
      <div className={`h-10 w-10 rounded-xl ${color} flex items-center justify-center shrink-0`}>
        <Icon className="h-4.5 w-4.5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800 truncate">{label}</p>
        <p className="text-xs text-gray-400">Needs your attention</p>
      </div>
      <div className="flex items-center gap-2">
        <span className="h-6 min-w-[24px] px-1.5 rounded-full bg-amber-100 text-amber-700 text-xs font-bold flex items-center justify-center">
          {count}
        </span>
        <ChevronRight className="h-4 w-4 text-gray-300 group-hover:text-gray-500 transition-colors" />
      </div>
    </button>
  );
}

// ── Store health indicator ──────────────────────────────────────────────────
function HealthIndicator({
  label, status, icon: Icon, detail,
}: {
  label: string; status: "ok" | "warning" | "missing"; icon: React.ElementType; detail: string;
}) {
  const dotColor = status === "ok" ? "bg-emerald-400" : status === "warning" ? "bg-amber-400" : "bg-gray-300";
  const textColor = status === "ok" ? "text-emerald-700" : status === "warning" ? "text-amber-700" : "text-gray-500";
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="h-8 w-8 rounded-lg bg-gray-50 border flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4 text-gray-500" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-gray-700">{label}</p>
        <p className="text-[11px] text-gray-400 truncate">{detail}</p>
      </div>
      <div className="flex items-center gap-1.5">
        <span className={`h-2 w-2 rounded-full ${dotColor}`} />
        <span className={`text-[11px] font-medium capitalize ${textColor}`}>
          {status === "ok" ? "Connected" : status === "warning" ? "Pending" : "Not set up"}
        </span>
      </div>
    </div>
  );
}

// ── Top listing card ────────────────────────────────────────────────────────
function TopListingCard({
  listing, orderCount, revenue, rank,
}: {
  listing: any; orderCount: number; revenue: number; rank: number;
}) {
  const name = listing.productName ?? `Listing #${listing.id}`;
  const imageUrl = listing.images?.[0];
  const statusColor = listing.approvalStatus === "approved"
    ? "bg-emerald-50 text-emerald-700"
    : listing.approvalStatus === "pending"
      ? "bg-amber-50 text-amber-700"
      : "bg-red-50 text-red-700";

  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="h-8 w-8 rounded-lg bg-gray-50 border flex items-center justify-center shrink-0 text-xs font-bold text-gray-400">
        {rank}
      </div>
      {imageUrl ? (
        <img src={imageUrl} alt={name} className="h-9 w-9 rounded-lg object-cover border shrink-0" />
      ) : (
        <div className="h-9 w-9 rounded-lg bg-violet-50 border flex items-center justify-center shrink-0">
          <Sprout className="h-4 w-4 text-violet-400" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-gray-800 truncate">{name}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium capitalize ${statusColor}`}>
            {listing.approvalStatus}
          </span>
          <span className="text-[11px] text-gray-400">{orderCount} orders</span>
        </div>
      </div>
      <span className="text-xs font-semibold text-gray-800 shrink-0">
        Tk{revenue.toLocaleString()}
      </span>
    </div>
  );
}

// ── Main SellerOverviewTab ──────────────────────────────────────────────────
export function SellerOverviewTab({
  seller,
  onNavigate,
}: {
  seller: Seller;
  onNavigate: (section: string) => void;
}) {
  const { data: listings, isLoading: listingsLoading } = useListMySellerListings();
  const { data: orders, isLoading: ordersLoading } = useListSellerOrders({});
  const { data: publicProfile, isLoading: followersLoading } = useGetPublicSeller(seller.id, {
    query: { enabled: !!seller.id, queryKey: ["public-seller", seller.id] },
  });
  const { data: monthlyHistory } = useGetSellerMonthlyHistory(
    { months: 6 },
    { query: { enabled: !!seller.id, queryKey: ["seller-monthly-history", seller.id] } } as any,
  );
  const { data: returns } = useListSellerReturns(
    {},
    { query: { enabled: !!seller.id, queryKey: ["seller-returns-overview"] } } as any,
  );
  const { data: courierConfig } = useGetMySellerCourierConfig(
    { query: { enabled: !!seller.id, queryKey: ["seller-courier-overview"] } } as any,
  );
  const { data: paymentConfig } = useGetMySellerPaymentConfig(
    { query: { enabled: !!seller.id, queryKey: ["seller-payment-overview"] } } as any,
  );

  const loading = listingsLoading || ordersLoading;

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
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
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 bg-white rounded-2xl border p-5">
            <Skeleton className="h-5 w-40 mb-5" />
            <div className="h-48"><Skeleton className="h-full w-full rounded-xl" /></div>
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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-white rounded-2xl border p-5">
            <Skeleton className="h-5 w-40 mb-5" />
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-8 w-8 rounded-lg" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                  <Skeleton className="h-6 w-16 rounded-full" />
                </div>
              ))}
            </div>
          </div>
          <div className="bg-white rounded-2xl border p-5">
            <Skeleton className="h-5 w-40 mb-5" />
            <div className="h-36"><Skeleton className="h-full w-full rounded-xl" /></div>
          </div>
        </div>
      </div>
    );
  }

  // ── Computed data ──────────────────────────────────────────────────────────
  const allListings = listings ?? [];
  const allOrders = orders ?? [];
  const activeListingsCount = allListings.length;
  const pendingOrdersCount = allOrders.filter((o) => o.orderStatus === "pending").length;
  const pendingReturnsCount = (returns as any)?.returns?.filter((r: any) => r.status === "requested").length ?? 0;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonthSales = allOrders
    .filter((o) => o.orderStatus !== "cancelled" && new Date(o.createdAt) >= startOfMonth)
    .reduce((sum, o) => sum + Number(o.totalAmount ?? 0), 0);

  const totalDeliveredRevenue = allOrders
    .filter((o) => o.orderStatus === "delivered")
    .reduce((sum, o) => sum + Number(o.totalAmount ?? 0), 0);

  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const lastMonthSales = allOrders
    .filter((o) => o.orderStatus !== "cancelled" && new Date(o.createdAt) >= lastMonth && new Date(o.createdAt) <= lastMonthEnd)
    .reduce((sum, o) => sum + Number(o.totalAmount ?? 0), 0);

  const revenueTrend = generateRevenueTrend(allOrders);

  const recentOrders = [...allOrders]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  // ── Top listings by order count ────────────────────────────────────────────
  const topListings = (() => {
    const map = new Map<number, { listing: any; orderCount: number; revenue: number }>();
    for (const o of allOrders) {
      const items = (o as any).items ?? [];
      for (const item of items) {
        const listingId = item.sellerListingId ?? item.listingId;
        if (!listingId) continue;
        const existing = map.get(listingId) ?? { listing: null, orderCount: 0, revenue: 0 };
        existing.orderCount += 1;
        if (o.orderStatus === "delivered") {
          existing.revenue += Number(item.price ?? item.total ?? 0);
        }
        map.set(listingId, existing);
      }
    }
    // Merge with actual listing data
    for (const l of allListings) {
      const existing = map.get(l.id);
      if (existing) {
        existing.listing = l;
      }
    }
    // Add listings with no orders yet
    for (const l of allListings) {
      if (!map.has(l.id)) {
        map.set(l.id, { listing: l, orderCount: 0, revenue: 0 });
      }
    }
    return Array.from(map.values())
      .filter(x => x.listing)
      .sort((a, b) => b.revenue - a.revenue || b.orderCount - a.orderCount)
      .slice(0, 5);
  })();

  // ── Monthly revenue bar chart data ────────────────────────────────────────
  const monthlyBarData = (() => {
    const records = (monthlyHistory as any)?.records ?? [];
    if (records.length > 0) {
      return records.map((r: any) => ({
        month: new Date(r.year, r.month - 1).toLocaleDateString("en-US", { month: "short" }),
        revenue: r.totalRevenue,
        orders: r.totalOrders,
      }));
    }
    // Fallback: compute from orders
    const months: { month: string; revenue: number; orders: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const monthOrders = allOrders.filter((o) => {
        const od = new Date(o.createdAt);
        return od >= d && od <= monthEnd && o.orderStatus === "delivered";
      });
      months.push({
        month: d.toLocaleDateString("en-US", { month: "short" }),
        revenue: monthOrders.reduce((sum, o) => sum + Number(o.totalAmount ?? 0), 0),
        orders: monthOrders.length,
      });
    }
    return months;
  })();

  // ── Store health ──────────────────────────────────────────────────────────
  const isPaymentConfigured = !!(paymentConfig as any);
  const isPaymentVerified = (paymentConfig as any)?.verificationStatus === "verified";
  const isCourierConfigured = !!(courierConfig as any);
  const isCourierVerified = (courierConfig as any)?.verificationStatus === "verified";

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* ── KPI Row ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Active Listings"
          value={activeListingsCount > 0 ? activeListingsCount : 0}
          change={activeListingsCount > 0 ? "listed products" : undefined}
          changeLabel={activeListingsCount > 0 ? undefined : "No listings yet"}
          icon={Package2}
          color="bg-violet-50 text-violet-600"
          trend={activeListingsCount > 0 ? "up" : "neutral"}
        />
        <KpiCard
          label="Pending Orders"
          value={pendingOrdersCount > 0 ? pendingOrdersCount : 0}
          change={pendingOrdersCount > 0 ? "need action" : undefined}
          changeLabel={pendingOrdersCount > 0 ? undefined : "All caught up"}
          icon={ShoppingCart}
          color="bg-blue-50 text-blue-600"
          trend={pendingOrdersCount > 0 ? "down" : "neutral"}
        />
        <KpiCard
          label="Revenue (This Month)"
          value={thisMonthSales > 0 ? `Tk${thisMonthSales.toLocaleString()}` : "Tk0"}
          change={thisMonthSales > 0
            ? lastMonthSales > 0
              ? `${((thisMonthSales - lastMonthSales) / lastMonthSales * 100).toFixed(0)}% vs last`
              : "from delivered orders"
            : undefined}
          changeLabel={thisMonthSales > 0 ? undefined : "No sales yet"}
          icon={DollarSign}
          color="bg-emerald-50 text-emerald-600"
          trend={thisMonthSales > 0 ? (lastMonthSales > 0 && thisMonthSales >= lastMonthSales ? "up" : thisMonthSales > 0 ? "up" : "neutral") : "neutral"}
        />
        <KpiCard
          label="Followers"
          value={publicProfile && publicProfile.followerCount > 0 ? publicProfile.followerCount.toLocaleString() : 0}
          change={publicProfile && publicProfile.followerCount > 0 ? "following your store" : undefined}
          changeLabel={publicProfile && publicProfile.followerCount > 0 ? undefined : "No followers yet"}
          icon={Users}
          color="bg-pink-50 text-pink-600"
          trend={publicProfile && publicProfile.followerCount > 0 ? "up" : "neutral"}
        />
      </div>

      {/* ── Revenue Trend + Order Pipeline ─────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Revenue trend chart */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-gray-800 text-sm">Revenue Overview</h3>
              <p className="text-xs text-gray-400 mt-0.5">Last 30 days, delivered orders only</p>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 rounded-full bg-pink-400" />
              <span className="text-[11px] text-gray-400">Revenue</span>
            </div>
          </div>
          <div className="h-52">
            {revenueTrend.some(d => d.revenue > 0) ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={revenueTrend} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="sellerRevenueGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f472b6" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#f472b6" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} interval={4} />
                  <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `Tk${v}`} />
                  <Tooltip content={<ChartTooltip />} />
                  <Area type="monotone" dataKey="revenue" stroke="#f472b6" strokeWidth={2} fill="url(#sellerRevenueGrad)" name="revenue" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-gray-300">
                <TrendingUp className="h-8 w-8 mb-2" />
                <p className="text-sm">Revenue data will appear here</p>
              </div>
            )}
          </div>
        </div>

        {/* Order funnel */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-gray-800 text-sm">Order Pipeline</h3>
              <p className="text-xs text-gray-400 mt-0.5">{allOrders.length} total orders</p>
            </div>
            <button onClick={() => onNavigate("orders")} className="text-xs text-pink-500 hover:underline flex items-center gap-1">
              View all <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          <OrderFunnel orders={allOrders} />
        </div>
      </div>

      {/* ── Quick Actions ──────────────────────────────────────────────────── */}
      {(pendingOrdersCount > 0 || pendingReturnsCount > 0 || !isPaymentConfigured || !isCourierConfigured) && (
        <div>
          <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Action Required
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <QuickActionCard
              icon={ShoppingCart}
              label="Pending Orders"
              count={pendingOrdersCount}
              color="bg-blue-50 text-blue-600"
              onClick={() => onNavigate("orders")}
            />
            <QuickActionCard
              icon={RotateCcw}
              label="Return Requests"
              count={pendingReturnsCount}
              color="bg-orange-50 text-orange-600"
              onClick={() => onNavigate("returns")}
            />
            {!isPaymentConfigured && (
              <QuickActionCard
                icon={CreditCard}
                label="Set Up Payments"
                count={1}
                color="bg-emerald-50 text-emerald-600"
                onClick={() => onNavigate("payment")}
              />
            )}
            {!isCourierConfigured && (
              <QuickActionCard
                icon={Truck}
                label="Set Up Courier"
                count={1}
                color="bg-violet-50 text-violet-600"
                onClick={() => onNavigate("courier")}
              />
            )}
          </div>
        </div>
      )}

      {/* ── Store Health + Top Listings ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Store Health */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-gray-800 text-sm">Store Health</h3>
              <p className="text-xs text-gray-400 mt-0.5">Configuration & verification status</p>
            </div>
            <button onClick={() => onNavigate("profile")} className="text-xs text-pink-500 hover:underline flex items-center gap-1">
              Settings <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          <div className="divide-y divide-gray-50">
            <HealthIndicator
              label="Verified Seller Badge"
              status={seller.isVerified ? "ok" : seller.verificationRequestStatus === "requested" ? "warning" : "missing"}
              icon={BadgeCheck}
              detail={seller.isVerified ? "Your store is verified" : seller.verificationRequestStatus === "requested" ? "Verification under review" : "Request verification to build trust"}
            />
            <HealthIndicator
              label="Payment Setup"
              status={isPaymentVerified ? "ok" : isPaymentConfigured ? "warning" : "missing"}
              icon={CreditCard}
              detail={isPaymentVerified ? "bKash connected & verified" : isPaymentConfigured ? "Connected, pending verification" : "Connect bKash to receive payments"}
            />
            <HealthIndicator
              label="Courier Setup"
              status={isCourierVerified ? "ok" : isCourierConfigured ? "warning" : "missing"}
              icon={Truck}
              detail={isCourierVerified ? "Courier connected & verified" : isCourierConfigured ? "Connected, pending verification" : "Connect a courier to ship orders"}
            />
            <HealthIndicator
              label="Subscription"
              status={seller.subscriptionStatus === "active" ? "ok" : seller.subscriptionStatus === "trial" ? "warning" : "missing"}
              icon={Wallet}
              detail={seller.subscriptionStatus === "active"
                ? "Active subscription"
                : seller.subscriptionStatus === "trial"
                  ? seller.trialEndsAt
                    ? `Trial ends ${new Date(seller.trialEndsAt).toLocaleDateString()}`
                    : "Trial period"
                  : "Subscription expired"}
            />
          </div>
        </div>

        {/* Top Listings */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-gray-800 text-sm">Listing Performance</h3>
              <p className="text-xs text-gray-400 mt-0.5">Top listings by revenue</p>
            </div>
            <button onClick={() => onNavigate("listings")} className="text-xs text-pink-500 hover:underline flex items-center gap-1">
              View all <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          {topListings.length > 0 ? (
            <div className="divide-y divide-gray-50">
              {topListings.map((t, i) => (
                <TopListingCard key={t.listing.id} listing={t.listing} orderCount={t.orderCount} revenue={t.revenue} rank={i + 1} />
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-300">
              <Sprout className="h-8 w-8 mx-auto mb-2" />
              <p className="text-sm">No listing data yet</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Monthly Revenue Bar Chart ──────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-gray-800 text-sm">Monthly Revenue</h3>
            <p className="text-xs text-gray-400 mt-0.5">Last 6 months, delivered orders</p>
          </div>
          <button onClick={() => onNavigate("monthlyHistory")} className="text-xs text-pink-500 hover:underline flex items-center gap-1">
            Details <ChevronRight className="h-3 w-3" />
          </button>
        </div>
        <div className="h-52">
          {monthlyBarData.some((d: { revenue: number }) => d.revenue > 0) ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyBarData} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#9ca3af" }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `Tk${v}`} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="revenue" fill="#f472b6" radius={[6, 6, 0, 0]} name="revenue" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-gray-300">
              <BarChart3 className="h-8 w-8 mb-2" />
              <p className="text-sm">Monthly revenue will appear here</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Recent Orders ──────────────────────────────────────────────────── */}
      {recentOrders.length > 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-50">
            <div>
              <h3 className="font-semibold text-gray-800 text-sm">Recent Orders</h3>
              <p className="text-xs text-gray-400 mt-0.5">Latest 5 orders from your store</p>
            </div>
            <button onClick={() => onNavigate("orders")} className="text-xs text-pink-500 hover:underline flex items-center gap-1">
              View all <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          <div className="divide-y divide-gray-50">
            {recentOrders.map((o) => {
              const StatusIcon = statusIcons[o.orderStatus] ?? Clock;
              return (
                <div key={o.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-50/50 transition-colors">
                  <div className="h-9 w-9 rounded-lg bg-gray-50 border flex items-center justify-center shrink-0">
                    <StatusIcon className="h-4 w-4 text-gray-400" />
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
              );
            })}
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center">
          <ShoppingCart className="h-12 w-12 text-gray-200 mx-auto mb-4" />
          <p className="font-semibold text-gray-500 mb-1">No orders yet</p>
          <p className="text-sm text-gray-400">Orders will appear here once buyers start purchasing your listings.</p>
        </div>
      )}

      {/* ── Quick Stats Footer ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-emerald-50 flex items-center justify-center shrink-0">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          </div>
          <div>
            <p className="text-xs text-gray-400">Delivered</p>
            <p className="text-sm font-bold text-gray-800">{allOrders.filter(o => o.orderStatus === "delivered").length}</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
            <Truck className="h-4 w-4 text-indigo-500" />
          </div>
          <div>
            <p className="text-xs text-gray-400">Shipped</p>
            <p className="text-sm font-bold text-gray-800">{allOrders.filter(o => o.orderStatus === "shipped").length}</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
            <XCircle className="h-4 w-4 text-red-500" />
          </div>
          <div>
            <p className="text-xs text-gray-400">Cancelled</p>
            <p className="text-sm font-bold text-gray-800">{allOrders.filter(o => o.orderStatus === "cancelled").length}</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-pink-50 flex items-center justify-center shrink-0">
            <DollarSign className="h-4 w-4 text-pink-500" />
          </div>
          <div>
            <p className="text-xs text-gray-400">Lifetime Revenue</p>
            <p className="text-sm font-bold text-gray-800">Tk{totalDeliveredRevenue.toLocaleString()}</p>
          </div>
        </div>
      </div>

      {/* ── CTA for no listings ─────────────────────────────────────────────── */}
      {activeListingsCount === 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 p-6 flex items-center justify-between gap-4 flex-wrap">
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
