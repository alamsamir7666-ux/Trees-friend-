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
  Sparkles,
  MessageSquare,
  ThumbsUp,
  ThumbsDown,
  TrendingDown,
  Activity,
  Users,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  X,
  Shield,
  ShieldCheck,
  ShieldAlert,
  Search,
  Brain,
  Zap,
  Database,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useChartColors } from "@/hooks/useChartColors";
import { MarkdownText } from "@/components/ai/MarkdownText";
import {
  extractFollowups,
  extractProductMentions,
  stripProductMentionMarkers,
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

// ─── v5.4: New types for security + topic + search health ───────────────────

interface SecurityHealth {
  enabled: boolean;
  provider: string;
  blockThreshold: number;
  llmSkipThreshold: number;
  llmConfigured: boolean;
  lakeraConfigured: boolean;
  cacheStats: {
    enabled: boolean;
    l1Entries: number;
    l1MaxEntries: number;
    l2Entries: number;
    ttlSeconds: number;
  };
  providers: { name: string; configured: boolean; cost: string }[];
}

interface TopicHealth {
  enabled: boolean;
  llmConfigured: boolean;
  groqConfigured: boolean;
  geminiConfigured: boolean;
  cache: {
    enabled: boolean;
    l1Entries: number;
    l1MaxEntries: number;
    l2Entries: number;
    ttlSeconds: number;
    negativeTtlSeconds: number;
  };
}

interface TopicMetrics {
  hours: number;
  allowedViaLLM: number;
  refusedOffTopic: number;
  totalLLMClassifierCalls: number;
}

interface SearchHealth {
  bm25: {
    available: boolean;
    lastRefreshAt: string | null;
    uniqueTerms: number;
    totalActiveDocs: number;
    avgDocLength: number;
    refreshIntervalHours: number;
  };
  reranker: {
    enabled: boolean;
    provider: string;
    topK: number;
    topN: number;
    timeoutMs: number;
    minScore: number;
    cacheTtlSeconds: number;
    providers: { name: string; configured: boolean }[];
    cache: {
      enabled: boolean;
      l1Entries: number;
      l1MaxEntries: number;
      l2Entries: number;
      ttlSeconds: number;
      negativeTtlSeconds: number;
    };
  };
  weights: {
    semantic: number;
    bm25: number;
    keywordArray: number;
    authority: number;
    priority: number;
    recency: number;
  };
}

interface AttackLogItem {
  id: number;
  sessionId: number;
  type: string;
  payload: {
    score: number;
    attackType: string;
    provider: string;
    explanation?: string;
  } | null;
  createdAt: string;
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

  // v5.4: New state for security + topic + search health
  const [securityHealth, setSecurityHealth] = useState<SecurityHealth | null>(null);
  const [topicHealth, setTopicHealth] = useState<TopicHealth | null>(null);
  const [topicMetrics, setTopicMetrics] = useState<TopicMetrics | null>(null);
  const [searchHealth, setSearchHealth] = useState<SearchHealth | null>(null);
  const [recentAttacks, setRecentAttacks] = useState<AttackLogItem[]>([]);
  const [expandedSection, setExpandedSection] = useState<string | null>(null);

  const PAGE_SIZE = 10;

  const fetchAll = useCallback(async () => {
    const token = await getToken();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

    // Fetch all data in parallel — the new endpoints are included best-effort
    // (if they fail, the section just shows "unavailable" instead of breaking
    // the whole tab).
    const [ov, ts, kw, pr, fb] = await Promise.all([
      fetch(`${API}/api/ai/admin/overview`, { headers }).then((r) => r.json()),
      fetch(`${API}/api/ai/admin/timeseries?days=30`, { headers }).then((r) => r.json()),
      fetch(`${API}/api/ai/admin/top-questions?limit=15`, { headers }).then((r) => r.json()),
      fetch(`${API}/api/ai/admin/top-products?limit=15`, { headers }).then((r) => r.json()),
      fetch(`${API}/api/ai/admin/feedback?rating=down&limit=${PAGE_SIZE}&offset=0`, {
        headers,
      }).then((r) => r.json()),
    ]);

    setOverview(ov);
    setTimeseries(ts.data ?? []);
    setKeywords(kw.keywords ?? []);
    setProducts(pr.products ?? []);
    setFeedback(fb.items ?? []);
    setFeedbackTotal(fb.total ?? 0);
    setFeedbackOffset(0);

    // v5.4: Fetch new health/metrics endpoints (best-effort — don't fail
    // the whole tab if these endpoints are unavailable on older deployments).
    const safeFetch = async <T,>(url: string): Promise<T | null> => {
      try {
        const res = await fetch(`${API}${url}`, { headers });
        if (!res.ok) return null;
        return (await res.json()) as T;
      } catch {
        return null;
      }
    };

    const [secHealth, topHealth, topMetrics, search, attacks] = await Promise.all([
      safeFetch<SecurityHealth>("/api/ai/admin/security/health"),
      safeFetch<TopicHealth>("/api/ai/admin/topic/health"),
      safeFetch<TopicMetrics>("/api/ai/admin/topic/metrics?hours=24"),
      safeFetch<SearchHealth>("/api/ai/admin/kb/search/health"),
      safeFetch<{ attacks: AttackLogItem[] }>("/api/ai/admin/security/attack-log?limit=5"),
    ]);

    setSecurityHealth(secHealth);
    setTopicHealth(topHealth);
    setTopicMetrics(topMetrics);
    setSearchHealth(search);
    setRecentAttacks(attacks?.attacks ?? []);
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
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
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
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
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
                    <span className="text-xs text-muted-foreground w-5">{i + 1}.</span>
                    <span className="text-sm font-medium min-w-[100px] truncate">{k.word}</span>
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground w-8 text-right">{k.count}</span>
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
                    <span className="text-xs text-muted-foreground w-5">{i + 1}.</span>
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
                    <span className="text-xs text-muted-foreground w-8 text-right">{p.count}</span>
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
                {feedbackOffset + 1}–{Math.min(feedbackOffset + PAGE_SIZE, feedbackTotal)} of{" "}
                {feedbackTotal}
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

      {/* ─── v5.4: Security & Topic Classifier Section ──────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Prompt-Injection Defense */}
        <CollapsibleSection
          id="security"
          title="Prompt-Injection Defense"
          icon={<Shield className="h-4 w-4 text-muted-foreground" />}
          expanded={expandedSection === "security"}
          onToggle={() => setExpandedSection(expandedSection === "security" ? null : "security")}
        >
          {!securityHealth ? (
            <EmptyList text="Security health unavailable (deploy v5.2+)." />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                {securityHealth.enabled ? (
                  <Badge variant="outline" className="text-success border-success/30">
                    <ShieldCheck className="h-3 w-3 mr-1" /> Enabled
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-destructive border-destructive/30">
                    <ShieldAlert className="h-3 w-3 mr-1" /> Disabled
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  Provider: <span className="font-medium">{securityHealth.provider}</span>
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-muted/50 rounded p-2">
                  <div className="text-muted-foreground">Block threshold</div>
                  <div className="font-semibold">{securityHealth.blockThreshold}</div>
                </div>
                <div className="bg-muted/50 rounded p-2">
                  <div className="text-muted-foreground">LLM skip threshold</div>
                  <div className="font-semibold">{securityHealth.llmSkipThreshold}</div>
                </div>
              </div>

              <div>
                <div className="text-xs text-muted-foreground mb-1">Providers</div>
                <div className="space-y-1">
                  {securityHealth.providers.map((p) => (
                    <div key={p.name} className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5">
                        {p.configured ? (
                          <CheckCircle2 className="h-3 w-3 text-success" />
                        ) : (
                          <div className="h-3 w-3 rounded-full border border-muted-foreground/30" />
                        )}
                        {p.name}
                      </span>
                      <span className="text-muted-foreground">{p.cost}</span>
                    </div>
                  ))}
                </div>
              </div>

              {recentAttacks.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">
                    Recent blocked attacks ({recentAttacks.length})
                  </div>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {recentAttacks.map((a) => (
                      <div
                        key={a.id}
                        className="text-xs bg-destructive/5 border border-destructive/20 rounded p-2"
                      >
                        <div className="flex items-center justify-between mb-0.5">
                          <Badge
                            variant="outline"
                            className="text-[9px] py-0 h-4 text-destructive border-destructive/30"
                          >
                            {a.payload?.attackType ?? "unknown"}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">
                            score: {a.payload?.score ?? 0}
                          </span>
                        </div>
                        <div className="text-[10px] text-muted-foreground truncate">
                          {a.payload?.explanation ?? "No details"}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CollapsibleSection>

        {/* Topic Classifier */}
        <CollapsibleSection
          id="topic"
          title="Topic Classifier (24h)"
          icon={<Brain className="h-4 w-4 text-muted-foreground" />}
          expanded={expandedSection === "topic"}
          onToggle={() => setExpandedSection(expandedSection === "topic" ? null : "topic")}
        >
          {!topicHealth || !topicMetrics ? (
            <EmptyList text="Topic classifier unavailable (deploy v5.3+)." />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                {topicHealth.enabled ? (
                  <Badge variant="outline" className="text-success border-success/30">
                    <CheckCircle2 className="h-3 w-3 mr-1" /> Active
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-destructive border-destructive/30">
                    Disabled
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  LLM: {topicHealth.llmConfigured ? "configured" : "not configured"}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="bg-muted/50 rounded p-2 text-center">
                  <div className="text-muted-foreground text-[10px]">Allowed via LLM</div>
                  <div className="font-semibold text-success">{topicMetrics.allowedViaLLM}</div>
                </div>
                <div className="bg-muted/50 rounded p-2 text-center">
                  <div className="text-muted-foreground text-[10px]">Refused (off-topic)</div>
                  <div className="font-semibold text-destructive">
                    {topicMetrics.refusedOffTopic}
                  </div>
                </div>
                <div className="bg-muted/50 rounded p-2 text-center">
                  <div className="text-muted-foreground text-[10px]">Total LLM calls</div>
                  <div className="font-semibold">{topicMetrics.totalLLMClassifierCalls}</div>
                </div>
              </div>

              <div className="text-xs text-muted-foreground">
                <Zap className="h-3 w-3 inline mr-1" />
                {topicHealth.groqConfigured
                  ? "Groq"
                  : topicHealth.geminiConfigured
                    ? "Gemini"
                    : "No LLM"}{" "}
                · Cache: L1 {topicHealth.cache.l1Entries}/{topicHealth.cache.l1MaxEntries}, L2{" "}
                {topicHealth.cache.l2Entries}
              </div>

              {topicMetrics.allowedViaLLM > 10 && (
                <div className="text-xs bg-warning/5 border border-warning/20 rounded p-2 flex items-start gap-1.5">
                  <AlertTriangle className="h-3 w-3 text-warning flex-shrink-0 mt-0.5" />
                  <span>
                    {topicMetrics.allowedViaLLM} messages needed LLM classification in 24h. Consider
                    adding more keywords to the fast-path list to save LLM quota.
                  </span>
                </div>
              )}
            </div>
          )}
        </CollapsibleSection>
      </div>

      {/* ─── v5.4: Search Health (BM25 + Reranker) ─────────────────────── */}
      <CollapsibleSection
        id="search"
        title="KB Search Health (BM25 + Reranker)"
        icon={<Search className="h-4 w-4 text-muted-foreground" />}
        expanded={expandedSection === "search"}
        onToggle={() => setExpandedSection(expandedSection === "search" ? null : "search")}
      >
        {!searchHealth ? (
          <EmptyList text="Search health unavailable (deploy v5.0+)." />
        ) : (
          (() => {
            const sh = searchHealth;
            return (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* BM25 */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium">BM25</span>
                    {sh.bm25.available ? (
                      <Badge
                        variant="outline"
                        className="text-success border-success/30 text-[9px] py-0 h-4"
                      >
                        Active
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-warning border-warning/30 text-[9px] py-0 h-4"
                      >
                        Stats empty
                      </Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-muted/50 rounded p-2">
                      <div className="text-muted-foreground">Unique terms</div>
                      <div className="font-semibold">{sh.bm25.uniqueTerms.toLocaleString()}</div>
                    </div>
                    <div className="bg-muted/50 rounded p-2">
                      <div className="text-muted-foreground">Active docs</div>
                      <div className="font-semibold">{sh.bm25.totalActiveDocs}</div>
                    </div>
                    <div className="bg-muted/50 rounded p-2">
                      <div className="text-muted-foreground">Avg doc length</div>
                      <div className="font-semibold">{sh.bm25.avgDocLength.toFixed(1)}</div>
                    </div>
                    <div className="bg-muted/50 rounded p-2">
                      <div className="text-muted-foreground">Refresh interval</div>
                      <div className="font-semibold">{sh.bm25.refreshIntervalHours}h</div>
                    </div>
                  </div>
                  {sh.bm25.lastRefreshAt && (
                    <div className="text-[10px] text-muted-foreground">
                      Last refresh: {new Date(sh.bm25.lastRefreshAt).toLocaleString()}
                    </div>
                  )}
                </div>

                {/* Reranker */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium">Reranker</span>
                    {sh.reranker.enabled ? (
                      <Badge
                        variant="outline"
                        className="text-success border-success/30 text-[9px] py-0 h-4"
                      >
                        Enabled
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-muted-foreground text-[9px] py-0 h-4"
                      >
                        Disabled
                      </Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-muted/50 rounded p-2">
                      <div className="text-muted-foreground">Provider</div>
                      <div className="font-semibold">{sh.reranker.provider}</div>
                    </div>
                    <div className="bg-muted/50 rounded p-2">
                      <div className="text-muted-foreground">Top-K → Top-N</div>
                      <div className="font-semibold">
                        {sh.reranker.topK} → {sh.reranker.topN}
                      </div>
                    </div>
                    <div className="bg-muted/50 rounded p-2">
                      <div className="text-muted-foreground">Timeout</div>
                      <div className="font-semibold">{sh.reranker.timeoutMs}ms</div>
                    </div>
                    <div className="bg-muted/50 rounded p-2">
                      <div className="text-muted-foreground">Cache TTL</div>
                      <div className="font-semibold">{sh.reranker.cacheTtlSeconds}s</div>
                    </div>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {sh.reranker.providers.map((p: { name: string; configured: boolean }) => (
                      <Badge
                        key={p.name}
                        variant="outline"
                        className={`text-[9px] py-0 h-4 ${
                          p.configured ? "text-success border-success/30" : "text-muted-foreground"
                        }`}
                      >
                        {p.name}: {p.configured ? "on" : "off"}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            );
          })()
        )}
      </CollapsibleSection>

      {/* ─── Conversations browser (v2.5) ──────────────────────────────── */}
      <ConversationsSection />
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function StatCard({
  icon,
  label,
  value,
  sub,
  tint,
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
  return <div className="text-sm text-muted-foreground py-8 text-center">{text}</div>;
}

// ─── v5.4: CollapsibleSection for the new health/metrics sections ───────────

function CollapsibleSection({
  id,
  title,
  icon,
  expanded,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card rounded-xl border">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors"
        aria-expanded={expanded}
        aria-controls={`section-${id}`}
      >
        <h3 className="text-sm font-semibold flex items-center gap-2">
          {icon}
          {title}
        </h3>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div id={`section-${id}`} className="px-4 pb-4">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Conversations browser (v2.5) ───────────────────────────────────────

interface ConversationListItem {
  id: number;
  sessionToken: string;
  title: string | null;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  positiveFeedback: number;
  negativeFeedback: number;
  lastMessage: string | null;
  lastMessageAt: string | null;
}

interface ConversationMessage {
  id: number;
  role: string;
  content: string;
  createdAt: string;
  offTopic: boolean;
  greeting: boolean;
  feedback: { rating: string; comment: string | null; created_at: string } | null;
}

function ConversationsSection() {
  const { getToken } = useAuth();
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [thread, setThread] = useState<ConversationMessage[] | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const PAGE = 10;

  const fetchPage = useCallback(
    async (newOffset: number) => {
      setLoading(true);
      try {
        const token = await getToken();
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        const res = await fetch(
          `${API}/api/ai/admin/conversations?limit=${PAGE}&offset=${newOffset}`,
          { headers },
        );
        const data = await res.json();
        setConversations(data.conversations ?? []);
        setTotal(data.total ?? 0);
        setOffset(newOffset);
      } finally {
        setLoading(false);
      }
    },
    [getToken],
  );

  useEffect(() => {
    fetchPage(0);
  }, [fetchPage]);

  const openConversation = async (id: number) => {
    setSelectedId(id);
    setThreadLoading(true);
    setThread(null);
    try {
      const token = await getToken();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`${API}/api/ai/admin/conversations/${id}`, { headers });
      const data = await res.json();
      setThread(data.messages ?? []);
    } finally {
      setThreadLoading(false);
    }
  };

  return (
    <div className="bg-card rounded-xl border p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          All Conversations ({total})
        </h3>
        {total > PAGE && (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || loading}
              onClick={() => fetchPage(Math.max(0, offset - PAGE))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs text-muted-foreground px-2">
              {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE >= total || loading}
              onClick={() => fetchPage(offset + PAGE)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : conversations.length === 0 ? (
        <EmptyList text="No conversations yet." />
      ) : (
        <div className="space-y-2">
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => openConversation(c.id)}
              className="w-full text-left border rounded-lg p-3 hover:bg-muted/40 transition-colors"
            >
              <div className="flex items-start justify-between gap-2 mb-1">
                <span className="text-sm font-medium truncate flex-1">
                  {c.title ?? "(no title)"}
                </span>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {c.messageCount} msgs
                </span>
              </div>
              {c.lastMessage && (
                <p className="text-xs text-muted-foreground truncate">{c.lastMessage}</p>
              )}
              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-[10px] text-muted-foreground">
                  {new Date(c.updatedAt).toLocaleDateString()}
                </span>
                {c.userId && (
                  <Badge variant="outline" className="text-[9px] py-0 h-4">
                    signed-in
                  </Badge>
                )}
                {c.positiveFeedback > 0 && (
                  <Badge
                    variant="outline"
                    className="text-[9px] py-0 h-4 text-success border-success/30"
                  >
                    👍 {c.positiveFeedback}
                  </Badge>
                )}
                {c.negativeFeedback > 0 && (
                  <Badge
                    variant="outline"
                    className="text-[9px] py-0 h-4 text-destructive border-destructive/30"
                  >
                    👎 {c.negativeFeedback}
                  </Badge>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* ─── Conversation detail dialog ──────────────────────────────── */}
      {selectedId && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => {
            setSelectedId(null);
            setThread(null);
          }}
        >
          <div
            className="bg-background rounded-xl border max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h3 className="text-sm font-semibold">Conversation #{selectedId}</h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelectedId(null);
                  setThread(null);
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {threadLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-16" />
                  ))}
                </div>
              ) : thread && thread.length > 0 ? (
                thread.map((m) => (
                  <div
                    key={m.id}
                    className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                        m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted border"
                      }`}
                    >
                      <div className="whitespace-pre-wrap break-words">{m.content}</div>
                      {m.offTopic && (
                        <div className="text-[10px] opacity-70 mt-1">⚠ off-topic refusal</div>
                      )}
                      {m.greeting && (
                        <div className="text-[10px] opacity-70 mt-1">👋 greeting shortcut</div>
                      )}
                      {m.feedback && (
                        <div className="text-[10px] mt-1 opacity-70">
                          {m.feedback.rating === "up" ? "👍 rated" : "👎 rated"}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <EmptyList text="No messages in this conversation." />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
