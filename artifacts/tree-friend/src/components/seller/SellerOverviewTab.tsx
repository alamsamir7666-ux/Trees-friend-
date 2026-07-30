import { useMemo, useState } from "react";
import {
  Package2, ShoppingCart, TrendingUp, ChevronRight, Clock,
  DollarSign, ArrowUpRight, ArrowDownRight, CheckCircle2, Truck,
  XCircle, BarChart3, AlertTriangle, Wallet, CreditCard, Sprout,
  Star, PackageCheck, RotateCcw, BadgeCheck, Plus, Download,
  ShoppingBag, Users, Sparkles, ArrowRight, Minus,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
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

// ─────────────────────────────────────────────────────────────────────────────
// Design tokens (matches brand: forest green / cream / gold-brown)
// ─────────────────────────────────────────────────────────────────────────────
const CHART_PRIMARY = "hsl(150 30% 40%)"; // chart-1 — forest green
const CHART_ACCENT = "hsl(32 55% 45%)"; // gold-brown
const CHART_SOFT = "hsl(160 30% 60%)"; // sage

// Status metadata — single source of truth
type OrderStatus = "pending" | "confirmed" | "processing" | "shipped" | "delivered" | "cancelled";

const ORDER_STATUS_META: Record<
  OrderStatus,
  { label: string; icon: React.ElementType; dot: string; chip: string; hex: string }
> = {
  pending: {
    label: "Pending",
    icon: Clock,
    dot: "bg-amber-500",
    chip: "bg-amber-50 text-amber-700 ring-1 ring-amber-200/60",
    hex: "#f59e0b",
  },
  confirmed: {
    label: "Confirmed",
    icon: CheckCircle2,
    dot: "bg-sky-500",
    chip: "bg-sky-50 text-sky-700 ring-1 ring-sky-200/60",
    hex: "#0ea5e9",
  },
  processing: {
    label: "Processing",
    icon: BarChart3,
    dot: "bg-violet-500",
    chip: "bg-violet-50 text-violet-700 ring-1 ring-violet-200/60",
    hex: "#8b5cf6",
  },
  shipped: {
    label: "Shipped",
    icon: Truck,
    dot: "bg-indigo-500",
    chip: "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200/60",
    hex: "#6366f1",
  },
  delivered: {
    label: "Delivered",
    icon: PackageCheck,
    dot: "bg-emerald-500",
    chip: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60",
    hex: "#10b981",
  },
  cancelled: {
    label: "Cancelled",
    icon: XCircle,
    dot: "bg-rose-500",
    chip: "bg-rose-50 text-rose-700 ring-1 ring-rose-200/60",
    hex: "#f43f5e",
  },
};

const STATUS_ORDER: OrderStatus[] = [
  "pending", "confirmed", "processing", "shipped", "delivered", "cancelled",
];

// ─────────────────────────────────────────────────────────────────────────────
// Date range selector
// ─────────────────────────────────────────────────────────────────────────────
type RangeKey = "7d" | "30d" | "90d" | "12m";

const RANGES: { key: RangeKey; label: string; days: number }[] = [
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
  { key: "12m", label: "12 months", days: 365 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function formatTk(n: number): string {
  return `Tk${Math.round(n).toLocaleString()}`;
}

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? 100 : null;
  return ((current - previous) / previous) * 100;
}

function withinRange(date: Date, days: number): boolean {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return date >= cutoff;
}

function previousRangeDate(date: Date, days: number): boolean {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days * 2);
  const earlier = new Date();
  earlier.setDate(earlier.getDate() - days);
  return date >= cutoff && date < earlier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom chart tooltip
// ─────────────────────────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label, metric }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-border bg-popover px-3.5 py-2.5 shadow-md">
      <p className="text-[11px] font-medium text-muted-foreground mb-1.5">{label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: p.color }}
          />
          <span className="text-muted-foreground capitalize">{p.name}:</span>
          <span className="font-semibold text-foreground">
            {metric === "revenue" || p.name === "revenue"
              ? formatTk(p.value)
              : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// KPI Card — with sparkline, % change vs previous range
// ─────────────────────────────────────────────────────────────────────────────
function KpiCard({
  label, value, sublabel, icon: Icon, accentClass,
  change, sparkData, sparkKey, isLoading,
}: {
  label: string;
  value: string;
  sublabel?: string;
  icon: React.ElementType;
  accentClass: string;
  change: number | null;
  sparkData: { v: number }[];
  sparkKey: string;
  isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center justify-between mb-4">
          <Skeleton className="h-3 w-20 rounded-full" />
          <Skeleton className="h-9 w-9 rounded-xl" />
        </div>
        <Skeleton className="h-7 w-20 mb-2" />
        <Skeleton className="h-3 w-24 rounded-full mb-3" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  const trendUp = change !== null && change > 0;
  const trendDown = change !== null && change < 0;
  const trendNeutral = change === null || change === 0;
  const sparkColor =
    trendUp ? "#10b981" : trendDown ? "#f43f5e" : CHART_PRIMARY;

  return (
    <div className="group rounded-2xl border border-border bg-card p-5 transition-all duration-200 hover:shadow-md hover:border-foreground/10">
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
        </div>
        <div className={cn("h-9 w-9 rounded-xl flex items-center justify-center shrink-0", accentClass)}>
          <Icon className="h-4 w-4" />
        </div>
      </div>

      <div className="flex items-end justify-between gap-3 mb-3">
        <p className="text-2xl font-bold tracking-tight text-foreground tabular-nums">
          {value}
        </p>
        {change !== null && (
          <div
            className={cn(
              "flex items-center gap-0.5 text-xs font-semibold rounded-full px-1.5 py-0.5",
              trendUp && "bg-emerald-50 text-emerald-700",
              trendDown && "bg-rose-50 text-rose-700",
              trendNeutral && "bg-muted text-muted-foreground",
            )}
          >
            {trendUp && <ArrowUpRight className="h-3 w-3" />}
            {trendDown && <ArrowDownRight className="h-3 w-3" />}
            {trendNeutral && <Minus className="h-3 w-3" />}
            {Math.abs(change).toFixed(0)}%
          </div>
        )}
      </div>

      {sublabel && (
        <p className="text-[11px] text-muted-foreground mb-2 truncate">{sublabel}</p>
      )}

      {/* Sparkline */}
      <div className="h-8 -mx-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={sparkData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`spark-${sparkKey}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={sparkColor} stopOpacity={0.35} />
                <stop offset="100%" stopColor={sparkColor} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="v"
              stroke={sparkColor}
              strokeWidth={1.75}
              fill={`url(#spark-${sparkKey})`}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Order status donut
// ─────────────────────────────────────────────────────────────────────────────
function StatusDonut({ counts, total }: { counts: Record<OrderStatus, number>; total: number }) {
  const segments = STATUS_ORDER.filter((s) => counts[s] > 0);
  const radius = 60;
  const strokeWidth = 14;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  if (total === 0 || segments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-6 text-muted-foreground">
        <div className="h-32 w-32 rounded-full border-[14px] border-muted flex items-center justify-center mb-3">
          <ShoppingBag className="h-6 w-6 text-muted-foreground/50" />
        </div>
        <p className="text-sm font-medium">No orders yet</p>
        <p className="text-xs text-muted-foreground/70 mt-0.5">Orders will appear here</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col sm:flex-row items-center gap-6">
      <div className="relative h-36 w-36 shrink-0">
        <svg viewBox="0 0 160 160" className="h-full w-full -rotate-90">
          <circle cx="80" cy="80" r={radius} fill="none" stroke="hsl(var(--muted))" strokeWidth={strokeWidth} />
          {segments.map((s) => {
            const value = counts[s];
            const fraction = value / total;
            const dash = fraction * circumference;
            const seg = (
              <circle
                key={s}
                cx="80"
                cy="80"
                r={radius}
                fill="none"
                stroke={ORDER_STATUS_META[s].hex}
                strokeWidth={strokeWidth}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              />
            );
            offset += dash;
            return seg;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-2xl font-bold text-foreground tabular-nums">{total}</p>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total</p>
        </div>
      </div>

      <div className="flex-1 w-full grid grid-cols-2 gap-x-4 gap-y-2">
        {segments.map((s) => {
          const meta = ORDER_STATUS_META[s];
          const count = counts[s];
          const pct = ((count / total) * 100).toFixed(0);
          return (
            <div key={s} className="flex items-center gap-2">
              <span className={cn("h-2.5 w-2.5 rounded-sm shrink-0", meta.dot)} />
              <span className="text-xs text-muted-foreground truncate flex-1">{meta.label}</span>
              <span className="text-xs font-semibold text-foreground tabular-nums">{count}</span>
              <span className="text-[10px] text-muted-foreground tabular-nums w-8 text-right">{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Action item (smart alert)
// ─────────────────────────────────────────────────────────────────────────────
function ActionItem({
  icon: Icon, iconClass, title, detail, ctaLabel, onClick, severity,
}: {
  icon: React.ElementType;
  iconClass: string;
  title: string;
  detail: string;
  ctaLabel: string;
  onClick: () => void;
  severity: "warning" | "info" | "danger";
}) {
  const severityRing =
    severity === "danger" ? "ring-rose-200/70 bg-rose-50/40"
    : severity === "warning" ? "ring-amber-200/70 bg-amber-50/40"
    : "ring-sky-200/70 bg-sky-50/40";

  return (
    <div className={cn("flex items-center gap-3 rounded-xl ring-1 px-3.5 py-3", severityRing)}>
      <div className={cn("h-9 w-9 rounded-lg flex items-center justify-center shrink-0", iconClass)}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{title}</p>
        <p className="text-xs text-muted-foreground truncate">{detail}</p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 px-2.5 text-xs font-medium shrink-0"
        onClick={onClick}
      >
        {ctaLabel}
        <ArrowRight className="h-3 w-3 ml-1" />
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Health check row
// ─────────────────────────────────────────────────────────────────────────────
function HealthRow({
  label, status, icon: Icon, detail, cta,
}: {
  label: string;
  status: "ok" | "warning" | "missing";
  icon: React.ElementType;
  detail: string;
  cta?: { label: string; onClick: () => void };
}) {
  const styles = {
    ok: { dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200/60", label: "Active" },
    warning: { dot: "bg-amber-500", chip: "bg-amber-50 text-amber-700 ring-amber-200/60", label: "Pending" },
    missing: { dot: "bg-muted-foreground/40", chip: "bg-muted text-muted-foreground ring-border", label: "Not set up" },
  }[status];

  return (
    <div className="flex items-center gap-3 py-3">
      <div className="h-9 w-9 rounded-lg bg-muted/60 border border-border flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{label}</p>
        <p className="text-xs text-muted-foreground truncate">{detail}</p>
      </div>
      {cta && status !== "ok" ? (
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-xs shrink-0"
          onClick={cta.onClick}
        >
          {cta.label}
        </Button>
      ) : (
        <span className={cn("text-[11px] font-medium rounded-full px-2 py-0.5 ring-1 flex items-center gap-1.5 shrink-0", styles.chip)}>
          <span className={cn("h-1.5 w-1.5 rounded-full", styles.dot)} />
          {styles.label}
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Top listing row
// ─────────────────────────────────────────────────────────────────────────────
function TopListingRow({
  listing, orderCount, revenue, rank,
}: {
  listing: any; orderCount: number; revenue: number; rank: number;
}) {
  const name = listing.productName ?? `Listing #${listing.id}`;
  const imageUrl = listing.images?.[0];
  const approvalStatus: string = listing.approvalStatus ?? "approved";
  const approvalChip =
    approvalStatus === "approved" ? "bg-emerald-50 text-emerald-700 ring-emerald-200/60"
    : approvalStatus === "pending" ? "bg-amber-50 text-amber-700 ring-amber-200/60"
    : "bg-rose-50 text-rose-700 ring-rose-200/60";

  return (
    <div className="flex items-center gap-3 py-3">
      <span className="w-5 text-xs font-bold text-muted-foreground tabular-nums text-center shrink-0">
        {rank}
      </span>
      {imageUrl ? (
        <img src={imageUrl} alt={name} className="h-10 w-10 rounded-lg object-cover border border-border shrink-0" />
      ) : (
        <div className="h-10 w-10 rounded-lg bg-secondary flex items-center justify-center shrink-0">
          <Sprout className="h-4 w-4 text-muted-foreground" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{name}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium capitalize ring-1", approvalChip)}>
            {approvalStatus}
          </span>
          <span className="text-[11px] text-muted-foreground">{orderCount} sold</span>
        </div>
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-semibold text-foreground tabular-nums">{formatTk(revenue)}</p>
        <p className="text-[10px] text-muted-foreground">revenue</p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section shell — consistent card styling
// ─────────────────────────────────────────────────────────────────────────────
function Section({
  title, subtitle, action, children, className,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-2xl border border-border bg-card", className)}>
      <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border/60">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────
export function SellerOverviewTab({
  seller,
  onNavigate,
}: {
  seller: Seller;
  onNavigate: (section: string) => void;
}) {
  const [rangeKey, setRangeKey] = useState<RangeKey>("30d");
  const [chartMetric, setChartMetric] = useState<"revenue" | "orders">("revenue");

  const { data: listings, isLoading: listingsLoading } = useListMySellerListings();
  const { data: orders, isLoading: ordersLoading } = useListSellerOrders({});
  const { data: publicProfile } = useGetPublicSeller(seller.id, {
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
  const range = RANGES.find((r) => r.key === rangeKey)!;

  // ── Computed data ─────────────────────────────────────────────────────────
  const allListings = listings ?? [];
  const allOrders = (orders ?? []) as any[];

  // Filter orders within selected range
  const rangedOrders = useMemo(
    () => allOrders.filter((o) => withinRange(new Date(o.createdAt), range.days)),
    [allOrders, range.days],
  );
  const previousRangedOrders = useMemo(
    () => allOrders.filter((o) => previousRangeDate(new Date(o.createdAt), range.days)),
    [allOrders, range.days],
  );

  // KPI 1: Revenue (non-cancelled)
  const currentRevenue = rangedOrders
    .filter((o) => o.orderStatus !== "cancelled")
    .reduce((sum, o) => sum + Number(o.totalAmount ?? 0), 0);
  const previousRevenue = previousRangedOrders
    .filter((o) => o.orderStatus !== "cancelled")
    .reduce((sum, o) => sum + Number(o.totalAmount ?? 0), 0);
  const revenueChange = pctChange(currentRevenue, previousRevenue);

  // KPI 2: Orders (non-cancelled)
  const currentOrders = rangedOrders.filter((o) => o.orderStatus !== "cancelled").length;
  const previousOrders = previousRangedOrders.filter((o) => o.orderStatus !== "cancelled").length;
  const ordersChange = pctChange(currentOrders, previousOrders);

  // KPI 3: AOV
  const currentAov = currentOrders > 0 ? currentRevenue / currentOrders : 0;
  const previousAov = previousOrders > 0 ? previousRevenue / previousOrders : 0;
  const aovChange = pctChange(currentAov, previousAov);

  // KPI 4: Active listings (no time range, snapshot)
  const activeListingsCount = allListings.length;

  // Sparkline data — last N points based on range
  const revenueSpark = useMemo(() => {
    const buckets = range.days <= 30 ? range.days : range.days <= 90 ? 14 : 12;
    const points: { v: number }[] = [];
    for (let i = buckets - 1; i >= 0; i--) {
      const daysPerBucket = Math.ceil(range.days / buckets);
      const start = new Date();
      start.setDate(start.getDate() - (i + 1) * daysPerBucket);
      const end = new Date();
      end.setDate(end.getDate() - i * daysPerBucket);
      const v = rangedOrders
        .filter((o) => {
          const od = new Date(o.createdAt);
          return od >= start && od < end && o.orderStatus !== "cancelled";
        })
        .reduce((sum, o) => sum + Number(o.totalAmount ?? 0), 0);
      points.push({ v });
    }
    return points;
  }, [rangedOrders, range.days]);

  const ordersSpark = useMemo(() => {
    const buckets = range.days <= 30 ? range.days : range.days <= 90 ? 14 : 12;
    const points: { v: number }[] = [];
    for (let i = buckets - 1; i >= 0; i--) {
      const daysPerBucket = Math.ceil(range.days / buckets);
      const start = new Date();
      start.setDate(start.getDate() - (i + 1) * daysPerBucket);
      const end = new Date();
      end.setDate(end.getDate() - i * daysPerBucket);
      const v = rangedOrders.filter((o) => {
        const od = new Date(o.createdAt);
        return od >= start && od < end && o.orderStatus !== "cancelled";
      }).length;
      points.push({ v });
    }
    return points;
  }, [rangedOrders, range.days]);

  const aovSpark = useMemo(
    () => revenueSpark.map((r, i) => ({
      v: ordersSpark[i]?.v ? r.v / ordersSpark[i].v : 0,
    })),
    [revenueSpark, ordersSpark],
  );

  // Main chart data
  const chartData = useMemo(() => {
    const buckets = range.days <= 30 ? range.days : range.days <= 90 ? 30 : 12;
    const points: { label: string; revenue: number; orders: number }[] = [];
    for (let i = buckets - 1; i >= 0; i--) {
      if (range.days > 90) {
        // Monthly
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        const monthOrders = rangedOrders.filter((o) => {
          const od = new Date(o.createdAt);
          return od.getMonth() === d.getMonth() && od.getFullYear() === d.getFullYear();
        });
        points.push({
          label: d.toLocaleDateString("en-US", { month: "short" }),
          revenue: monthOrders
            .filter((o) => o.orderStatus !== "cancelled")
            .reduce((sum, o) => sum + Number(o.totalAmount ?? 0), 0),
          orders: monthOrders.filter((o) => o.orderStatus !== "cancelled").length,
        });
      } else {
        const daysPerBucket = Math.ceil(range.days / buckets);
        const start = new Date();
        start.setDate(start.getDate() - (i + 1) * daysPerBucket);
        const end = new Date();
        end.setDate(end.getDate() - i * daysPerBucket);
        const bucketOrders = rangedOrders.filter((o) => {
          const od = new Date(o.createdAt);
          return od >= start && od < end;
        });
        const label =
          daysPerBucket === 1
            ? end.toLocaleDateString("en-US", { month: "short", day: "numeric" })
            : `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
        points.push({
          label,
          revenue: bucketOrders
            .filter((o) => o.orderStatus !== "cancelled")
            .reduce((sum, o) => sum + Number(o.totalAmount ?? 0), 0),
          orders: bucketOrders.filter((o) => o.orderStatus !== "cancelled").length,
        });
      }
    }
    return points;
  }, [rangedOrders, range.days]);

  // Order status counts (within range)
  const statusCounts = useMemo(() => {
    const counts: Record<OrderStatus, number> = {
      pending: 0, confirmed: 0, processing: 0, shipped: 0, delivered: 0, cancelled: 0,
    };
    for (const o of rangedOrders) {
      const s = o.orderStatus as OrderStatus;
      if (counts[s] !== undefined) counts[s]++;
    }
    return counts;
  }, [rangedOrders]);

  const statusTotal = Object.values(statusCounts).reduce((a, b) => a + b, 0);

  // Recent orders (top 6 by date)
  const recentOrders = useMemo(
    () =>
      [...allOrders]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 6),
    [allOrders],
  );

  // Top listings
  const topListings = useMemo(() => {
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
    for (const l of allListings) {
      const existing = map.get(l.id);
      if (existing) existing.listing = l;
      else map.set(l.id, { listing: l, orderCount: 0, revenue: 0 });
    }
    return Array.from(map.values())
      .filter((x) => x.listing)
      .sort((a, b) => b.revenue - a.revenue || b.orderCount - a.orderCount)
      .slice(0, 5);
  }, [allOrders, allListings]);

  // Monthly revenue bar (last 6 months)
  const monthlyBarData = useMemo(() => {
    const records = (monthlyHistory as any)?.records ?? [];
    if (records.length > 0) {
      return records.map((r: any) => ({
        month: new Date(r.year, r.month - 1).toLocaleDateString("en-US", { month: "short" }),
        revenue: r.totalRevenue,
        orders: r.totalOrders,
      }));
    }
    const now = new Date();
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
  }, [monthlyHistory, allOrders]);

  // Pending counts
  const pendingOrdersCount = statusCounts.pending;
  const pendingReturnsCount =
    (returns as any)?.returns?.filter((r: any) => r.status === "requested").length ?? 0;

  // Store health
  const isPaymentConfigured = !!(paymentConfig as any);
  const isPaymentVerified = (paymentConfig as any)?.verificationStatus === "verified";
  const isCourierConfigured = !!(courierConfig as any);
  const isCourierVerified = (courierConfig as any)?.verificationStatus === "verified";

  // Lifetime stats
  const lifetimeRevenue = allOrders
    .filter((o) => o.orderStatus === "delivered")
    .reduce((sum, o) => sum + Number(o.totalAmount ?? 0), 0);
  const lifetimeDelivered = allOrders.filter((o) => o.orderStatus === "delivered").length;
  const followersCount = publicProfile?.followerCount ?? 0;

  // ── Loading state ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-border bg-card p-5">
              <div className="flex items-center justify-between mb-4">
                <Skeleton className="h-3 w-20 rounded-full" />
                <Skeleton className="h-9 w-9 rounded-xl" />
              </div>
              <Skeleton className="h-7 w-24 mb-3" />
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 rounded-2xl border border-border bg-card p-5">
            <Skeleton className="h-5 w-40 mb-5" />
            <div className="h-64"><Skeleton className="h-full w-full rounded-xl" /></div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-5">
            <Skeleton className="h-5 w-32 mb-5" />
            <Skeleton className="h-32 w-32 mx-auto rounded-full" />
          </div>
        </div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const firstName = seller.ownerName?.split(" ")[0] ?? "Seller";
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const actionItems: React.ReactNode[] = [];
  if (pendingOrdersCount > 0) {
    actionItems.push(
      <ActionItem
        key="pending-orders"
        icon={ShoppingCart}
        iconClass="bg-amber-100 text-amber-700"
        title={`${pendingOrdersCount} pending order${pendingOrdersCount > 1 ? "s" : ""} need attention`}
        detail="Confirm or update status to keep buyers informed"
        ctaLabel="Review"
        onClick={() => onNavigate("orders")}
        severity="warning"
      />,
    );
  }
  if (pendingReturnsCount > 0) {
    actionItems.push(
      <ActionItem
        key="returns"
        icon={RotateCcw}
        iconClass="bg-orange-100 text-orange-700"
        title={`${pendingReturnsCount} return request${pendingReturnsCount > 1 ? "s" : ""} pending`}
        detail="Respond promptly to maintain buyer trust"
        ctaLabel="Review"
        onClick={() => onNavigate("returns")}
        severity="warning"
      />,
    );
  }
  if (!isPaymentConfigured) {
    actionItems.push(
      <ActionItem
        key="payment"
        icon={CreditCard}
        iconClass="bg-emerald-100 text-emerald-700"
        title="Set up payments to receive payouts"
        detail="Connect bKash or bank account to receive order payments"
        ctaLabel="Set up"
        onClick={() => onNavigate("payment")}
        severity="info"
      />,
    );
  }
  if (!isCourierConfigured) {
    actionItems.push(
      <ActionItem
        key="courier"
        icon={Truck}
        iconClass="bg-violet-100 text-violet-700"
        title="Connect a courier to ship orders"
        detail="Integrate Pathao or Steadfast for automated shipping"
        ctaLabel="Set up"
        onClick={() => onNavigate("courier")}
        severity="info"
      />,
    );
  }
  if (activeListingsCount === 0) {
    actionItems.push(
      <ActionItem
        key="no-listings"
        icon={Package2}
        iconClass="bg-sky-100 text-sky-700"
        title="Create your first listing"
        detail="Add a product to start selling on Tree Friend"
        ctaLabel="Add listing"
        onClick={() => onNavigate("listings")}
        severity="info"
      />,
    );
  }

  return (
    <div className="space-y-5">
      {/* ─────────────────────────────────────────────────────────────────────
          Hero header — greeting + date range selector + quick actions
      ───────────────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border bg-gradient-to-br from-primary to-[hsl(150_30%_22%)] text-primary-foreground overflow-hidden">
        <div className="px-6 py-5 sm:px-7 sm:py-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="h-3.5 w-3.5 text-primary-foreground/70" />
              <p className="text-xs font-medium uppercase tracking-wider text-primary-foreground/70">
                {greeting}, {firstName}
              </p>
            </div>
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight">
              {seller.businessName}
            </h2>
            <p className="text-xs sm:text-sm text-primary-foreground/70 mt-1">
              Here's your store performance for the last {range.label.toLowerCase()}.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:items-end shrink-0">
            <div className="inline-flex rounded-xl bg-primary-foreground/10 ring-1 ring-primary-foreground/20 p-1">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setRangeKey(r.key)}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                    rangeKey === r.key
                      ? "bg-primary-foreground text-primary shadow-sm"
                      : "text-primary-foreground/80 hover:text-primary-foreground",
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-primary-foreground/90 hover:text-primary-foreground hover:bg-primary-foreground/10"
                onClick={() => onNavigate("listings")}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add listing
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-primary-foreground/90 hover:text-primary-foreground hover:bg-primary-foreground/10"
                onClick={() => onNavigate("monthlyHistory")}
              >
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Export
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────────
          Action items (smart alerts)
      ───────────────────────────────────────────────────────────────────── */}
      {actionItems.length > 0 && (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <h3 className="text-sm font-semibold text-foreground">Action required</h3>
            <span className="text-xs text-muted-foreground">· {actionItems.length} item{actionItems.length > 1 ? "s" : ""}</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
            {actionItems}
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────
          KPI Cards (4)
      ───────────────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Revenue"
          value={formatTk(currentRevenue)}
          sublabel={`vs ${formatTk(previousRevenue)} prev`}
          icon={DollarSign}
          accentClass="bg-emerald-100 text-emerald-700"
          change={revenueChange}
          sparkData={revenueSpark}
          sparkKey="revenue"
        />
        <KpiCard
          label="Orders"
          value={currentOrders.toLocaleString()}
          sublabel={`vs ${previousOrders} prev`}
          icon={ShoppingCart}
          accentClass="bg-sky-100 text-sky-700"
          change={ordersChange}
          sparkData={ordersSpark}
          sparkKey="orders"
        />
        <KpiCard
          label="Avg. Order Value"
          value={formatTk(currentAov)}
          sublabel={`vs ${formatTk(previousAov)} prev`}
          icon={TrendingUp}
          accentClass="bg-amber-100 text-amber-700"
          change={aovChange}
          sparkData={aovSpark}
          sparkKey="aov"
        />
        <KpiCard
          label="Active Listings"
          value={activeListingsCount.toLocaleString()}
          sublabel={activeListingsCount > 0 ? "Live in marketplace" : "No listings yet"}
          icon={Package2}
          accentClass="bg-violet-100 text-violet-700"
          change={null}
          sparkData={[]}
          sparkKey="listings"
        />
      </div>

      {/* ─────────────────────────────────────────────────────────────────────
          Main chart + Order status donut
      ───────────────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Section
          title="Sales Overview"
          subtitle={`Last ${range.label.toLowerCase()} · non-cancelled orders`}
          className="lg:col-span-2"
          action={
            <div className="inline-flex rounded-lg bg-muted p-0.5">
              {(["revenue", "orders"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setChartMetric(m)}
                  className={cn(
                    "px-2.5 py-1 rounded-md text-xs font-medium capitalize transition-all",
                    chartMetric === m
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          }
        >
          <div className="h-64">
            {chartData.some((d) => (chartMetric === "revenue" ? d.revenue : d.orders) > 0) ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 8, left: -8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="mainChartGrad" x1="0" y1="0" x2="0" y2="1">
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
                    interval="preserveStartEnd"
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) =>
                      chartMetric === "revenue"
                        ? v >= 1000 ? `Tk${(v / 1000).toFixed(0)}k` : `Tk${v}`
                        : `${v}`
                    }
                    width={56}
                  />
                  <Tooltip
                    content={<ChartTooltip metric={chartMetric} />}
                    cursor={{ stroke: "hsl(var(--border))", strokeWidth: 1 }}
                  />
                  <Area
                    type="monotone"
                    dataKey={chartMetric}
                    stroke={CHART_PRIMARY}
                    strokeWidth={2.5}
                    fill="url(#mainChartGrad)"
                    name={chartMetric}
                    dot={false}
                    activeDot={{ r: 4, fill: CHART_PRIMARY, stroke: "hsl(var(--card))", strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                <TrendingUp className="h-10 w-10 mb-3 text-muted-foreground/40" />
                <p className="text-sm font-medium">No {chartMetric} data in this period</p>
                <p className="text-xs text-muted-foreground/70 mt-0.5">Try a different date range</p>
              </div>
            )}
          </div>
        </Section>

        <Section
          title="Order Status"
          subtitle={`${statusTotal} order${statusTotal === 1 ? "" : "s"} in range`}
          action={
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => onNavigate("orders")}
            >
              View all <ChevronRight className="h-3 w-3 ml-0.5" />
            </Button>
          }
        >
          <StatusDonut counts={statusCounts} total={statusTotal} />
        </Section>
      </div>

      {/* ─────────────────────────────────────────────────────────────────────
          Top listings + Store health
      ───────────────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Section
          title="Top Performing Listings"
          subtitle="By delivered revenue"
          action={
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => onNavigate("listings")}
            >
              View all <ChevronRight className="h-3 w-3 ml-0.5" />
            </Button>
          }
        >
          {topListings.length > 0 ? (
            <div className="divide-y divide-border/60">
              {topListings.map((t, i) => (
                <TopListingRow
                  key={t.listing.id}
                  listing={t.listing}
                  orderCount={t.orderCount}
                  revenue={t.revenue}
                  rank={i + 1}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-10 text-muted-foreground">
              <Sprout className="h-10 w-10 mx-auto mb-3 text-muted-foreground/40" />
              <p className="text-sm font-medium">No listing data yet</p>
              <p className="text-xs text-muted-foreground/70 mt-0.5">
                Add listings to see performance metrics here
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-4"
                onClick={() => onNavigate("listings")}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add listing
              </Button>
            </div>
          )}
        </Section>

        <Section
          title="Store Health"
          subtitle="Configuration & verification"
          action={
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => onNavigate("profile")}
            >
              Settings <ChevronRight className="h-3 w-3 ml-0.5" />
            </Button>
          }
        >
          <div className="divide-y divide-border/60">
            <HealthRow
              label="Verified Seller Badge"
              status={seller.isVerified ? "ok" : seller.verificationRequestStatus === "requested" ? "warning" : "missing"}
              icon={BadgeCheck}
              detail={
                seller.isVerified
                  ? "Your store is verified — buyers see the badge"
                  : seller.verificationRequestStatus === "requested"
                    ? "Verification under review"
                    : "Request verification to build buyer trust"
              }
              cta={
                !seller.isVerified
                  ? {
                      label: seller.verificationRequestStatus === "requested" ? "View" : "Verify",
                      onClick: () => onNavigate("profile"),
                    }
                  : undefined
              }
            />
            <HealthRow
              label="Payment Setup"
              status={isPaymentVerified ? "ok" : isPaymentConfigured ? "warning" : "missing"}
              icon={CreditCard}
              detail={
                isPaymentVerified
                  ? "bKash connected & verified"
                  : isPaymentConfigured
                    ? "Connected — pending verification"
                    : "Connect bKash to receive payouts"
              }
              cta={
                !isPaymentVerified
                  ? { label: isPaymentConfigured ? "View" : "Set up", onClick: () => onNavigate("payment") }
                  : undefined
              }
            />
            <HealthRow
              label="Courier Setup"
              status={isCourierVerified ? "ok" : isCourierConfigured ? "warning" : "missing"}
              icon={Truck}
              detail={
                isCourierVerified
                  ? "Courier connected & verified"
                  : isCourierConfigured
                    ? "Connected — pending verification"
                    : "Connect Pathao or Steadfast to ship orders"
              }
              cta={
                !isCourierVerified
                  ? { label: isCourierConfigured ? "View" : "Set up", onClick: () => onNavigate("courier") }
                  : undefined
              }
            />
            <HealthRow
              label="Subscription"
              status={
                seller.subscriptionStatus === "active" ? "ok"
                : seller.subscriptionStatus === "trial" ? "warning"
                : "missing"
              }
              icon={Wallet}
              detail={
                seller.subscriptionStatus === "active"
                  ? "Active subscription"
                  : seller.subscriptionStatus === "trial"
                    ? seller.trialEndsAt
                      ? `Trial ends ${new Date(seller.trialEndsAt).toLocaleDateString()}`
                      : "Trial period active"
                    : "Subscription expired"
              }
              cta={
                seller.subscriptionStatus !== "active"
                  ? { label: "Manage", onClick: () => onNavigate("profile") }
                  : undefined
              }
            />
          </div>
        </Section>
      </div>

      {/* ─────────────────────────────────────────────────────────────────────
          Monthly revenue bar chart
      ───────────────────────────────────────────────────────────────────── */}
      <Section
        title="Monthly Revenue"
        subtitle="Last 6 months · delivered orders"
        action={
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => onNavigate("monthlyHistory")}
          >
            Details <ChevronRight className="h-3 w-3 ml-0.5" />
          </Button>
        }
      >
        <div className="h-56">
          {monthlyBarData.some((d: { revenue: number }) => d.revenue > 0) ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyBarData} margin={{ top: 10, right: 8, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="month"
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
                <Tooltip content={<ChartTooltip metric="revenue" />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.5 }} />
                <Bar dataKey="revenue" radius={[6, 6, 0, 0]} name="revenue" maxBarSize={48}>
                  {monthlyBarData.map((_: any, i: number) => (
                    <Cell key={i} fill={i === monthlyBarData.length - 1 ? CHART_ACCENT : CHART_PRIMARY} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
              <BarChart3 className="h-10 w-10 mb-3 text-muted-foreground/40" />
              <p className="text-sm font-medium">No monthly revenue yet</p>
              <p className="text-xs text-muted-foreground/70 mt-0.5">Data appears after first delivered order</p>
            </div>
          )}
        </div>
      </Section>

      {/* ─────────────────────────────────────────────────────────────────────
          Recent orders table
      ───────────────────────────────────────────────────────────────────── */}
      <Section
        title="Recent Orders"
        subtitle="Latest 6 orders across all statuses"
        action={
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => onNavigate("orders")}
          >
            View all <ChevronRight className="h-3 w-3 ml-0.5" />
          </Button>
        }
      >
        {recentOrders.length > 0 ? (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="border-b border-border/60 text-left">
                  <th className="px-5 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Order</th>
                  <th className="px-5 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Date</th>
                  <th className="px-5 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
                  <th className="px-5 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground text-right">Total</th>
                  <th className="px-5 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {recentOrders.map((o) => {
                  const meta = ORDER_STATUS_META[o.orderStatus as OrderStatus] ?? ORDER_STATUS_META.pending;
                  const StatusIcon = meta.icon;
                  return (
                    <tr
                      key={o.id}
                      className="hover:bg-muted/40 transition-colors cursor-pointer"
                      onClick={() => onNavigate("orders")}
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                            <StatusIcon className="h-3.5 w-3.5 text-muted-foreground" />
                          </div>
                          <span className="text-sm font-medium text-foreground tabular-nums">
                            {o.trackingId}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-sm text-muted-foreground tabular-nums">
                        {new Date(o.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </td>
                      <td className="px-5 py-3">
                        <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-2 py-0.5 ring-1", meta.chip)}>
                          <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-sm font-semibold text-foreground text-right tabular-nums">
                        {formatTk(Number(o.totalAmount ?? 0))}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <ChevronRight className="h-4 w-4 text-muted-foreground/60" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-12 text-muted-foreground">
            <ShoppingCart className="h-12 w-12 mx-auto mb-4 text-muted-foreground/40" />
            <p className="font-medium text-foreground mb-1">No orders yet</p>
            <p className="text-sm text-muted-foreground/70">
              Orders will appear here once buyers start purchasing your listings.
            </p>
          </div>
        )}
      </Section>

      {/* ─────────────────────────────────────────────────────────────────────
          Lifetime stats footer
      ───────────────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Lifetime Revenue", value: formatTk(lifetimeRevenue), icon: DollarSign, color: "bg-emerald-50 text-emerald-600" },
          { label: "Delivered Orders", value: lifetimeDelivered.toLocaleString(), icon: PackageCheck, color: "bg-sky-50 text-sky-600" },
          { label: "Followers", value: followersCount.toLocaleString(), icon: Users, color: "bg-pink-50 text-pink-600" },
          { label: "Avg. Rating", value: "—", icon: Star, color: "bg-amber-50 text-amber-600" },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl border border-border bg-card px-4 py-3 flex items-center gap-3"
          >
            <div className={cn("h-9 w-9 rounded-lg flex items-center justify-center shrink-0", stat.color)}>
              <stat.icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] text-muted-foreground truncate">{stat.label}</p>
              <p className="text-base font-bold text-foreground tabular-nums">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
