import { useAdminContext } from "@/contexts/AdminContext";
import { Skeleton } from "@/components/ui/skeleton";
import { useChartColors } from "@/hooks/useChartColors";
import { pickCategorical } from "@/lib/chartColors";
import {
  DollarSign,
  ShoppingCart,
  Package2,
  Users,
  ChevronRight,
  AlertCircle,
  Store,
  TrendingUp,
  ArrowUpRight,
  ArrowDownRight,
  Clock,
  CheckCircle2,
  Truck,
  XCircle,
  ShieldCheck,
  BadgeCheck,
  Activity,
  BarChart3,
  Sprout,
  AlertTriangle,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from "recharts";
import {
  useListSellers,
  useListAdminSellerCourierConfigs,
  useListSellerVerificationRequests,
} from "@workspace/api-client-react";

// ── Status helpers ──────────────────────────────────────────────────────────
const SELLER_STATUS_STYLE: Record<string, string> = {
  active: "bg-success text-success-foreground border-success-border",
  pending_verification: "bg-warning text-warning-foreground border-warning-border",
  suspended: "bg-destructive/10 text-destructive border-destructive/20",
  vacation: "bg-info text-info-foreground border-info-border",
};
const SELLER_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  pending_verification: "Pending",
  suspended: "Suspended",
  vacation: "On vacation",
};

