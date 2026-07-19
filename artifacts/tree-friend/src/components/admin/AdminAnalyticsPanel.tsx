// artifacts/tree-friend/src/components/admin/AdminAnalyticsPanel.tsx
// Drop this into AdminPage.tsx replacing the existing analytics section.
// Fetches /admin/analytics/products and renders charts + key metrics.
// Uses recharts (already in your dependencies).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { apiClient } from "@/lib/apiClient";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Users, ShoppingBag, Star, DollarSign } from "lucide-react";

interface MonthlyRevenue {
  month: string;
  revenue: number;
  orders: number;
  uniqueCustomers: number;
}

interface TopProduct {
  id: number;
  name: string;
  category: string;
  image: string | null;
  revenue: number;
  unitsSold: number;
  orderCount: number;
}

interface CustomerSegment {
  segment: "New" | "Returning" | "VIP";
  count: number;
  avgSpent: number;
}

interface AnalyticsData {
  topProductsByRevenue: TopProduct[];
  topProductsByReviews: { id: number; name: string; avgRating: number; reviewCount: number }[];
  customerSegments: CustomerSegment[];
  monthlyRevenue: MonthlyRevenue[];
}

const SEGMENT_COLORS = {
  New: "#a78bfa",
  Returning: "#60a5fa",
  VIP: "#f59e0b",
};

async function fetchAnalytics(): Promise<AnalyticsData> {
  const { data } = await apiClient.get<AnalyticsData>("/api/admin/analytics/products");
  return data;
}

