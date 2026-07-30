import { useAdminContext } from "@/contexts/AdminContext";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DollarSign, ShoppingCart, Package2, Users, ChevronRight, AlertCircle, Store,
  TrendingUp, ArrowUpRight, ArrowDownRight, Clock, CheckCircle2,
  Truck, XCircle, ShieldCheck, BadgeCheck, Wallet,
  Activity, BarChart3, Sprout, AlertTriangle,
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, BarChart, Bar,
} from "recharts";
import {
  useListSellers,
  useListAdminSellerPaymentConfigs,
  useListAdminSellerCourierConfigs,
  useListSellerVerificationRequests,
} from "@workspace/api-client-react";

// ── Status helpers ──────────────────────────────────────────────────────────
const SELLER_STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  pending_verification: "bg-amber-50 text-amber-700 border-amber-200",
  suspended: "bg-rose-50 text-rose-700 border-rose-200",
  vacation: "bg-sky-50 text-sky-700 border-sky-200",
};
const SELLER_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  pending_verification: "Pending",
  suspended: "Suspended",
  vacation: "On vacation",
};

const PIE_COLORS = ["#10b981", "#f59e0b", "#ef4444", "#0ea5e9", "#8b5cf6"];

// ── Mini sparkline data generator (simulated from orders) ───────────────────
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
          <span className="font-semibold text-gray-800">{p.name === "revenue" ? `Tk${p.value.toLocaleString()}` : p.value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Seller status donut ─────────────────────────────────────────────────────
function SellerStatusDonut({ sellers }: { sellers: any[] }) {
  const statusCounts = sellers.reduce<Record<string, number>>((acc, s) => {
    const st = s.status ?? "unknown";
    acc[st] = (acc[st] || 0) + 1;
    return acc;
  }, {});

  const data = Object.entries(statusCounts).map(([status, count]) => ({
    name: SELLER_STATUS_LABEL[status] ?? status,
    value: count,
    status,
  }));

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-300">
        <Sprout className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-6">
      <div className="h-36 w-36 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} cx="50%" cy="50%" innerRadius={40} outerRadius={65} paddingAngle={3} dataKey="value" stroke="none">
              {data.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="space-y-2 flex-1 min-w-0">
        {data.map((d, i) => (
          <div key={d.status} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
            <span className="text-xs text-gray-600 truncate flex-1">{d.name}</span>
            <span className="text-xs font-semibold text-gray-800">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Order funnel bar ────────────────────────────────────────────────────────
function OrderFunnel({ orders }: { orders: any[] }) {
  const statusOrder = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];
  const statusIcons: Record<string, React.ElementType> = {
    pending: Clock, confirmed: CheckCircle2, processing: BarChart3,
    shipped: Truck, delivered: CheckCircle2, cancelled: XCircle,
  };
  const statusColors: Record<string, string> = {
    pending: "bg-yellow-400", confirmed: "bg-blue-400", processing: "bg-violet-400",
    shipped: "bg-indigo-400", delivered: "bg-emerald-400", cancelled: "bg-red-400",
  };
  const statusTextColors: Record<string, string> = {
    pending: "text-yellow-700", confirmed: "text-blue-700", processing: "text-violet-700",
    shipped: "text-indigo-700", delivered: "text-emerald-700", cancelled: "text-red-700",
  };

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
                <span className={`text-xs font-medium capitalize ${statusTextColors[c.status]}`}>{c.status.replace("_", " ")}</span>
                <span className="text-xs font-bold text-gray-700">{c.count}</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${statusColors[c.status]} transition-all duration-500`} style={{ width: `${pct}%` }} />
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

// ── Pending action card ─────────────────────────────────────────────────────
function PendingActionCard({
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

// ── Main DashboardTab ───────────────────────────────────────────────────────
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

  // ── Fetch seller data for dashboard ─────────────────────────────────────
  const { data: pendingSellers } = useListSellers(
    { status: "pending_verification" },
    { query: { queryKey: ["sellers", "pending_verification"], staleTime: 30_000 } },
  );
  const { data: activeSellers } = useListSellers(
    { status: "active" },
    { query: { queryKey: ["sellers", "active"], staleTime: 30_000 } },
  );
  const { data: suspendedSellers } = useListSellers(
    { status: "suspended" },
    { query: { queryKey: ["sellers", "suspended"], staleTime: 30_000 } },
  );
  const { data: vacationSellers } = useListSellers(
    { status: "vacation" },
    { query: { queryKey: ["sellers", "vacation"], staleTime: 30_000 } },
  );
  const { data: unverifiedPaymentConfigs } = useListAdminSellerPaymentConfigs(
    { verified: false },
    { query: { queryKey: ["admin-seller-payment-configs", "unverified"], staleTime: 30_000 } },
  );
  const { data: unverifiedCourierConfigs } = useListAdminSellerCourierConfigs(
    { verified: false },
    { query: { queryKey: ["admin-seller-courier-configs", "unverified"], staleTime: 30_000 } },
  );
  const { data: pendingVerificationRequests } = useListSellerVerificationRequests(
    { status: "requested" },
    { query: { queryKey: ["seller-verification-requests", "requested"], staleTime: 30_000 } },
  );

  // ── Computed seller data ────────────────────────────────────────────────
  const allSellers = [
    ...(pendingSellers ?? []),
    ...(activeSellers ?? []),
    ...(suspendedSellers ?? []),
    ...(vacationSellers ?? []),
  ];
  const totalSellers = allSellers.length;
  const activeSellerCount = activeSellers?.length ?? 0;
  const pendingSellerCount = pendingSellers?.length ?? 0;
  const lowStockCount = products.filter(p => ((p as any).listingCount ?? 0) === 0).length;

  // ── Revenue trend data ──────────────────────────────────────────────────
  const revenueTrend = generateRevenueTrend(orders);

  // ── Top sellers ─────────────────────────────────────────────────────────
  const topSellers = (() => {
    const map = new Map<string, { businessName: string; status: string | null; orderCount: number; revenue: number }>();
    for (const o of orders as any[]) {
      const name = o.sellerBusinessName;
      if (!name) continue;
      const existing = map.get(name) ?? { businessName: name, status: o.sellerStatus ?? null, orderCount: 0, revenue: 0 };
      existing.orderCount += 1;
      if (o.orderStatus === "delivered") {
        existing.revenue += Number(o.totalAmount ?? 0);
      }
      map.set(name, existing);
    }
    return Array.from(map.values())
      .sort((a, b) => b.revenue - a.revenue || b.orderCount - a.orderCount)
      .slice(0, 5);
  })();

  // ── Category data ───────────────────────────────────────────────────────
  const categoryData = products.length > 0
    ? Object.entries(
        products.reduce<Record<string, number>>((acc, p) => {
          const cat = categories.find((c: any) => c.id === p.categoryId);
          const catName = cat?.name ?? "Uncategorized";
          acc[catName] = (acc[catName] || 0) + 1;
          return acc;
        }, {})
      ).map(([name, count]) => ({ name, count }))
    : [];

  // ── Loading skeleton ────────────────────────────────────────────────────
  if (dashStatsLoading) {
    return (
      <div className="space-y-6">
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
            <div className="h-36"><Skeleton className="h-full w-full rounded-xl" /></div>
          </div>
          <div className="bg-white rounded-2xl border p-5">
            <Skeleton className="h-5 w-40 mb-5" />
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-xl" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* ── KPI Row ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Revenue (This Month)"
          value={totalRevenue > 0 ? `Tk${(totalRevenue / 1000).toFixed(1)}k` : "Tk0"}
          change={totalRevenue > 0 ? "from delivered orders" : undefined}
          changeLabel={totalRevenue > 0 ? undefined : "No delivered orders yet"}
          icon={DollarSign}
          color="bg-emerald-50 text-emerald-600"
          trend={totalRevenue > 0 ? "up" : "neutral"}
        />
        <KpiCard
          label="Orders (This Month)"
          value={totalOrdersThisMonth > 0 ? totalOrdersThisMonth : 0}
          change={totalOrdersThisMonth > 0 ? `${pendingOrders} pending` : undefined}
          changeLabel={totalOrdersThisMonth > 0 ? undefined : "No orders yet"}
          icon={ShoppingCart}
          color="bg-blue-50 text-blue-600"
          trend={totalOrdersThisMonth > 0 ? "up" : "neutral"}
        />
        <KpiCard
          label="Active Sellers"
          value={activeSellerCount}
          change={totalSellers > 0 ? `of ${totalSellers} total` : undefined}
          changeLabel={totalSellers > 0 ? undefined : "No sellers yet"}
          icon={Sprout}
          color="bg-amber-50 text-amber-600"
          trend={activeSellerCount > 0 ? "up" : "neutral"}
        />
        <KpiCard
          label="Products"
          value={(productsData?.total ?? products.length) > 0 ? (productsData?.total ?? products.length) : 0}
          change={lowStockCount > 0 ? `${lowStockCount} low stock` : "All in stock"}
          icon={Package2}
          color="bg-violet-50 text-violet-600"
          trend={lowStockCount > 0 ? "down" : "up"}
        />
      </div>

      {/* ── Revenue Trend + Order Funnel ─────────────────────────────────── */}
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
                    <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f472b6" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#f472b6" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} interval={4} />
                  <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `Tk${v}`} />
                  <Tooltip content={<ChartTooltip />} />
                  <Area type="monotone" dataKey="revenue" stroke="#f472b6" strokeWidth={2} fill="url(#revenueGrad)" name="revenue" />
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
              <p className="text-xs text-gray-400 mt-0.5">{orders.length} total orders</p>
            </div>
            <button onClick={() => setActiveTab("orders")} className="text-xs text-pink-500 hover:underline flex items-center gap-1">
              View all <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          <OrderFunnel orders={orders} />
        </div>
      </div>

      {/* ── Pending Actions ──────────────────────────────────────────────── */}
      {(pendingSellerCount > 0 || (unverifiedPaymentConfigs?.length ?? 0) > 0 || (unverifiedCourierConfigs?.length ?? 0) > 0 || (pendingVerificationRequests?.length ?? 0) > 0) && (
        <div>
          <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Action Required
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <PendingActionCard
              icon={BadgeCheck}
              label="Seller Approvals"
              count={pendingSellerCount}
              color="bg-amber-50 text-amber-600"
              onClick={() => setActiveTab("sellers")}
            />
            <PendingActionCard
              icon={ShieldCheck}
              label="Verified Badge Requests"
              count={pendingVerificationRequests?.length ?? 0}
              color="bg-violet-50 text-violet-600"
              onClick={() => setActiveTab("sellers")}
            />
            <PendingActionCard
              icon={Wallet}
              label="Payment Configs"
              count={unverifiedPaymentConfigs?.length ?? 0}
              color="bg-emerald-50 text-emerald-600"
              onClick={() => setActiveTab("sellers")}
            />
            <PendingActionCard
              icon={Truck}
              label="Courier Configs"
              count={unverifiedCourierConfigs?.length ?? 0}
              color="bg-blue-50 text-blue-600"
              onClick={() => setActiveTab("sellers")}
            />
          </div>
        </div>
      )}

      {/* ── Seller Status + Top Sellers ──────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Seller status donut */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-gray-800 text-sm">Seller Status</h3>
              <p className="text-xs text-gray-400 mt-0.5">{totalSellers} registered sellers</p>
            </div>
            <button onClick={() => setActiveTab("sellers")} className="text-xs text-pink-500 hover:underline flex items-center gap-1">
              Manage <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          <SellerStatusDonut sellers={allSellers} />
        </div>

        {/* Top sellers */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-gray-800 text-sm flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-pink-500" />
                Top Sellers
              </h3>
              <p className="text-xs text-gray-400 mt-0.5">By delivered revenue, from current orders</p>
            </div>
            <button onClick={() => setActiveTab("sellers")} className="text-xs text-pink-500 hover:underline flex items-center gap-1">
              Manage <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          {topSellers.length > 0 ? (
            <div className="space-y-2">
              {topSellers.map((s, idx) => (
                <div key={s.businessName} className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-pink-50/30 transition-colors">
                  <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 text-xs font-bold ${
                    idx === 0 ? "bg-amber-100 text-amber-700" : idx === 1 ? "bg-gray-100 text-gray-600" : idx === 2 ? "bg-orange-100 text-orange-700" : "bg-gray-50 text-gray-400"
                  }`}>
                    {idx + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-800 truncate">{s.businessName}</p>
                      {s.status && s.status !== "active" && (
                        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${SELLER_STATUS_STYLE[s.status] ?? "bg-gray-50 text-gray-600 border-gray-200"}`}>
                          {SELLER_STATUS_LABEL[s.status] ?? s.status}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400">{s.orderCount} order{s.orderCount === 1 ? "" : "s"}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-gray-800">Tk{s.revenue.toLocaleString()}</p>
                    <p className="text-[10px] text-gray-400 uppercase tracking-wider">delivered</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-gray-300">
              <Store className="h-8 w-8 mb-2" />
              <p className="text-sm">No seller data yet</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Recent Orders + Category Breakdown ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Recent orders */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-50">
            <div>
              <h3 className="font-semibold text-gray-800 text-sm">Recent Orders</h3>
              <p className="text-xs text-gray-400 mt-0.5">Latest activity across all sellers</p>
            </div>
            <button onClick={() => setActiveTab("orders")} className="text-xs text-pink-500 hover:underline flex items-center gap-1">
              View all <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          {recentCombined.length > 0 ? (
            <div className="divide-y divide-gray-50">
              {recentCombined.map((o) => {
                const cfg = statusConfig[o.orderStatus] ?? { color: "bg-gray-100 text-gray-600", icon: AlertCircle };
                const StatusIcon = cfg.icon;
                const sellerName = (o as any).sellerBusinessName ?? null;
                const sellerStatus = (o as any).sellerStatus ?? null;
                return (
                  <div key={o.id} className="flex items-center gap-4 px-5 py-3 hover:bg-gray-50/50 transition-colors">
                    <div className="h-9 w-9 rounded-lg bg-gray-50 border border-gray-100 flex items-center justify-center shrink-0">
                      <span className="text-xs font-bold text-gray-500">#{o.id}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">Order #{o.id}</p>
                      <div className="flex items-center gap-2 text-xs text-gray-400">
                        <span>{new Date(o.createdAt).toLocaleDateString()}</span>
                        {sellerName && (
                          <>
                            <span className="text-gray-200">·</span>
                            <span className="inline-flex items-center gap-1 truncate">
                              <Store className="h-3 w-3 shrink-0" />
                              <span className="truncate">{sellerName}</span>
                            </span>
                            {sellerStatus && sellerStatus !== "active" && (
                              <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${SELLER_STATUS_STYLE[sellerStatus] ?? "bg-gray-50 text-gray-600 border-gray-200"}`}>
                                {SELLER_STATUS_LABEL[sellerStatus] ?? sellerStatus}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    <span className={`flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${cfg.color}`}>
                      <StatusIcon className="h-3 w-3" />{o.orderStatus}
                    </span>
                    <span className="text-sm font-semibold text-gray-800 shrink-0">Tk{o.totalAmount.toLocaleString()}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-12 text-center">
              <ShoppingCart className="h-10 w-10 text-gray-200 mx-auto mb-3" />
              <p className="font-semibold text-gray-400 mb-1">No orders yet</p>
              <p className="text-sm text-gray-300">Orders will appear here once customers start purchasing.</p>
            </div>
          )}
        </div>

        {/* Category breakdown */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-gray-800 text-sm">Products by Category</h3>
              <p className="text-xs text-gray-400 mt-0.5">{products.length} total products</p>
            </div>
            <button onClick={() => setActiveTab("products")} className="text-xs text-pink-500 hover:underline flex items-center gap-1">
              Manage <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          {categoryData.length > 0 ? (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={categoryData} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: "#6b7280" }} tickLine={false} axisLine={false} width={80} />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar dataKey="count" name="count" fill="#f472b6" radius={[0, 6, 6, 0]} barSize={20} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-gray-300">
              <Package2 className="h-8 w-8 mb-2" />
              <p className="text-sm">No products yet</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Quick Stats Footer ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Customers", value: users?.length ?? 0, icon: Users, color: "bg-pink-50 text-pink-600", tab: "users" },
          { label: "Delivered", value: deliveredOrders, icon: CheckCircle2, color: "bg-emerald-50 text-emerald-600", tab: "orders" },
          { label: "Pending Orders", value: pendingOrders, icon: Clock, color: "bg-amber-50 text-amber-600", tab: "orders" },
          { label: "Active Orders", value: activeOrdersCount, icon: Activity, color: "bg-blue-50 text-blue-600", tab: "orders" },
        ].map(({ label, value, icon: Icon, color, tab }) => (
          <button
            key={label}
            onClick={() => setActiveTab(tab)}
            className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-3 hover:shadow-md transition-all duration-200 group"
          >
            <div className={`h-8 w-8 rounded-lg ${color} flex items-center justify-center shrink-0`}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="text-left min-w-0">
              <p className="text-lg font-bold text-gray-800">{value}</p>
              <p className="text-[11px] text-gray-400 uppercase tracking-wider">{label}</p>
            </div>
            <ChevronRight className="h-4 w-4 text-gray-200 ml-auto group-hover:text-gray-400 transition-colors" />
          </button>
        ))}
      </div>
    </div>
  );
}
