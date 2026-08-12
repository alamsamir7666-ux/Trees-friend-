/**
 * TreeBot Insights admin tab.
 *
 * Shows aggregated metrics about TreeBot usage so the admin can see:
 *   - Headline numbers (sessions, messages, 👍/👎 count, refusal rate)
 *   - Daily activity time-series chart (user vs assistant vs refusals)
 *   - Top keywords from user questions (what buyers are asking about)
 *   - Top products mentioned in AI replies (which products get recommended)
 *   - 👎-rated messages table (so admin can see what's broken + improve)
 *
 * All data is fetched via /api/ai/admin/* endpoints (requireAdmin).
 */
import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@clerk/react";
import {
  Sparkles, MessageSquare, ThumbsUp, ThumbsDown, TrendingDown, Activity,
  Users, RefreshCw, ChevronLeft, ChevronRight, ExternalLink,
} from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useChartColors } from "@/hooks/useChartColors";
import { MarkdownText } from "@/components/ai/MarkdownText";
import {
  extractFollowups, extractProductMentions, stripProductMentionMarkers,
} from "@/components/ai/parseMessage";

const API = import.meta.env.VITE_API_BASE_URL ?? "";

// ─── Types matching backend responses ───────────────────────────────────────

interface OverviewStats {
  totalSessions: number;
  totalMessages: number;
  totalUserMessages: number;
  totalAssistantMessages: number;
  totalFeedback: number;
  positiveFeedback: number;
  negativeFeedback: number;
  refusalCount: number;
  refusalRate: number;
  greetingCount: number;
}

interface TimeseriesPoint {
  date: string;
  user: number;
  assistant: number;
  refusals: number;
}

interface KeywordCount {
  word: string;
  count: number;
}

interface ProductCount {
  name: string;
  count: number;
}

interface FeedbackItem {
  feedbackId: number;
  rating: "up" | "down";
  comment: string | null;
  feedbackAt: string;
  messageId: number;
  assistantContent: string;
  messageAt: string;
  sessionId: number;
  sessionToken: string;
  userId: string | null;
  userQuestion: string | null;
}

// ─── Main component ──────────────────────────────────────────────────────────

