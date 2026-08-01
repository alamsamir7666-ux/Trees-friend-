import { useMemo, useState, type ReactNode } from "react";
import {
  Search,
  MessageSquare,
  Star,
  Trash2,
  Inbox,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  MessagesSquare,
} from "lucide-react";
import { useAdminContext } from "@/contexts/AdminContext";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationEllipsis,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

// ─── Types ────────────────────────────────────────────────────────────────────

type Review = {
  id: number;
  productId: number;
  userId: string;
  userName: string;
  rating: number;
  comment: string;
  createdAt: string;
  productName: string;
  productImage?: string | null;
};

type RatingFilter = 0 | 1 | 2 | 3 | 4 | 5; // 0 = All
type SortKey = "newest" | "oldest" | "highest" | "lowest";

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

const RATING_TABS: { value: RatingFilter; label: string }[] = [
  { value: 0, label: "All" },
  { value: 5, label: "5★" },
  { value: 4, label: "4★" },
  { value: 3, label: "3★" },
  { value: 2, label: "2★" },
  { value: 1, label: "1★" },
];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "highest", label: "Highest rating" },
  { value: "lowest", label: "Lowest rating" },
];

// ─── Small layout primitives ──────────────────────────────────────────────────

function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
}: {
  title: string;
  description: string;
  icon: React.ElementType;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-5">
      <div className="flex items-start gap-3 min-w-0">
        <div className="hidden sm:flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">{description}</p>
        </div>
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ElementType;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground mb-3">
        <Icon className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** "Showing 1–10 of 1,234" range summary. */
function rangeText(page: number, pageSize: number, total: number) {
  if (total === 0) return "No results";
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`;
}

/** Page-number list with ellipses: 1 … 4 5 6 … 20. */
function pageList(current: number, totalPages: number): (number | "...")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const pages: (number | "...")[] = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(totalPages - 1, current + 1);
  if (left > 2) pages.push("...");
  for (let i = left; i <= right; i++) pages.push(i);
  if (right < totalPages - 1) pages.push("...");
  pages.push(totalPages);
  return pages;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Compact 5-star row — gold for filled, muted for empty. */
function StarsRow({ rating, size = "sm" }: { rating: number; size?: "sm" | "md" }) {
  const dim = size === "md" ? "h-4 w-4" : "h-3.5 w-3.5";
  return (
    <div className="inline-flex items-center gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={`${dim} ${
            i < rating
              ? "fill-amber-400 text-amber-400"
              : "fill-muted-foreground/10 text-muted-foreground/30"
          }`}
        />
      ))}
    </div>
  );
}

/**
 * Rating distribution panel — Amazon/Shopify style.
 * Shows a horizontal bar per rating tier (5★→1★) with proportional fill
 * and a count. Clicking a row filters the list to that rating.
 */
function RatingDistributionCard({
  ratingCounts,
  total,
  activeFilter,
  onSelect,
}: {
  ratingCounts: Record<1 | 2 | 3 | 4 | 5, number>;
  total: number;
  activeFilter: RatingFilter;
  onSelect: (r: RatingFilter) => void;
}) {
  const tiers: (1 | 2 | 3 | 4 | 5)[] = [5, 4, 3, 2, 1];
  return (
    <Card>
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-col lg:flex-row lg:items-center gap-5">
          {/* Aggregate */}
          <div className="flex items-center gap-4 lg:border-r lg:pr-6 lg:border-border shrink-0">
            <div className="text-center">
              <div className="text-3xl font-semibold tabular-nums text-foreground leading-none">
                {total > 0
                  ? (
                      tiers.reduce((s, t) => s + t * ratingCounts[t], 0) / total
                    ).toFixed(1)
                  : "—"}
              </div>
              <div className="mt-1.5 flex justify-center">
                <StarsRow
                  rating={Math.round(
                    total > 0
                      ? tiers.reduce((s, t) => s + t * ratingCounts[t], 0) / total
                      : 0,
                  )}
                  size="md"
                />
              </div>
              <div className="text-[11px] text-muted-foreground mt-1 tabular-nums">
                {total.toLocaleString()} {total === 1 ? "review" : "reviews"}
              </div>
            </div>
          </div>

          {/* Distribution bars */}
          <div className="flex-1 min-w-0 space-y-1.5">
            {tiers.map((tier) => {
              const count = ratingCounts[tier];
              const pct = total > 0 ? (count / total) * 100 : 0;
              const isActive = activeFilter === tier;
              return (
                <button
                  key={tier}
                  type="button"
                  onClick={() => onSelect(isActive ? 0 : tier)}
                  className={`group w-full flex items-center gap-3 rounded-md px-2 py-1 -mx-2 transition-colors ${
                    isActive ? "bg-primary/5" : "hover:bg-muted/40"
                  }`}
                  aria-pressed={isActive}
                  title={
                    isActive
                      ? `Clear ${tier}-star filter`
                      : `Filter to ${tier}-star reviews (${count})`
                  }
                >
                  <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground w-9 shrink-0">
                    {tier}
                    <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                  </span>
                  <span className="relative flex-1 h-2 rounded-full bg-muted overflow-hidden">
                    <span
                      className="absolute inset-y-0 left-0 rounded-full bg-amber-400/80 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground w-10 text-right shrink-0">
                    {count.toLocaleString()}
                  </span>
                  {isActive && (
                    <span className="text-[10px] font-medium text-primary shrink-0 w-14 text-right">
                      Filtered
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

/**
 * Admin Reviews tab — customer review moderation queue.
 *
 * Industry-standard layout: page header with aggregate stat, rating
 * distribution card (clickable to filter), rating tabs + sort + live
 * search toolbar, a compact table with avatar/star/expandable comment,
 * and full client-side pagination with page-size selector. The backend
 * `listAllReviews` endpoint returns all reviews in one array (no
 * server-side pagination), so we paginate client-side — which is fine
 * for an admin moderation tool and means the filter/sort/distribution
 * panel always reflects the full dataset.
 */
export function ReviewsTab() {
  const { reviews, reviewsLoading, handleDeleteReview } = useAdminContext();

  // Local UI state — filter / sort / search / pagination all live here so
  // this tab is fully self-contained and easy to reason about.
  const [search, setSearch] = useState("");
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>(0);
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(10);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Aggregate stats computed across ALL reviews (not affected by filter).
  // Recomputed only when the reviews array reference changes.
  const { totalCount, ratingCounts } = useMemo(() => {
    const all = (reviews as Review[]) ?? [];
    const counts: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of all) {
      const rating = Math.max(1, Math.min(5, Math.round(Number(r.rating) || 0))) as 1 | 2 | 3 | 4 | 5;
      counts[rating]++;
    }
    return { totalCount: all.length, ratingCounts: counts };
  }, [reviews]);

  // Apply rating filter + search + sort.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const arr = ((reviews as Review[]) ?? []).filter((r) => {
      if (ratingFilter !== 0 && Math.round(Number(r.rating) || 0) !== ratingFilter) return false;
      if (!q) return true;
      return (
        `${r.productName ?? ""}`.toLowerCase().includes(q) ||
        `${r.userName ?? ""}`.toLowerCase().includes(q) ||
        `${r.comment ?? ""}`.toLowerCase().includes(q)
      );
    });

    arr.sort((a, b) => {
      switch (sortKey) {
        case "newest":
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case "oldest":
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case "highest":
          return Number(b.rating) - Number(a.rating);
        case "lowest":
          return Number(a.rating) - Number(b.rating);
        default:
          return 0;
      }
    });
    return arr;
  }, [reviews, search, ratingFilter, sortKey]);

  // Pagination math.
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const startIdx = (currentPage - 1) * pageSize;
  const paginated = filtered.slice(startIdx, startIdx + pageSize);

  // State mutators that also reset the page back to 1 (so the user never
  // ends up on an empty out-of-range page after changing filters).
  function changeRatingFilter(next: RatingFilter) {
    setRatingFilter(next);
    setPage(1);
    setExpandedId(null);
  }
  function changeSort(next: SortKey) {
    setSortKey(next);
    setPage(1);
  }
  function changePageSize(next: number) {
    setPageSize(next);
    setPage(1);
  }
  function changeSearch(v: string) {
    setSearch(v);
    setPage(1);
  }
  function resetFilters() {
    setSearch("");
    setRatingFilter(0);
    setSortKey("newest");
    setPage(1);
    setExpandedId(null);
  }
  function toggleExpand(id: number) {
    setExpandedId((cur) => (cur === id ? null : id));
  }

  const hasActiveFilters = search.trim() !== "" || ratingFilter !== 0 || sortKey !== "newest";

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <PageHeader
        title="Customer Reviews"
        description="Moderate every customer review across the marketplace. Search, filter by rating, sort, and remove anything that violates policy."
        icon={MessageSquare}
        actions={
          <Badge variant="outline" className="gap-1.5 px-2.5 py-1">
            <MessagesSquare className="h-3 w-3" />
            <span className="tabular-nums">{totalCount.toLocaleString()}</span>
            <span className="text-muted-foreground font-normal">
              {totalCount === 1 ? "review" : "reviews"}
            </span>
          </Badge>
        }
      />

      {/* Rating distribution + aggregate */}
      {!reviewsLoading && totalCount > 0 && (
        <RatingDistributionCard
          ratingCounts={ratingCounts}
          total={totalCount}
          activeFilter={ratingFilter}
          onSelect={changeRatingFilter}
        />
      )}

      {/* Toolbar: rating tabs + sort + search */}
      <div className="flex flex-col gap-3">
        <Tabs
          value={String(ratingFilter)}
          onValueChange={(v) => changeRatingFilter(Number(v) as RatingFilter)}
        >
          <TabsList className="rounded-lg bg-muted/50 p-1 w-full sm:w-auto overflow-x-auto">
            {RATING_TABS.map((t) => {
              const count =
                t.value === 0 ? totalCount : ratingCounts[t.value as 1 | 2 | 3 | 4 | 5];
              const isActive = ratingFilter === t.value;
              return (
                <TabsTrigger
                  key={t.value}
                  value={String(t.value)}
                  className="rounded-md text-xs gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
                >
                  {t.label}
                  <span
                    className={
                      "inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold tabular-nums " +
                      (isActive ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")
                    }
                  >
                    {count.toLocaleString()}
                  </span>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>

        <div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
          <div className="relative sm:max-w-xs flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
            <Input
              value={search}
              onChange={(e) => changeSearch(e.target.value)}
              placeholder="Search by product, customer, or review text…"
              className="h-9 pl-8 text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <Select value={sortKey} onValueChange={(v) => changeSort(v as SortKey)}>
              <SelectTrigger className="h-9 w-[160px] text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-sm">
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hasActiveFilters && (
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 text-xs"
                onClick={resetFilters}
                title="Reset filters"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {reviewsLoading ? (
            <div className="space-y-2 p-4 sm:p-5">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-14 rounded-lg bg-muted/40 animate-pulse" />
              ))}
            </div>
          ) : paginated.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title={
                hasActiveFilters
                  ? "No reviews match your filters"
                  : totalCount === 0
                    ? "No reviews yet"
                    : "No reviews on this page"
              }
              description={
                hasActiveFilters
                  ? "Try clearing the search or switching to a different rating filter."
                  : "When customers start leaving reviews, they'll appear here for moderation."
              }
              action={
                hasActiveFilters ? (
                  <Button variant="outline" size="sm" onClick={resetFilters} className="gap-1.5">
                    <RotateCcw className="h-3.5 w-3.5" />
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 border-b">
                  <tr>
                    <th className="px-4 sm:px-5 py-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Product
                    </th>
                    <th className="px-4 sm:px-5 py-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Customer
                    </th>
                    <th className="px-4 sm:px-5 py-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                      Rating
                    </th>
                    <th className="px-4 sm:px-5 py-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Review
                    </th>
                    <th className="px-4 sm:px-5 py-3 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                      Date
                    </th>
                    <th className="px-4 sm:px-5 py-3 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {paginated.map((r) => {
                    const rating = Math.max(1, Math.min(5, Math.round(Number(r.rating) || 0)));
                    const isExpanded = expandedId === r.id;
                    const isLong = (r.comment?.length ?? 0) > 180;
                    return (
                      <tr key={r.id} className="align-top hover:bg-muted/20 transition-colors">
                        {/* Product */}
                        <td className="px-4 sm:px-5 py-3.5">
                          <div className="flex items-center gap-3 min-w-[180px]">
                            {r.productImage ? (
                              <img
                                src={r.productImage}
                                alt=""
                                loading="lazy"
                                className="h-10 w-10 rounded-lg object-cover border shrink-0"
                              />
                            ) : (
                              <div className="h-10 w-10 rounded-lg bg-muted border shrink-0 flex items-center justify-center">
                                <MessageSquare className="h-4 w-4 text-muted-foreground/50" />
                              </div>
                            )}
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-foreground leading-tight line-clamp-2">
                                {r.productName}
                              </p>
                              <p className="text-[11px] text-muted-foreground/70 mt-0.5 tabular-nums">
                                #{r.productId}
                              </p>
                            </div>
                          </div>
                        </td>

                        {/* Customer */}
                        <td className="px-4 sm:px-5 py-3.5">
                          <div className="flex items-center gap-2 min-w-[140px]">
                            <div className="h-7 w-7 rounded-full bg-gradient-to-br from-primary/25 to-primary/45 flex items-center justify-center shrink-0">
                              <span className="text-[11px] font-semibold text-primary-foreground">
                                {(r.userName?.[0] ?? "?").toUpperCase()}
                              </span>
                            </div>
                            <span className="text-xs font-medium text-foreground truncate">
                              {r.userName}
                            </span>
                          </div>
                        </td>

                        {/* Rating */}
                        <td className="px-4 sm:px-5 py-3.5">
                          <div className="flex flex-col gap-1">
                            <StarsRow rating={rating} />
                            <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                              {rating}/5
                            </span>
                          </div>
                        </td>

                        {/* Review text */}
                        <td className="px-4 sm:px-5 py-3.5 max-w-[320px]">
                          <p
                            className={`text-xs text-muted-foreground leading-relaxed ${
                              isExpanded ? "" : isLong ? "line-clamp-2" : "line-clamp-3"
                            }`}
                          >
                            {r.comment}
                          </p>
                          {isLong && (
                            <button
                              type="button"
                              onClick={() => toggleExpand(r.id)}
                              className="mt-1 inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline"
                            >
                              {isExpanded ? (
                                <>
                                  Show less <ChevronUp className="h-3 w-3" />
                                </>
                              ) : (
                                <>
                                  Show more <ChevronDown className="h-3 w-3" />
                                </>
                              )}
                            </button>
                          )}
                        </td>

                        {/* Date */}
                        <td className="px-4 sm:px-5 py-3.5 text-right text-xs text-muted-foreground/80 whitespace-nowrap tabular-nums">
                          {formatDate(r.createdAt)}
                        </td>

                        {/* Actions */}
                        <td className="px-4 sm:px-5 py-3.5 text-right">
                          <button
                            type="button"
                            onClick={() => handleDeleteReview(r.productId, r.id)}
                            className="p-1.5 rounded-md text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 transition-colors"
                            title="Delete review"
                            aria-label="Delete review"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination footer */}
          {!reviewsLoading && filtered.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 py-3 border-t bg-muted/20">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="tabular-nums">{rangeText(currentPage, pageSize, filtered.length)}</span>
                <span className="hidden sm:inline text-muted-foreground/40">·</span>
                <div className="hidden sm:flex items-center gap-1.5">
                  <span>Rows:</span>
                  <Select
                    value={String(pageSize)}
                    onValueChange={(v) => changePageSize(Number(v))}
                  >
                    <SelectTrigger className="h-7 w-[68px] text-xs px-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAGE_SIZE_OPTIONS.map((n) => (
                        <SelectItem key={n} value={String(n)} className="text-xs">
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {totalPages > 1 && (
                <Pagination className="mx-0 w-auto justify-end">
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setPage(Math.max(1, currentPage - 1));
                          setExpandedId(null);
                        }}
                        aria-disabled={currentPage === 1}
                        className={currentPage === 1 ? "pointer-events-none opacity-50" : ""}
                      />
                    </PaginationItem>
                    {pageList(currentPage, totalPages).map((p, i) =>
                      p === "..." ? (
                        <PaginationItem key={`ellipsis-${i}`}>
                          <PaginationEllipsis />
                        </PaginationItem>
                      ) : (
                        <PaginationItem key={p}>
                          <PaginationLink
                            href="#"
                            isActive={p === currentPage}
                            onClick={(e) => {
                              e.preventDefault();
                              setPage(p);
                              setExpandedId(null);
                            }}
                          >
                            {p}
                          </PaginationLink>
                        </PaginationItem>
                      ),
                    )}
                    <PaginationItem>
                      <PaginationNext
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setPage(Math.min(totalPages, currentPage + 1));
                          setExpandedId(null);
                        }}
                        aria-disabled={currentPage === totalPages}
                        className={currentPage === totalPages ? "pointer-events-none opacity-50" : ""}
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
