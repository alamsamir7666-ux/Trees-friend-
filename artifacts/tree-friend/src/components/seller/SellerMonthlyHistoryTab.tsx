import { useMemo } from "react";
import { Calendar, TrendingUp, ShoppingCart, DollarSign, Download } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
} from "recharts";
import { useGetSellerMonthlyHistory } from "@workspace/api-client-react";

const monthNames = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const monthAbbr = [
  "", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const CHART_PRIMARY = "hsl(150 30% 40%)";
const CHART_ACCENT = "hsl(32 55% 45%)";

function formatTk(n: number): string {
  return `Tk${Math.round(Number(n) || 0).toLocaleString()}`;
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-border bg-popover px-3.5 py-2.5 shadow-md">
      <p className="text-[11px] font-medium text-muted-foreground mb-1.5">{label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-muted-foreground capitalize">{p.name}:</span>
          <span className="font-semibold text-foreground">
            {p.name === "revenue" ? formatTk(p.value) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SellerMonthlyHistoryTab() {
  const { data, isLoading } = useGetSellerMonthlyHistory({});
  const records = data?.records ?? [];

  // Sorted oldest → newest for charts
  const sortedRecords = useMemo(
    () => [...records].sort((a: any, b: any) => a.year - b.year || a.month - b.month),
    [records],
  );

  const chartData = useMemo(
    () =>
      sortedRecords.map((r: any) => ({
        label: `${monthAbbr[r.month]} ${String(r.year).slice(-2)}`,
        revenue: Number(r.totalRevenue) || 0,
        orders: Number(r.totalOrders) || 0,
      })),
    [sortedRecords],
  );

  // Summary stats
  const summary = useMemo(() => {
    if (sortedRecords.length === 0) {
      return { totalRevenue: 0, totalOrders: 0, avgRevenuePerMonth: 0, bestMonth: null };
    }
    const totalRevenue = sortedRecords.reduce(
      (sum: number, r: any) => sum + (Number(r.totalRevenue) || 0),
      0,
    );
    const totalOrders = sortedRecords.reduce(
      (sum: number, r: any) => sum + (Number(r.totalOrders) || 0),
      0,
    );
    const bestMonth: any = sortedRecords.reduce(
      (best: any, r: any) =>
        (Number(r.totalRevenue) || 0) > (Number(best?.totalRevenue) || 0) ? r : best,
      sortedRecords[0],
    );
    return {
      totalRevenue,
      totalOrders,
      avgRevenuePerMonth: totalRevenue / sortedRecords.length,
      bestMonth,
    };
  }, [sortedRecords]);

  // Export CSV
  function exportCsv() {
    if (records.length === 0) return;
    const header = "Month,Year,Total Orders,Total Revenue (Tk)\n";
    const rows = records
      .map((r: any) => `${monthNames[r.month]},${r.year},${r.totalOrders},${r.totalRevenue}`)
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `seller-monthly-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const statCards = [
    {
      label: "Total Revenue",
      value: formatTk(summary.totalRevenue),
      icon: DollarSign,
      color: "bg-emerald-50 text-emerald-700",
      sub: `across ${sortedRecords.length} month${sortedRecords.length === 1 ? "" : "s"}`,
    },
    {
      label: "Total Orders",
      value: summary.totalOrders.toLocaleString(),
      icon: ShoppingCart,
      color: "bg-violet-50 text-violet-700",
      sub: "lifetime delivered",
    },
    {
      label: "Avg / Month",
      value: formatTk(summary.avgRevenuePerMonth),
      icon: TrendingUp,
      color: "bg-amber-50 text-amber-700",
      sub: "revenue per month",
    },
    {
      label: "Best Month",
      value: summary.bestMonth
        ? `${monthAbbr[(summary.bestMonth as any).month]} ${String((summary.bestMonth as any).year).slice(-2)}`
        : "—",
      icon: Calendar,
      color: "bg-sky-50 text-sky-700",
      sub: summary.bestMonth ? formatTk(Number((summary.bestMonth as any).totalRevenue)) : "no data yet",
    },
  ];

  if (isLoading) {
    return (
      <div className="space-y-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border p-12 text-center">
        <div className="h-16 w-16 mx-auto mb-4 rounded-2xl bg-muted flex items-center justify-center">
          <Calendar className="h-8 w-8 text-muted-foreground/50" />
        </div>
        <p className="font-semibold text-foreground mb-1">No order history yet</p>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          Your monthly order count and delivered revenue will appear here once buyers start ordering.
          Numbers are computed live from your own orders.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Description + Export */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Monthly order count and delivered revenue, computed live from your own orders.
        </p>
        <Button variant="outline" size="sm" className="rounded-xl self-start" onClick={exportCsv}>
          <Download className="h-4 w-4 mr-1.5" />
          Export CSV
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {statCards.map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-card p-4 flex items-center gap-3">
            <div className={cn("h-10 w-10 rounded-xl flex items-center justify-center shrink-0", s.color)}>
              <s.icon className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{s.label}</p>
              <p className="text-lg font-bold text-foreground tabular-nums truncate">{s.value}</p>
              <p className="text-[10px] text-muted-foreground truncate">{s.sub}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Revenue chart */}
      <section className="rounded-2xl border border-border bg-card">
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border/60">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Revenue Trend</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Monthly delivered revenue</p>
          </div>
        </header>
        <div className="p-5">
          <div className="h-64">
            {chartData.some((d: any) => d.revenue > 0) ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 8, left: -8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="historyRevenueGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_PRIMARY} stopOpacity={0.32} />
                      <stop offset="100%" stopColor={CHART_PRIMARY} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => (v >= 1000 ? `Tk${(v / 1000).toFixed(0)}k` : `Tk${v}`)}
                    width={56}
                  />
                  <Tooltip content={<ChartTooltip />} cursor={{ stroke: "hsl(var(--border))", strokeWidth: 1 }} />
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    stroke={CHART_PRIMARY}
                    strokeWidth={2.5}
                    fill="url(#historyRevenueGrad)"
                    name="revenue"
                    dot={{ r: 3, fill: CHART_PRIMARY, strokeWidth: 0 }}
                    activeDot={{ r: 5, fill: CHART_PRIMARY, stroke: "hsl(var(--card))", strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                <TrendingUp className="h-10 w-10 mb-3 text-muted-foreground/40" />
                <p className="text-sm">No revenue data yet</p>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Orders chart */}
      <section className="rounded-2xl border border-border bg-card">
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border/60">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Order Count</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Monthly order volume</p>
          </div>
        </header>
        <div className="p-5">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 8, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                  width={32}
                />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.5 }} />
                <Bar dataKey="orders" radius={[6, 6, 0, 0]} name="orders" maxBarSize={48}>
                  {chartData.map((_: any, i: number) => (
                    <Cell key={i} fill={i === chartData.length - 1 ? CHART_ACCENT : CHART_PRIMARY} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* Table */}
      <section className="rounded-2xl border border-border bg-card overflow-hidden">
        <header className="px-5 py-4 border-b border-border/60">
          <h3 className="text-sm font-semibold text-foreground">Monthly Breakdown</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Detailed per-month figures</p>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Month</th>
                <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Total Orders</th>
                <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Revenue (Delivered)</th>
                <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Avg. Order Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {[...records].reverse().map((r: any) => {
                const aov = r.totalOrders > 0 ? Number(r.totalRevenue) / r.totalOrders : 0;
                return (
                  <tr key={r.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-5 py-4">
                      <p className="font-medium text-foreground">{monthNames[r.month]} {r.year}</p>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <span className="font-semibold text-foreground tabular-nums">{r.totalOrders}</span>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <span className="font-semibold text-emerald-700 tabular-nums">{formatTk(Number(r.totalRevenue))}</span>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <span className="text-muted-foreground tabular-nums">{formatTk(aov)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