export function AiInsightsTab() {
  const { getToken } = useAuth();
  const [overview, setOverview] = useState<OverviewStats | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[]>([]);
  const [keywords, setKeywords] = useState<KeywordCount[]>([]);
  const [products, setProducts] = useState<ProductCount[]>([]);
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [feedbackTotal, setFeedbackTotal] = useState(0);
  const [feedbackOffset, setFeedbackOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const chart = useChartColors();

  const PAGE_SIZE = 10;

  const fetchAll = useCallback(async () => {
    const token = await getToken();
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    const [ov, ts, kw, pr, fb] = await Promise.all([
      fetch(`${API}/api/ai/admin/overview`, { headers }).then((r) => r.json()),
      fetch(`${API}/api/ai/admin/timeseries?days=30`, { headers }).then((r) => r.json()),
      fetch(`${API}/api/ai/admin/top-questions?limit=15`, { headers }).then((r) => r.json()),
      fetch(`${API}/api/ai/admin/top-products?limit=15`, { headers }).then((r) => r.json()),
      fetch(`${API}/api/ai/admin/feedback?rating=down&limit=${PAGE_SIZE}&offset=0`, { headers }).then((r) => r.json()),
    ]);

    setOverview(ov);
    setTimeseries(ts.data ?? []);
    setKeywords(kw.keywords ?? []);
    setProducts(pr.products ?? []);
    setFeedback(fb.items ?? []);
    setFeedbackTotal(fb.total ?? 0);
    setFeedbackOffset(0);
  }, [getToken]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await fetchAll();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchAll]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetchAll();
    } finally {
      setRefreshing(false);
    }
  };

  const fetchFeedbackPage = async (newOffset: number) => {
    const token = await getToken();
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};
    const fb = await fetch(
      `${API}/api/ai/admin/feedback?rating=down&limit=${PAGE_SIZE}&offset=${newOffset}`,
      { headers },
    ).then((r) => r.json());
    setFeedback(fb.items ?? []);
    setFeedbackOffset(newOffset);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">TreeBot Insights</h2>
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-72 w-full" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ─── Header ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">TreeBot Insights</h2>
            <p className="text-xs text-muted-foreground">
              Usage metrics, top questions, and 👎 feedback
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={`h-4 w-4 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* ─── Stat cards ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={<Users className="h-4 w-4" />}
          label="Sessions"
          value={overview?.totalSessions ?? 0}
          tint="bg-info/10 text-info border-info/20"
        />
        <StatCard
          icon={<MessageSquare className="h-4 w-4" />}
          label="Total Messages"
          value={overview?.totalMessages ?? 0}
          sub={`${overview?.totalUserMessages ?? 0} user / ${overview?.totalAssistantMessages ?? 0} AI`}
          tint="bg-primary/10 text-primary border-primary/20"
        />
        <StatCard
          icon={<ThumbsUp className="h-4 w-4" />}
          label="Positive Feedback"
          value={overview?.positiveFeedback ?? 0}
          sub={`of ${overview?.totalFeedback ?? 0} rated`}
          tint="bg-success/10 text-success border-success/20"
        />
        <StatCard
          icon={<TrendingDown className="h-4 w-4" />}
          label="Refusal Rate"
          value={`${overview?.refusalRate ?? 0}%`}
          sub={`${overview?.refusalCount ?? 0} off-topic`}
          tint="bg-warning/10 text-warning border-warning/20"
        />
      </div>

      {/* ─── Activity chart ──────────────────────────────────────────── */}
      <div className="bg-card rounded-xl border p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Daily Activity (last 30 days)
          </h3>
        </div>
        {timeseries.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={timeseries} margin={{ top: 5, right: 10, bottom: 0, left: -20 }}>
              <defs>
                <linearGradient id="gradUser" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={chart.primary} stopOpacity={0.4} />
                  <stop offset="95%" stopColor={chart.primary} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradRefusal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={chart.destructive} stopOpacity={0.4} />
                  <stop offset="95%" stopColor={chart.destructive} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={chart.gridStroke} strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: chart.axisTick }}
                tickFormatter={(d: string) => d.slice(5)}
                stroke={chart.axisLine}
              />
              <YAxis
                tick={{ fontSize: 10, fill: chart.axisTick }}
                stroke={chart.axisLine}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: chart.tooltipBg,
                  border: `1px solid ${chart.gridStroke}`,
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area
                type="monotone"
                dataKey="user"
                name="User messages"
                stroke={chart.primary}
                strokeWidth={2}
                fill="url(#gradUser)"
              />
              <Area
                type="monotone"
                dataKey="refusals"
                name="Off-topic refusals"
                stroke={chart.destructive}
                strokeWidth={2}
                fill="url(#gradRefusal)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ─── Two-column: keywords + products ──────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Top keywords */}
        <div className="bg-card rounded-xl border p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            Top Keywords in User Questions
          </h3>
          {keywords.length === 0 ? (
            <EmptyList text="No user messages yet." />
          ) : (
            <div className="space-y-2">
              {keywords.map((k, i) => {
                const max = keywords[0]?.count ?? 1;
                const pct = (k.count / max) * 100;
                return (
                  <div key={k.word} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-5">
                      {i + 1}.
                    </span>
                    <span className="text-sm font-medium min-w-[100px] truncate">
                      {k.word}
                    </span>
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground w-8 text-right">
                      {k.count}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Top products mentioned */}
        <div className="bg-card rounded-xl border p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            Products Recommended by AI
          </h3>
          {products.length === 0 ? (
            <EmptyList text="AI hasn't recommended any products yet." />
          ) : (
            <div className="space-y-2">
              {products.map((p, i) => {
                const max = products[0]?.count ?? 1;
                const pct = (p.count / max) * 100;
                return (
                  <div key={p.name} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-5">
                      {i + 1}.
                    </span>
                    <a
                      href={`${API ? "" : ""}/products?q=${encodeURIComponent(p.name)}`}
                      className="text-sm font-medium min-w-[120px] truncate text-primary hover:underline flex items-center gap-1"
                      title={`Search for ${p.name}`}
                    >
                      <span className="truncate">{p.name}</span>
                      <ExternalLink className="h-3 w-3 opacity-60" />
                    </a>
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-success rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground w-8 text-right">
                      {p.count}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ─── Negative feedback table ─────────────────────────────────── */}
      <div className="bg-card rounded-xl border p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <ThumbsDown className="h-4 w-4 text-destructive" />
            Negative Feedback ({feedbackTotal})
          </h3>
          {feedbackTotal > PAGE_SIZE && (
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={feedbackOffset === 0}
                onClick={() => fetchFeedbackPage(Math.max(0, feedbackOffset - PAGE_SIZE))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs text-muted-foreground px-2">
                {feedbackOffset + 1}–{Math.min(feedbackOffset + PAGE_SIZE, feedbackTotal)} of {feedbackTotal}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={feedbackOffset + PAGE_SIZE >= feedbackTotal}
                onClick={() => fetchFeedbackPage(feedbackOffset + PAGE_SIZE)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
        {feedback.length === 0 ? (
          <EmptyList text="No negative feedback yet — great job! 🎉" />
        ) : (
          <div className="space-y-3">
            {feedback.map((item) => (
              <FeedbackRow key={item.feedbackId} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function StatCard({
  icon, label, value, sub, tint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  tint: string;
}) {
  return (
    <div className={`rounded-xl border p-3 ${tint}`}>
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-xs font-medium opacity-80">{label}</span>
      </div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-[10px] opacity-70 mt-0.5">{sub}</div>}
    </div>
  );
}

function FeedbackRow({ item }: { item: FeedbackItem }) {
  const [expanded, setExpanded] = useState(false);
  // Parse the assistant response the same way the chat UI does.
  const { cleanedContent } = extractFollowups(item.assistantContent);
  const displayContent = stripProductMentionMarkers(cleanedContent);
  const productMentions = extractProductMentions(cleanedContent);

  return (
    <div className="border rounded-lg p-3 bg-destructive/5">
      {/* User question + metadata */}
      <div className="flex items-start gap-2 mb-2">
        <Badge variant="outline" className="text-[10px] bg-background">
          👎 {new Date(item.feedbackAt).toLocaleDateString()}
        </Badge>
        {item.userId && (
          <Badge variant="outline" className="text-[10px] bg-background">
            signed-in
          </Badge>
        )}
      </div>
      {item.userQuestion && (
        <div className="text-xs text-muted-foreground mb-2 italic">
          User asked: "{item.userQuestion}"
        </div>
      )}
      <div className="text-sm">
        {expanded ? (
          <MarkdownText content={displayContent} />
        ) : (
          <p className="line-clamp-3 text-foreground/80">{displayContent}</p>
        )}
      </div>
      {productMentions.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {productMentions.slice(0, 3).map((p) => (
            <span
              key={p}
              className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20"
            >
              {p}
            </span>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-[11px] text-muted-foreground hover:text-foreground mt-2"
      >
        {expanded ? "Show less" : "Show full response"}
      </button>
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
      No activity yet.
    </div>
  );
}

function EmptyList({ text }: { text: string }) {
  return (
    <div className="text-sm text-muted-foreground py-8 text-center">{text}</div>
  );
}