// Categorical chart colors are now resolved at runtime via useChartColors()
// so the palette swaps correctly between light and dark themes. Previously
// this was a hardcoded hex array (#10b981, #f59e0b, ...) that looked fine on
// white backgrounds but disappeared into dark backgrounds.

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
  label,
  value,
  change,
  changeLabel,
  icon: Icon,
  color,
  trend,
}: {
  label: string;
  value: string | number;
  change?: string;
  changeLabel?: string;
  icon: React.ElementType;
  color: string;
  trend?: "up" | "down" | "neutral";
}) {
  return (
    <div className="bg-card rounded-2xl border border-border p-5 flex flex-col gap-3 hover:shadow-md transition-shadow duration-200">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
          {label}
        </span>
        <div className={`h-9 w-9 rounded-xl ${color} flex items-center justify-center`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="text-2xl font-bold text-foreground tracking-tight">{value}</p>
      <div className="flex items-center gap-1.5">
        {trend === "up" && <ArrowUpRight className="h-3.5 w-3.5 text-success-foreground" />}
        {trend === "down" && <ArrowDownRight className="h-3.5 w-3.5 text-destructive" />}
        {trend === "neutral" && <span className="h-3.5 w-3.5 rounded-full bg-muted" />}
        {change && (
          <span
            className={`text-xs font-medium ${trend === "up" ? "text-success-foreground" : trend === "down" ? "text-destructive" : "text-muted-foreground"}`}
          >
            {change}
          </span>
        )}
        {changeLabel && <span className="text-[11px] text-muted-foreground/70">{changeLabel}</span>}
      </div>
    </div>
  );
}

// ── Custom tooltip for charts ───────────────────────────────────────────────
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card rounded-xl border shadow-lg px-4 py-3 text-xs">
      <p className="font-semibold text-foreground mb-1">{label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-semibold text-foreground">
            {p.name === "revenue" ? `Tk${p.value.toLocaleString()}` : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Seller status donut ─────────────────────────────────────────────────────
function SellerStatusDonut({ sellers }: { sellers: any[] }) {
  const chart = useChartColors();
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
      <div className="flex items-center justify-center h-48 text-muted-foreground/30">
        <Sprout className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-6">
      <div className="h-36 w-36 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={40}
              outerRadius={65}
              paddingAngle={3}
              dataKey="value"
              stroke="none"
            >
              {data.map((_, i) => (
                <Cell key={i} fill={pickCategorical(chart, i)} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="space-y-2 flex-1 min-w-0">
        {data.map((d, i) => (
          <div key={d.status} className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 rounded-full shrink-0"
              style={{ backgroundColor: pickCategorical(chart, i) }}
            />
            <span className="text-xs text-muted-foreground truncate flex-1">{d.name}</span>
            <span className="text-xs font-semibold text-foreground">{d.value}</span>
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
    pending: Clock,
    confirmed: CheckCircle2,
    processing: BarChart3,
    shipped: Truck,
    delivered: CheckCircle2,
    cancelled: XCircle,
  };
  const statusColors: Record<string, string> = {
    pending: "bg-warning-foreground",
    confirmed: "bg-info-foreground",
    processing: "bg-info-foreground",
    shipped: "bg-info-foreground",
    delivered: "bg-success-foreground",
    cancelled: "bg-destructive",
  };
  const statusTextColors: Record<string, string> = {
    pending: "text-warning-foreground",
    confirmed: "text-info-foreground",
    processing: "text-info-foreground",
    shipped: "text-info-foreground",
    delivered: "text-success-foreground",
    cancelled: "text-destructive",
  };

  const counts = statusOrder.map((s) => ({
    status: s,
    count: orders.filter((o) => o.orderStatus === s).length,
  }));
  const maxCount = Math.max(...counts.map((c) => c.count), 1);

  return (
    <div className="space-y-3">
      {counts
        .filter((c) => c.count > 0)
        .map((c) => {
          const Icon = statusIcons[c.status] ?? AlertCircle;
          const pct = Math.max((c.count / maxCount) * 100, 4);
          return (
            <div key={c.status} className="flex items-center gap-3">
              <div
                className={`h-7 w-7 rounded-lg ${statusColors[c.status]} flex items-center justify-center shrink-0`}
              >
                <Icon className="h-3.5 w-3.5 text-card-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <span className={`text-xs font-medium capitalize ${statusTextColors[c.status]}`}>
                    {c.status.replace("_", " ")}
                  </span>
                  <span className="text-xs font-bold text-foreground">{c.count}</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${statusColors[c.status]} transition-all duration-500`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      {counts.every((c) => c.count === 0) && (
        <div className="text-center py-8 text-muted-foreground/30">
          <BarChart3 className="h-8 w-8 mx-auto mb-2" />
          <p className="text-sm">No orders yet</p>
        </div>
      )}
    </div>
  );
}

// ── Pending action card ─────────────────────────────────────────────────────
function PendingActionCard({
  icon: Icon,
  label,
  count,
  color,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  count: number;
  color: string;
  onClick: () => void;
}) {
  if (count === 0) return null;
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 bg-card rounded-xl border border-border p-4 hover:shadow-md transition-all duration-200 w-full text-left group"
    >
      <div className={`h-10 w-10 rounded-xl ${color} flex items-center justify-center shrink-0`}>
        <Icon className="h-4.5 w-4.5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{label}</p>
        <p className="text-xs text-muted-foreground/70">Needs your attention</p>
      </div>
      <div className="flex items-center gap-2">
        <span className="h-6 min-w-[24px] px-1.5 rounded-full bg-warning text-warning-foreground text-xs font-bold flex items-center justify-center">
          {count}
        </span>
        <ChevronRight className="h-4 w-4 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
      </div>
    </button>
  );
}

// ── Main DashboardTab ───────────────────────────────────────────────────────
export function DashboardTab() {
  const chart = useChartColors();
  const {
    dashStats: _dashStats,
    dashStatsLoading,
    activeOrdersCount,
    orders,
    ordersLoading: _ordersLoading,
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
  const lowStockCount = products.filter((p) => (p.listingCount ?? 0) === 0).length;

  // ── Revenue trend data ──────────────────────────────────────────────────
  const revenueTrend = generateRevenueTrend(orders);

  // ── Top sellers ─────────────────────────────────────────────────────────
  const topSellers = (() => {
    const map = new Map<
      string,
      { businessName: string; status: string | null; orderCount: number; revenue: number }
    >();
    for (const o of orders) {
      const name = o.sellerBusinessName;
      if (!name) continue;
      const existing = map.get(name) ?? {
        businessName: name,
        status: o.sellerStatus ?? null,
        orderCount: 0,
        revenue: 0,
      };
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
  const categoryData =
    products.length > 0
      ? Object.entries(
          products.reduce<Record<string, number>>((acc, p) => {
            const cat = categories.find((c: any) => c.id === p.categoryId);
            const catName = cat?.name ?? "Uncategorized";
            acc[catName] = (acc[catName] || 0) + 1;
            return acc;
          }, {}),
        ).map(([name, count]) => ({ name, count }))
      : [];

  // ── Loading skeleton ────────────────────────────────────────────────────
  if (dashStatsLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-card rounded-2xl border p-5 flex flex-col gap-3">
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
          <div className="lg:col-span-2 bg-card rounded-2xl border p-5">
            <Skeleton className="h-5 w-40 mb-5" />
            <div className="h-48">
              <Skeleton className="h-full w-full rounded-xl" />
            </div>
          </div>
          <div className="bg-card rounded-2xl border p-5">
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
          <div className="bg-card rounded-2xl border p-5">
            <Skeleton className="h-5 w-40 mb-5" />
            <div className="h-36">
              <Skeleton className="h-full w-full rounded-xl" />
            </div>
          </div>
          <div className="bg-card rounded-2xl border p-5">
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
          color="bg-success text-success-foreground"
          trend={totalRevenue > 0 ? "up" : "neutral"}
        />
        <KpiCard
          label="Orders (This Month)"
          value={totalOrdersThisMonth > 0 ? totalOrdersThisMonth : 0}
          change={totalOrdersThisMonth > 0 ? `${pendingOrders} pending` : undefined}
          changeLabel={totalOrdersThisMonth > 0 ? undefined : "No orders yet"}
          icon={ShoppingCart}
          color="bg-info text-info-foreground"
          trend={totalOrdersThisMonth > 0 ? "up" : "neutral"}
        />
        <KpiCard
          label="Active Sellers"
          value={activeSellerCount}
          change={totalSellers > 0 ? `of ${totalSellers} total` : undefined}
          changeLabel={totalSellers > 0 ? undefined : "No sellers yet"}
          icon={Sprout}
          color="bg-warning text-warning-foreground"
          trend={activeSellerCount > 0 ? "up" : "neutral"}
        />
        <KpiCard
          label="Products"
          value={
            (productsData?.total ?? products.length) > 0
              ? (productsData?.total ?? products.length)
              : 0
          }
          change={lowStockCount > 0 ? `${lowStockCount} low stock` : "All in stock"}
          icon={Package2}
          color="bg-info text-info-foreground"
          trend={lowStockCount > 0 ? "down" : "up"}
        />
      </div>

      {/* ── Revenue Trend + Order Funnel ─────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Revenue trend chart */}
        <div className="lg:col-span-2 bg-card rounded-2xl border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-foreground text-sm">Revenue Overview</h3>
              <p className="text-xs text-muted-foreground/70 mt-0.5">
                Last 30 days, delivered orders only
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 rounded-full bg-primary" />
              <span className="text-[11px] text-muted-foreground/70">Revenue</span>
            </div>
          </div>
          <div className="h-52">
            {revenueTrend.some((d) => d.revenue > 0) ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={revenueTrend} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={chart.primary} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={chart.primary} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={chart.gridStroke} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: chart.axisTick }}
                    tickLine={false}
                    axisLine={false}
                    interval={4}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: chart.axisTick }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => `Tk${v}`}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    stroke={chart.primary}
                    strokeWidth={2}
                    fill="url(#revenueGrad)"
                    name="revenue"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground/30">
                <TrendingUp className="h-8 w-8 mb-2" />
                <p className="text-sm">Revenue data will appear here</p>
              </div>
            )}
          </div>
        </div>

        {/* Order funnel */}
        <div className="bg-card rounded-2xl border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-foreground text-sm">Order Pipeline</h3>
              <p className="text-xs text-muted-foreground/70 mt-0.5">
                {orders.length} total orders
              </p>
            </div>
            <button
              onClick={() => setActiveTab("orders")}
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              View all <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          <OrderFunnel orders={orders} />
        </div>
      </div>

      {/* ── Pending Actions ──────────────────────────────────────────────── */}
      {(pendingSellerCount > 0 ||
        (unverifiedCourierConfigs?.length ?? 0) > 0 ||
        (pendingVerificationRequests?.length ?? 0) > 0) && (
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning-foreground" />
            Action Required
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <PendingActionCard
              icon={BadgeCheck}
              label="Seller Approvals"
              count={pendingSellerCount}
              color="bg-warning text-warning-foreground"
              onClick={() => setActiveTab("sellers")}
            />
            <PendingActionCard
              icon={ShieldCheck}
              label="Verified Badge Requests"
              count={pendingVerificationRequests?.length ?? 0}
              color="bg-info text-info-foreground"
              onClick={() => setActiveTab("sellers")}
            />
            <PendingActionCard
              icon={Truck}
              label="Courier Configs"
              count={unverifiedCourierConfigs?.length ?? 0}
              color="bg-info text-info-foreground"
              onClick={() => setActiveTab("sellers")}
            />
          </div>
        </div>
      )}

      {/* ── Seller Status + Top Sellers ──────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Seller status donut */}
        <div className="bg-card rounded-2xl border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-foreground text-sm">Seller Status</h3>
              <p className="text-xs text-muted-foreground/70 mt-0.5">
                {totalSellers} registered sellers
              </p>
            </div>
            <button
              onClick={() => setActiveTab("sellers")}
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              Manage <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          <SellerStatusDonut sellers={allSellers} />
        </div>

        {/* Top sellers */}
        <div className="bg-card rounded-2xl border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-foreground text-sm flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" />
                Top Sellers
              </h3>
              <p className="text-xs text-muted-foreground/70 mt-0.5">
                By delivered revenue, from current orders
              </p>
            </div>
            <button
              onClick={() => setActiveTab("sellers")}
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              Manage <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          {topSellers.length > 0 ? (
            <div className="space-y-2">
              {topSellers.map((s, idx) => (
                <div
                  key={s.businessName}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-primary/5 transition-colors"
                >
                  <div
                    className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 text-xs font-bold ${
                      idx === 0
                        ? "bg-warning text-warning-foreground"
                        : idx === 1
                          ? "bg-muted text-muted-foreground"
                          : idx === 2
                            ? "bg-warning/70 text-warning-foreground"
                            : "bg-muted/50 text-muted-foreground/70"
                    }`}
                  >
                    {idx + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-foreground truncate">
                        {s.businessName}
                      </p>
                      {s.status && s.status !== "active" && (
                        <span
                          className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${SELLER_STATUS_STYLE[s.status] ?? "bg-muted text-muted-foreground border-border"}`}
                        >
                          {SELLER_STATUS_LABEL[s.status] ?? s.status}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground/70">
                      {s.orderCount} order{s.orderCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-foreground">
                      Tk{s.revenue.toLocaleString()}
                    </p>
                    <p className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                      delivered
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground/30">
              <Store className="h-8 w-8 mb-2" />
              <p className="text-sm">No seller data yet</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Recent Orders + Category Breakdown ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Recent orders */}
        <div className="lg:col-span-2 bg-card rounded-2xl border border-border overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-muted/50">
            <div>
              <h3 className="font-semibold text-foreground text-sm">Recent Orders</h3>
              <p className="text-xs text-muted-foreground/70 mt-0.5">
                Latest activity across all sellers
              </p>
            </div>
            <button
              onClick={() => setActiveTab("orders")}
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              View all <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          {recentCombined.length > 0 ? (
            <div className="divide-y divide-muted/50">
              {recentCombined.map((o) => {
                const cfg = statusConfig[o.orderStatus] ?? {
                  color: "bg-muted text-muted-foreground",
                  icon: AlertCircle,
                };
                const StatusIcon = cfg.icon;
                const sellerName = o.sellerBusinessName ?? null;
                const sellerStatus = o.sellerStatus ?? null;
                return (
                  <div
                    key={o.id}
                    className="flex items-center gap-4 px-5 py-3 hover:bg-muted/40 transition-colors"
                  >
                    <div className="h-9 w-9 rounded-lg bg-muted/50 border border-border flex items-center justify-center shrink-0">
                      <span className="text-xs font-bold text-muted-foreground">#{o.id}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">Order #{o.id}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
                        <span>{new Date(o.createdAt).toLocaleDateString()}</span>
                        {sellerName && (
                          <>
                            <span className="text-muted-foreground/40">·</span>
                            <span className="inline-flex items-center gap-1 truncate">
                              <Store className="h-3 w-3 shrink-0" />
                              <span className="truncate">{sellerName}</span>
                            </span>
                            {sellerStatus && sellerStatus !== "active" && (
                              <span
                                className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${SELLER_STATUS_STYLE[sellerStatus] ?? "bg-muted text-muted-foreground border-border"}`}
                              >
                                {SELLER_STATUS_LABEL[sellerStatus] ?? sellerStatus}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    <span
                      className={`flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${cfg.color}`}
                    >
                      <StatusIcon className="h-3 w-3" />
                      {o.orderStatus}
                    </span>
                    <span className="text-sm font-semibold text-foreground shrink-0">
                      Tk{o.totalAmount.toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-12 text-center">
              <ShoppingCart className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
              <p className="font-semibold text-muted-foreground mb-1">No orders yet</p>
              <p className="text-sm text-muted-foreground/70">
                Orders will appear here once customers start purchasing.
              </p>
            </div>
          )}
        </div>

        {/* Category breakdown */}
        <div className="bg-card rounded-2xl border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-foreground text-sm">Products by Category</h3>
              <p className="text-xs text-muted-foreground/70 mt-0.5">
                {products.length} total products
              </p>
            </div>
            <button
              onClick={() => setActiveTab("products")}
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              Manage <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          {categoryData.length > 0 ? (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={categoryData}
                  layout="vertical"
                  margin={{ top: 0, right: 10, left: 0, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke={chart.gridStroke}
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 10, fill: chart.axisTick }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 11, fill: chart.axisTick }}
                    tickLine={false}
                    axisLine={false}
                    width={80}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar
                    dataKey="count"
                    name="count"
                    fill={chart.primary}
                    radius={[0, 6, 6, 0]}
                    barSize={20}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground/30">
              <Package2 className="h-8 w-8 mb-2" />
              <p className="text-sm">No products yet</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Quick Stats Footer ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          {
            label: "Customers",
            value: users?.length ?? 0,
            icon: Users,
            color: "bg-primary/10 text-primary",
            tab: "users",
          },
          {
            label: "Delivered",
            value: deliveredOrders,
            icon: CheckCircle2,
            color: "bg-success text-success-foreground",
            tab: "orders",
          },
          {
            label: "Pending Orders",
            value: pendingOrders,
            icon: Clock,
            color: "bg-warning text-warning-foreground",
            tab: "orders",
          },
          {
            label: "Active Orders",
            value: activeOrdersCount,
            icon: Activity,
            color: "bg-info text-info-foreground",
            tab: "orders",
          },
        ].map(({ label, value, icon: Icon, color, tab }) => (
          <button
            key={label}
            onClick={() => setActiveTab(tab)}
            className="bg-card rounded-xl border border-border p-4 flex items-center gap-3 hover:shadow-md transition-all duration-200 group"
          >
            <div
              className={`h-8 w-8 rounded-lg ${color} flex items-center justify-center shrink-0`}
            >
              <Icon className="h-4 w-4" />
            </div>
            <div className="text-left min-w-0">
              <p className="text-lg font-bold text-foreground">{value}</p>
              <p className="text-[11px] text-muted-foreground/70 uppercase tracking-wider">
                {label}
              </p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground/30 ml-auto group-hover:text-muted-foreground transition-colors" />
          </button>
        ))}
      </div>
    </div>
  );
}
