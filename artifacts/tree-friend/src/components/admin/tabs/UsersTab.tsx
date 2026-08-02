import { useMemo, useState, type ReactNode } from "react";
import {
  Search,
  Users as UsersIcon,
  UserCheck,
  Ban,
  ShoppingCart,
  Calendar,
  Inbox,
  RotateCcw,
  Shield,
  Crown,
} from "lucide-react";
import { useAdminContext } from "@/contexts/AdminContext";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

type User = {
  id: number;
  clerkId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  role: string;
  isBlocked: boolean;
  orderCount: number;
  createdAt: string;
};

type StatusFilter = "all" | "active" | "blocked";
type SortKey = "newest" | "oldest" | "most_orders" | "name_az";

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All users" },
  { value: "active", label: "Active only" },
  { value: "blocked", label: "Blocked only" },
];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "most_orders", label: "Most orders" },
  { value: "name_az", label: "Name (A–Z)" },
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

function rangeText(page: number, pageSize: number, total: number) {
  if (total === 0) return "No results";
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`;
}

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

/** Build initials from name, falling back to email or phone. */
function getInitials(u: User): string {
  const f = (u.firstName ?? "").trim();
  const l = (u.lastName ?? "").trim();
  if (f || l) return `${f[0] ?? ""}${l[0] ?? ""}`.toUpperCase();
  if (u.email && !u.email.endsWith("@clerk.user")) return u.email[0].toUpperCase();
  if (u.phone) return u.phone.slice(-2);
  return "?";
}

/** Display name — falls back across name → email → phone → "Unknown". */
function getDisplayName(u: User): string {
  const f = (u.firstName ?? "").trim();
  const l = (u.lastName ?? "").trim();
  if (f || l) return `${f} ${l}`.trim();
  if (u.email && !u.email.endsWith("@clerk.user")) return u.email;
  if (u.phone) return u.phone;
  return "Unknown User";
}

/** Display email — hides the internal "@clerk.user" placeholder. */
function getDisplayEmail(u: User): string | null {
  if (!u.email) return null;
  if (u.email.endsWith("@clerk.user")) return null;
  return u.email;
}

function isClerkPlaceholderEmail(u: User): boolean {
  return !u.email || u.email.endsWith("@clerk.user");
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Four small stat cards showing the user-base breakdown:
 * Total / Active / Blocked / New this month.
 *
 * Clicking a card sets the matching status filter so admins can drill in
 * (the "New this month" card is informational only — no filter).
 */
function StatsRow({
  total,
  activeCount,
  blockedCount,
  newThisMonthCount,
  statusFilter,
  onStatusChange,
}: {
  total: number;
  activeCount: number;
  blockedCount: number;
  newThisMonthCount: number;
  statusFilter: StatusFilter;
  onStatusChange: (s: StatusFilter) => void;
}) {
  const cards: {
    label: string;
    value: number;
    icon: React.ElementType;
    iconClass: string;
    active: boolean;
    onClick?: () => void;
  }[] = [
    {
      label: "Total users",
      value: total,
      icon: UsersIcon,
      iconClass: "bg-muted text-muted-foreground",
      active: statusFilter === "all",
      onClick: () => onStatusChange("all"),
    },
    {
      label: "Active",
      value: activeCount,
      icon: UserCheck,
      iconClass: "bg-success/15 text-success-foreground",
      active: statusFilter === "active",
      onClick: () => onStatusChange("active"),
    },
    {
      label: "Blocked",
      value: blockedCount,
      icon: Ban,
      iconClass: "bg-destructive/15 text-destructive",
      active: statusFilter === "blocked",
      onClick: () => onStatusChange("blocked"),
    },
    {
      label: "New this month",
      value: newThisMonthCount,
      icon: Calendar,
      iconClass: "bg-primary/10 text-primary",
      active: false,
      // Informational only — no filter to apply.
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((c) => (
        <button
          key={c.label}
          type="button"
          onClick={c.onClick}
          disabled={!c.onClick}
          className={`text-left rounded-lg border bg-card px-3 py-2.5 flex items-center gap-2.5 transition-colors ${
            c.active
              ? "ring-1 ring-primary/40 bg-primary/5"
              : c.onClick
                ? "hover:bg-muted/40"
                : "cursor-default"
          }`}
          aria-pressed={c.active}
        >
          <div className={`h-8 w-8 rounded-md flex items-center justify-center shrink-0 ${c.iconClass}`}>
            <c.icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wide font-medium truncate">
              {/* Shorter label on mobile so it fits in the 2-col grid */}
              <span className="lg:hidden">
                {c.label === "New this month" ? "New (30d)" : c.label}
              </span>
              <span className="hidden lg:inline">{c.label}</span>
            </div>
            <div className="text-sm font-semibold text-foreground tabular-nums">
              {c.value.toLocaleString()}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

/**
 * Admin Users tab — customer directory + moderation queue.
 *
 * Layout (matches the Reviews tab's design language for consistency):
 * - Page header with total-count badge
 * - 4 stat cards: Total / Active / Blocked / New this month (clickable to filter)
 * - Toolbar: search + status filter + sort + reset
 * - Desktop (lg+): table with User / Contact / Role / Orders / Joined / Actions
 * - Mobile/tablet: stacked card list
 * - Full client-side pagination with page-size selector
 */
export function UsersTab() {
  const {
    users,
    usersLoading,
    userSearch,
    setUserSearch,
    debouncedUserSearch,
    setActiveTab,
    setOrderSearch,
    handleToggleBlock,
  } = useAdminContext();

  // Local UI state.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(10);

  // Aggregate stats — computed across ALL users, not affected by filters.
  const { totalCount, activeCount, blockedCount, newThisMonthCount } = useMemo(() => {
    const all = (users as User[]) ?? [];
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    let blocked = 0;
    let newThisMonth = 0;
    for (const u of all) {
      if (u.isBlocked) blocked++;
      if (new Date(u.createdAt) >= startOfMonth) newThisMonth++;
    }
    return {
      totalCount: all.length,
      activeCount: all.length - blocked,
      blockedCount: blocked,
      newThisMonthCount: newThisMonth,
    };
  }, [users]);

  // Apply status filter + search + sort.
  const filtered = useMemo(() => {
    const q = debouncedUserSearch.trim().toLowerCase();
    const arr = ((users as User[]) ?? []).filter((u) => {
      if (statusFilter === "active" && u.isBlocked) return false;
      if (statusFilter === "blocked" && !u.isBlocked) return false;
      if (!q) return true;
      const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.toLowerCase();
      const email = (u.email ?? "").toLowerCase();
      const phone = (u.phone ?? "").toLowerCase();
      return name.includes(q) || email.includes(q) || phone.includes(q);
    });

    arr.sort((a, b) => {
      switch (sortKey) {
        case "newest":
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case "oldest":
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case "most_orders":
          return Number(b.orderCount ?? 0) - Number(a.orderCount ?? 0);
        case "name_az":
          return getDisplayName(a).localeCompare(getDisplayName(b));
        default:
          return 0;
      }
    });
    return arr;
  }, [users, debouncedUserSearch, statusFilter, sortKey]);

  // Pagination math.
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const startIdx = (currentPage - 1) * pageSize;
  const paginated = filtered.slice(startIdx, startIdx + pageSize);

  // State mutators that reset the page back to 1.
  function changeStatusFilter(next: StatusFilter) {
    setStatusFilter(next);
    setPage(1);
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
    setUserSearch(v);
    setPage(1);
  }
  function resetFilters() {
    setUserSearch("");
    setStatusFilter("all");
    setSortKey("newest");
    setPage(1);
  }

  const hasActiveFilters =
    debouncedUserSearch.trim() !== "" || statusFilter !== "all" || sortKey !== "newest";

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 min-w-0">
      <PageHeader
        title="Users"
        description="Browse every customer on the marketplace, see their order history at a glance, and block or unblock accounts that violate policy."
        icon={UsersIcon}
        actions={
          <Badge variant="outline" className="gap-1.5 px-2.5 py-1">
            <UsersIcon className="h-3 w-3" />
            <span className="tabular-nums">{totalCount.toLocaleString()}</span>
            <span className="text-muted-foreground font-normal">
              {totalCount === 1 ? "user" : "users"}
            </span>
          </Badge>
        }
      />

      {/* Stat cards — clickable to filter */}
      {!usersLoading && totalCount > 0 && (
        <StatsRow
          total={totalCount}
          activeCount={activeCount}
          blockedCount={blockedCount}
          newThisMonthCount={newThisMonthCount}
          statusFilter={statusFilter}
          onStatusChange={changeStatusFilter}
        />
      )}

      {/* Toolbar: search + status filter + sort + reset
          Same responsive pattern as Reviews tab — stacked on mobile, single
          row on desktop. */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
          <Input
            value={userSearch}
            onChange={(e) => changeSearch(e.target.value)}
            placeholder="Search by name, email, or phone…"
            className="h-9 pl-8 text-sm"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => changeStatusFilter(v as StatusFilter)}>
          <SelectTrigger className="h-9 w-full sm:w-[160px] text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTER_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value} className="text-sm">
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 sm:shrink-0">
          <Select value={sortKey} onValueChange={(v) => changeSort(v as SortKey)}>
            <SelectTrigger className="h-9 w-full sm:w-[160px] text-sm flex-1 sm:flex-none">
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
              className="h-9 shrink-0 gap-1.5 text-xs px-2 sm:px-3"
              onClick={resetFilters}
              title="Reset filters"
              aria-label="Reset filters"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Reset</span>
            </Button>
          )}
        </div>
      </div>

      {/* List — card layout on mobile/tablet, table on lg+ */}
      <Card>
        <CardContent className="p-0">
          {usersLoading ? (
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
                  ? "No users match your filters"
                  : totalCount === 0
                    ? "No users yet"
                    : "No users on this page"
              }
              description={
                hasActiveFilters
                  ? "Try clearing the search or switching to a different status filter."
                  : "When customers sign up, they'll appear here."
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
            <>
              {/* ── Mobile / tablet: card list ─────────────────────────────── */}
              <ul className="lg:hidden divide-y divide-border/70">
                {paginated.map((u) => {
                  const displayName = getDisplayName(u);
                  const initials = getInitials(u);
                  const email = getDisplayEmail(u);
                  const isAdmin = u.role === "admin";
                  return (
                    <li key={u.id} className={`p-4 ${u.isBlocked ? "opacity-60" : ""}`}>
                      <div className="flex items-start gap-3">
                        <div
                          className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 ${
                            u.isBlocked
                              ? "bg-destructive/15 text-destructive"
                              : "bg-primary/15 text-primary"
                          }`}
                        >
                          <span className="text-xs font-semibold">{initials}</span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium text-foreground truncate">
                              {displayName}
                            </p>
                            {isAdmin && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                                <Crown className="h-3 w-3" />
                                Admin
                              </span>
                            )}
                            {u.isBlocked && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive">
                                <Ban className="h-3 w-3" />
                                Blocked
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-0.5 truncate tabular-nums">
                            {email ?? u.phone ?? "No contact info"}
                          </p>
                          <div className="mt-2 flex items-center gap-2 flex-wrap">
                            <button
                              onClick={() => {
                                const term = email ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
                                setUserSearch("");
                                setActiveTab("orders");
                                setTimeout(() => setOrderSearch(term), 50);
                              }}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-info/10 text-info-foreground text-[11px] font-semibold hover:bg-info/20 transition-colors"
                            >
                              <ShoppingCart className="h-3 w-3" />
                              {u.orderCount ?? 0} orders
                            </button>
                            <span className="text-[11px] text-muted-foreground/70">
                              Joined {formatDate(u.createdAt)}
                            </span>
                          </div>
                        </div>
                        {!isAdmin && (
                          <button
                            onClick={() => handleToggleBlock(u.id, !u.isBlocked)}
                            className={`p-1.5 -mr-1 rounded-md transition-colors shrink-0 ${
                              u.isBlocked
                                ? "text-muted-foreground/70 hover:text-success-foreground hover:bg-success/10"
                                : "text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10"
                            }`}
                            title={u.isBlocked ? "Unblock user" : "Block user"}
                            aria-label={u.isBlocked ? "Unblock user" : "Block user"}
                          >
                            {u.isBlocked ? (
                              <UserCheck className="h-4 w-4" />
                            ) : (
                              <Ban className="h-4 w-4" />
                            )}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>

              {/* ── Desktop: table ─────────────────────────────────────────── */}
              <div className="hidden lg:block overflow-x-auto">
                <table className="w-full text-sm min-w-[820px]">
                  <thead className="bg-muted/40 border-b">
                    <tr>
                      <th className="px-4 sm:px-5 py-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                        User
                      </th>
                      <th className="px-4 sm:px-5 py-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                        Contact
                      </th>
                      <th className="px-4 sm:px-5 py-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                        Role
                      </th>
                      <th className="px-4 sm:px-5 py-3 text-center text-[11px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                        Orders
                      </th>
                      <th className="px-4 sm:px-5 py-3 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                        Joined
                      </th>
                      <th className="px-4 sm:px-5 py-3 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/70">
                    {paginated.map((u) => {
                      const displayName = getDisplayName(u);
                      const initials = getInitials(u);
                      const email = getDisplayEmail(u);
                      const isAdmin = u.role === "admin";
                      return (
                        <tr
                          key={u.id}
                          className={`align-top hover:bg-muted/20 transition-colors ${u.isBlocked ? "opacity-60" : ""}`}
                        >
                          {/* User */}
                          <td className="px-4 sm:px-5 py-3.5">
                            <div className="flex items-center gap-3">
                              <div
                                className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${
                                  u.isBlocked
                                    ? "bg-destructive/15 text-destructive"
                                    : "bg-primary/15 text-primary"
                                }`}
                              >
                                <span className="text-xs font-semibold">{initials}</span>
                              </div>
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-foreground leading-tight truncate">
                                  {displayName}
                                </p>
                                <p className="text-[11px] text-muted-foreground/70 mt-0.5 tabular-nums">
                                  User #{u.id}
                                  {isClerkPlaceholderEmail(u) && u.phone && (
                                    <> · {u.phone}</>
                                  )}
                                </p>
                              </div>
                            </div>
                          </td>

                          {/* Contact */}
                          <td className="px-4 sm:px-5 py-3.5">
                            <div className="flex flex-col gap-0.5 min-w-0">
                              {email ? (
                                <span className="text-xs text-foreground/80 truncate tabular-nums">
                                  {email}
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground/50 italic">
                                  No email
                                </span>
                              )}
                              {u.phone && (
                                <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                                  {u.phone}
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Role */}
                          <td className="px-4 sm:px-5 py-3.5">
                            {isAdmin ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-primary/10 text-primary">
                                <Crown className="h-3 w-3" />
                                Admin
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-muted text-muted-foreground">
                                <Shield className="h-3 w-3" />
                                Customer
                              </span>
                            )}
                            {u.isBlocked && (
                              <span className="ml-1 inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-destructive/10 text-destructive">
                                <Ban className="h-3 w-3" />
                                Blocked
                              </span>
                            )}
                          </td>

                          {/* Orders */}
                          <td className="px-4 sm:px-5 py-3.5 text-center">
                            <button
                              onClick={() => {
                                const term = email ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
                                setUserSearch("");
                                setActiveTab("orders");
                                setTimeout(() => setOrderSearch(term), 50);
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-info/10 text-info-foreground text-xs font-semibold hover:bg-info/20 transition-colors"
                            >
                              <ShoppingCart className="h-3 w-3" />
                              {u.orderCount ?? 0}
                            </button>
                          </td>

                          {/* Joined */}
                          <td className="px-4 sm:px-5 py-3.5 text-right text-xs text-muted-foreground/80 whitespace-nowrap tabular-nums">
                            {formatDate(u.createdAt)}
                          </td>

                          {/* Actions */}
                          <td className="px-4 sm:px-5 py-3.5 text-right">
                            {isAdmin ? (
                              <span className="text-[11px] text-muted-foreground/40 italic">
                                Protected
                              </span>
                            ) : (
                              <button
                                onClick={() => handleToggleBlock(u.id, !u.isBlocked)}
                                className={`p-1.5 rounded-md transition-colors ${
                                  u.isBlocked
                                    ? "text-muted-foreground/70 hover:text-success-foreground hover:bg-success/10"
                                    : "text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10"
                                }`}
                                title={u.isBlocked ? "Unblock user" : "Block user"}
                                aria-label={u.isBlocked ? "Unblock user" : "Block user"}
                              >
                                {u.isBlocked ? (
                                  <UserCheck className="h-3.5 w-3.5" />
                                ) : (
                                  <Ban className="h-3.5 w-3.5" />
                                )}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Pagination footer */}
          {!usersLoading && filtered.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 py-3 border-t bg-muted/20">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {rangeText(currentPage, pageSize, filtered.length)}
                </span>
                <span className="hidden sm:inline text-muted-foreground/40">·</span>
                <div className="flex items-center gap-1.5">
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
                        }}
                        aria-disabled={currentPage === totalPages}
                        className={
                          currentPage === totalPages ? "pointer-events-none opacity-50" : ""
                        }
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