function formatBDT(n: number) {
  if (n >= 100000) return `Tk${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `Tk${(n / 1000).toFixed(1)}K`;
  return `Tk${Math.round(n)}`;
}

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  trend,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  trend?: "up" | "down";
}) {
  return (
    <div className="border rounded-2xl p-5 bg-card space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground font-medium">{label}</p>
        <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
      <div>
        <p className="text-2xl font-bold">{value}</p>
        {sub && (
          <p className={`text-xs mt-0.5 flex items-center gap-1 ${trend === "up" ? "text-green-600" : trend === "down" ? "text-red-500" : "text-muted-foreground"}`}>
            {trend === "up" && <TrendingUp className="h-3 w-3" />}
            {trend === "down" && <TrendingDown className="h-3 w-3" />}
            {sub}
          </p>
        )}
      </div>
    </div>
  );
}

export function AdminAnalyticsPanel() {
  const [revenueView, setRevenueView] = useState<"revenue" | "orders" | "customers">("revenue");

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-analytics"],
    queryFn: fetchAnalytics,
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
        </div>
        <Skeleton className="h-72 rounded-2xl" />
        <div className="grid md:grid-cols-2 gap-6">
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return <p className="text-muted-foreground py-8 text-center">Failed to load analytics.</p>;
  }

  const monthly = data.monthlyRevenue;
  const totalRevenue = monthly.reduce((s, m) => s + m.revenue, 0);
  const totalOrders = monthly.reduce((s, m) => s + m.orders, 0);
  const totalCustomers = data.customerSegments.reduce((s, c) => s + c.count, 0);
  const vipCount = data.customerSegments.find((c) => c.segment === "VIP")?.count ?? 0;

  // Month-over-month growth
  const lastTwo = monthly.slice(-2);
  const momGrowth =
    lastTwo.length === 2 && lastTwo[0].revenue > 0
      ? (((lastTwo[1].revenue - lastTwo[0].revenue) / lastTwo[0].revenue) * 100).toFixed(1)
      : null;

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Revenue (12mo)"
          value={formatBDT(totalRevenue)}
          sub={momGrowth ? `${momGrowth}% vs last month` : undefined}
          icon={DollarSign}
          trend={momGrowth ? (Number(momGrowth) >= 0 ? "up" : "down") : undefined}
        />
        <StatCard
          label="Total Orders"
          value={totalOrders.toLocaleString()}
          icon={ShoppingBag}
        />
        <StatCard
          label="Total Customers"
          value={totalCustomers.toLocaleString()}
          sub={`${vipCount} VIP`}
          icon={Users}
        />
        <StatCard
          label="Top Product"
          value={data.topProductsByRevenue[0]?.name?.split(" ").slice(0, 2).join(" ") ?? "-"}
          sub={data.topProductsByRevenue[0] ? formatBDT(data.topProductsByRevenue[0].revenue) : undefined}
          icon={Star}
        />
      </div>

      {/* Revenue chart */}
      <div className="border rounded-2xl p-6 bg-card">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-semibold">Monthly Performance</h3>
          <div className="flex gap-1">
            {(["revenue", "orders", "customers"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setRevenueView(v)}
                className={`text-xs px-3 py-1.5 rounded-full transition-colors capitalize ${
                  revenueView === v
                    ? "bg-accent text-white"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                {v === "customers" ? "Customers" : v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={monthly} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 11 }}
              tickFormatter={(v) => {
                const [y, m] = v.split("-");
                return new Date(Number(y), Number(m) - 1).toLocaleString("en", { month: "short" });
              }}
            />
            <YAxis
              tick={{ fontSize: 11 }}
              tickFormatter={(v) =>
                revenueView === "revenue" ? formatBDT(v) : v.toLocaleString()
              }
              width={50}
            />
            <Tooltip
              formatter={(val: number) =>
                revenueView === "revenue" ? [`Tk${val.toLocaleString()}`, "Revenue"] : [val.toLocaleString(), revenueView === "orders" ? "Orders" : "Customers"]
              }
              labelFormatter={(label) => {
                const [y, m] = label.split("-");
                return new Date(Number(y), Number(m) - 1).toLocaleString("en", { month: "long", year: "numeric" });
              }}
            />
            <Line
              type="monotone"
              dataKey={revenueView === "customers" ? "uniqueCustomers" : revenueView}
              stroke="hsl(var(--accent))"
              strokeWidth={2.5}
              dot={{ r: 3, fill: "hsl(var(--accent))" }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Top products by revenue */}
        <div className="border rounded-2xl p-6 bg-card">
          <h3 className="font-semibold mb-4">Top Products by Revenue</h3>
          <div className="space-y-3">
            {data.topProductsByRevenue.slice(0, 5).map((p, i) => (
              <div key={p.id} className="flex items-center gap-3">
                <span className="text-xs font-bold text-muted-foreground w-4 shrink-0">{i + 1}</span>
                {p.image && (
                  <img src={p.image} alt={p.name} className="h-9 w-9 object-cover rounded-lg bg-muted shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{p.name}</p>
                  <p className="text-xs text-muted-foreground">{p.unitsSold} units sold</p>
                </div>
                <p className="text-sm font-semibold shrink-0">{formatBDT(p.revenue)}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Customer segments */}
        <div className="border rounded-2xl p-6 bg-card">
          <h3 className="font-semibold mb-4">Customer Segments</h3>
          <div className="flex items-center gap-6">
            <ResponsiveContainer width={130} height={130}>
              <PieChart>
                <Pie
                  data={data.customerSegments}
                  dataKey="count"
                  nameKey="segment"
                  cx="50%"
                  cy="50%"
                  innerRadius={35}
                  outerRadius={55}
                  paddingAngle={3}
                >
                  {data.customerSegments.map((entry) => (
                    <Cell
                      key={entry.segment}
                      fill={SEGMENT_COLORS[entry.segment] ?? "#94a3b8"}
                    />
                  ))}
                </Pie>
                <Tooltip formatter={(val: number, name: string) => [val, name]} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex-1 space-y-3">
              {data.customerSegments.map((seg) => (
                <div key={seg.segment} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className="h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: SEGMENT_COLORS[seg.segment] ?? "#94a3b8" }}
                    />
                    <span className="text-sm">{seg.segment}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-sm font-semibold">{seg.count}</span>
                    <p className="text-xs text-muted-foreground">avg {formatBDT(seg.avgSpent)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Date range hint */}
          <p className="text-xs text-muted-foreground mt-4 border-t pt-3">
            Based on last 12 months of completed orders.
            {" "}<span className="text-accent cursor-pointer hover:underline" onClick={() => {}}>Export CSV →</span>
          </p>
        </div>
      </div>

      {/* Bar chart: top 10 products */}
      <div className="border rounded-2xl p-6 bg-card">
        <h3 className="font-semibold mb-4">Revenue by Product (Top 10)</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={data.topProductsByRevenue.slice(0, 10)}
            margin={{ left: 0, right: 0, top: 0, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 10 }}
              tickFormatter={(v) => v.split(" ").slice(0, 2).join(" ")}
              interval={0}
              angle={-20}
              textAnchor="end"
              height={40}
            />
            <YAxis
              tick={{ fontSize: 11 }}
              tickFormatter={formatBDT}
              width={50}
            />
            <Tooltip
              formatter={(val: number) => [`Tk${val.toLocaleString()}`, "Revenue"]}
            />
            <Bar dataKey="revenue" fill="hsl(var(--accent))" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
