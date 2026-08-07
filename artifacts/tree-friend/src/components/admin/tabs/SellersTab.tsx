import { useState, type ReactNode } from "react";
import {
  CheckCircle2, XCircle, Ban, Loader2, ExternalLink,
  Wallet, Truck, ShieldCheck, BadgeCheck, Store, MapPin, Phone, Mail,
  User, FileText, CalendarDays, Users2, Inbox, Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Pagination, PaginationContent, PaginationItem, PaginationLink,
  PaginationEllipsis, PaginationNext, PaginationPrevious,
} from "@/components/ui/pagination";
import {
  useListSellers,
  useListSellerCounts,
  useApproveSeller,
  useRejectSeller,
  useSuspendSeller,
  getListSellersQueryKey,
  getListSellerCountsQueryKey,
  useListAdminSellerPaymentConfigs,
  useVerifySellerPaymentConfig,
  getListAdminSellerPaymentConfigsQueryKey,
  useListAdminSellerCourierConfigs,
  useVerifySellerCourierConfig,
  getListAdminSellerCourierConfigsQueryKey,
  useListSellerVerificationRequests,
  useVerifySeller,
  useRejectSellerVerification,
  getListSellerVerificationRequestsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

// ─── Status palette ───────────────────────────────────────────────────────────
// Mirrors the sellersTable.status enum (pending_verification | active |
// suspended | vacation). Falls back to a neutral style for unknown values.

const STATUS_META: Record<
  string,
  { label: string; tone: string; dot: string }
> = {
  pending_verification: {
    label: "Pending Review",
    tone: "bg-warning/15 text-warning-foreground border-warning-border",
    dot: "bg-warning",
  },
  active: {
    label: "Active",
    tone: "bg-success/15 text-success-foreground border-success-border",
    dot: "bg-success",
  },
  suspended: {
    label: "Suspended",
    tone: "bg-destructive/10 text-destructive border-destructive/20",
    dot: "bg-destructive",
  },
  vacation: {
    label: "On Vacation",
    tone: "bg-info/15 text-info-foreground border-info-border",
    dot: "bg-info",
  },
};

const STATUS_TABS = [
  { value: "pending_verification", label: "Pending Review" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "vacation", label: "Vacation" },
] as const;

type StatusValue = (typeof STATUS_TABS)[number]["value"];

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

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
}: {
  icon: React.ElementType;
  title: string;
  description?: string;
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
    </div>
  );
}

function InfoRow({
  icon: Icon,
  children,
  title,
}: {
  icon: React.ElementType;
  children: ReactNode;
  title?: string;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
      <span className="text-xs text-muted-foreground truncate" title={title}>
        {children}
      </span>
    </div>
  );
}

// ─── Range text ("Showing 1–20 of 1,234") ─────────────────────────────────────

function rangeText(page: number, pageSize: number, total: number) {
  if (total === 0) return "No results";
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`;
}

// ─── Page-number list with ellipses (1 … 4 5 6 … 20) ──────────────────────────

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

// ─── Main tab ─────────────────────────────────────────────────────────────────

/**
 * Admin Sellers tab — seller application review queue + verification sub-queues.
 *
 * Industry-standard admin layout: page header, status tabs with per-status
 * counts (single /counts request), live search, server-side pagination with
 * page-size selector, and a clear visual hierarchy. Below the main queue sit
 * the Verified Badge and Payment/Courier config review queues, separated by
 * section headers.
 */
export function SellersTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusValue>("pending_verification");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(20);
  const [actingOn, setActingOn] = useState<number | null>(null);

  // Per-status counts -- single request for all 4 tab badges. Stale time
  // 60s so switching tabs doesn't refetch; invalidated alongside the list
  // when a mutation flips a seller's status.
  const { data: counts } = useListSellerCounts(
    { query: { queryKey: getListSellerCountsQueryKey(), staleTime: 60_000 } },
  );

  const offset = (page - 1) * pageSize;
  const { data: sellers, isLoading } = useListSellers(
    { status: statusFilter, limit: pageSize, offset },
    { query: { queryKey: getListSellersQueryKey({ status: statusFilter, limit: pageSize, offset }) } },
  );

  const approveSeller = useApproveSeller();
  const rejectSeller = useRejectSeller();
  const suspendSeller = useSuspendSeller();

  const totalForCurrentStatus = counts?.[statusFilter] ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalForCurrentStatus / pageSize));

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: getListSellersQueryKey() });
    qc.invalidateQueries({ queryKey: getListSellerCountsQueryKey() });
  }

  function handleApprove(id: number) {
    setActingOn(id);
    approveSeller.mutate(
      { id },
      {
        onSuccess: () => { toast.success("Seller approved"); invalidateAll(); setActingOn(null); },
        onError: (err: any) => { toast.error(err?.message ?? "Failed to approve seller"); setActingOn(null); },
      },
    );
  }

  function handleReject(id: number) {
    if (!confirm("Reject this application? The seller record will be removed and they can re-apply.")) return;
    setActingOn(id);
    rejectSeller.mutate(
      { id, data: {} },
      {
        onSuccess: () => { toast.success("Application rejected"); invalidateAll(); setActingOn(null); },
        onError: (err: any) => { toast.error(err?.message ?? "Failed to reject application"); setActingOn(null); },
      },
    );
  }

  function handleSuspend(id: number) {
    if (!confirm("Suspend this seller? Their listings should be hidden from buyers.")) return;
    setActingOn(id);
    suspendSeller.mutate(
      { id },
      {
        onSuccess: () => { toast.success("Seller suspended"); invalidateAll(); setActingOn(null); },
        onError: (err: any) => { toast.error(err?.message ?? "Failed to suspend seller"); setActingOn(null); },
      },
    );
  }

  function changeStatus(next: StatusValue) {
    setStatusFilter(next);
    setPage(1);
    setSearch("");
  }

  function changePageSize(next: number) {
    setPageSize(next);
    setPage(1);
  }

  // Client-side search within the current page slice. The backend list
  // endpoint supports status + pagination but not full-text search; doing
  // search client-side keeps the API simple and is fine for an admin tool
  // where the admin typically knows which seller they're looking for and
  // can flip tabs / pages to find them. Marked clearly so a future
  // server-side search can replace this without UI changes.
  const filtered = (sellers ?? []).filter((s: any) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      `${s.businessName ?? ""}`.toLowerCase().includes(q) ||
      `${s.nurseryName ?? ""}`.toLowerCase().includes(q) ||
      `${s.ownerName ?? ""}`.toLowerCase().includes(q) ||
      `${s.contactEmail ?? ""}`.toLowerCase().includes(q) ||
      `${s.contactPhone ?? ""}`.toLowerCase().includes(q) ||
      `${s.location ?? ""}`.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-8">
      <PageHeader
        title="Sellers"
        description="Review seller applications, manage seller status, and verify payment & courier credentials. This is the gatekeeper view for the marketplace."
        icon={Store}
        actions={
          <Badge variant="outline" className="gap-1.5 px-2.5 py-1">
            <Users2 className="h-3 w-3" />
            <span className="tabular-nums">{totalForCurrentStatus.toLocaleString()}</span>
            <span className="text-muted-foreground font-normal">
              {totalForCurrentStatus === 1 ? "seller" : "sellers"}
            </span>
            <span className="text-muted-foreground/50 mx-0.5">·</span>
            <span className="text-muted-foreground font-normal">{STATUS_META[statusFilter].label}</span>
          </Badge>
        }
      />

      {/* ─── Toolbar: status tabs (with counts) + search ───────────────────── */}
      <div className="flex flex-col gap-3">
        <Tabs value={statusFilter} onValueChange={(v) => changeStatus(v as StatusValue)}>
          <TabsList className="rounded-lg bg-muted/50 p-1 w-full sm:w-auto overflow-x-auto">
            {STATUS_TABS.map((t) => {
              const c = counts?.[t.value] ?? 0;
              const isActive = statusFilter === t.value;
              return (
                <TabsTrigger
                  key={t.value}
                  value={t.value}
                  className="rounded-md text-xs gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
                >
                  {t.label}
                  <span
                    className={
                      "inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold tabular-nums " +
                      (isActive ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")
                    }
                  >
                    {c.toLocaleString()}
                  </span>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>

        <div className="relative sm:max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search this page by name, email, phone…"
            className="h-9 pl-8 text-sm"
          />
        </div>
      </div>

      {/* ─── Seller list ──────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-4 sm:p-5">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-24 rounded-xl bg-muted/40 animate-pulse" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title={search.trim() ? "No sellers match your search" : "No sellers in this status"}
              description={
                search.trim()
                  ? "Try a different name, email, or phone number — or switch to another status tab."
                  : "When a seller applies, they'll appear here for review."
              }
            />
          ) : (
            <div className="divide-y">
              {filtered.map((s: any) => {
                const meta = STATUS_META[s.status as string] ?? STATUS_META.active;
                return (
                  <div
                    key={s.id}
                    className="p-4 sm:p-5 transition-colors hover:bg-muted/20"
                  >
                    <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                      {/* ── Left: identity ────────────────────────────────────── */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary text-xs font-semibold">
                            {(s.businessName ?? "?").slice(0, 2).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium text-foreground truncate">
                                {s.businessName}
                              </p>
                              <span
                                className={
                                  "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border " +
                                  meta.tone
                                }
                              >
                                <span className={"h-1.5 w-1.5 rounded-full " + meta.dot} />
                                {meta.label}
                              </span>
                              {(s as any)?.isVerified && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-primary/10 text-primary border border-primary/20">
                                  <BadgeCheck className="h-3 w-3" />
                                  Verified
                                </span>
                              )}
                            </div>
                            {s.nurseryName && s.nurseryName !== s.businessName && (
                              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                                {s.nurseryName}
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Contact + meta grid */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 mt-3 pl-0 sm:pl-11">
                          {s.ownerName && (
                            <InfoRow icon={User} title={s.ownerName}>
                              {s.ownerName}
                            </InfoRow>
                          )}
                          {s.contactPhone && (
                            <InfoRow icon={Phone} title={s.contactPhone}>
                              {s.contactPhone}
                            </InfoRow>
                          )}
                          {s.contactEmail && (
                            <InfoRow icon={Mail} title={s.contactEmail}>
                              {s.contactEmail}
                            </InfoRow>
                          )}
                          {s.location && (
                            <InfoRow icon={MapPin} title={s.location}>
                              {s.location}
                            </InfoRow>
                          )}
                          {s.createdAt && (
                            <InfoRow icon={CalendarDays}>
                              Applied {new Date(s.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                            </InfoRow>
                          )}
                          {s.nidOrTradeLicenseUrl && (
                            <a
                              href={s.nidOrTradeLicenseUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline mt-0.5"
                            >
                              <FileText className="h-3.5 w-3.5" />
                              View trade license / NID
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>

                        {s.description && (
                          <p className="text-xs text-muted-foreground mt-3 sm:pl-11 line-clamp-2">
                            {s.description}
                          </p>
                        )}
                      </div>

                      {/* ── Right: actions ───────────────────────────────────── */}
                      <div className="flex flex-row lg:flex-col gap-2 shrink-0 lg:items-end">
                        {s.status === "pending_verification" && (
                          <>
                            <Button
                              size="sm"
                              className="gap-1.5"
                              disabled={actingOn === s.id}
                              onClick={() => handleApprove(s.id)}
                            >
                              {actingOn === s.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3.5 w-3.5" />
                              )}
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1.5 text-destructive border-destructive/20 hover:bg-destructive/10 hover:text-destructive"
                              disabled={actingOn === s.id}
                              onClick={() => handleReject(s.id)}
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              Reject
                            </Button>
                          </>
                        )}
                        {s.status === "active" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5 text-destructive border-destructive/20 hover:bg-destructive/10 hover:text-destructive"
                            disabled={actingOn === s.id}
                            onClick={() => handleSuspend(s.id)}
                          >
                            {actingOn === s.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Ban className="h-3.5 w-3.5" />
                            )}
                            Suspend
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ─── Footer: range text + page-size selector + pagination ─────── */}
          {!search.trim() && totalForCurrentStatus > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 py-3 border-t bg-muted/20">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="tabular-nums">{rangeText(page, pageSize, totalForCurrentStatus)}</span>
                <span className="hidden sm:inline text-muted-foreground/40">·</span>
                <div className="hidden sm:flex items-center gap-1.5">
                  <span>Rows:</span>
                  <Select value={String(pageSize)} onValueChange={(v) => changePageSize(Number(v))}>
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
                <Pagination className="mx-0 sm:mx-0 w-auto justify-end">
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        href="#"
                        onClick={(e) => { e.preventDefault(); setPage(Math.max(1, page - 1)); }}
                        aria-disabled={page === 1}
                        className={page === 1 ? "pointer-events-none opacity-50" : ""}
                      />
                    </PaginationItem>
                    {pageList(page, totalPages).map((p, i) =>
                      p === "..." ? (
                        <PaginationItem key={`ellipsis-${i}`}>
                          <PaginationEllipsis />
                        </PaginationItem>
                      ) : (
                        <PaginationItem key={p}>
                          <PaginationLink
                            href="#"
                            isActive={p === page}
                            onClick={(e) => { e.preventDefault(); setPage(p); }}
                          >
                            {p}
                          </PaginationLink>
                        </PaginationItem>
                      ),
                    )}
                    <PaginationItem>
                      <PaginationNext
                        href="#"
                        onClick={(e) => { e.preventDefault(); setPage(Math.min(totalPages, page + 1)); }}
                        aria-disabled={page === totalPages}
                        className={page === totalPages ? "pointer-events-none opacity-50" : ""}
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <PendingSellerVerification />
      <PendingConfigVerification />
    </div>
  );
}

// ─── Sub-section: Verified Seller Badge Requests ──────────────────────────────

/**
 * Verified-seller badge review queue (public trust checkmark, separate
 * from the account-status queue above — see sellers.ts schema doc
 * comment / routes/adminSellers.ts's verify routes). Mirrors
 * PendingConfigVerification's shape/pending-vs-approved tab pattern
 * just below it, for a seller-level rather than config-level request.
 */
function PendingSellerVerification() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"requested" | "approved" | "rejected">("requested");
  const [actingOn, setActingOn] = useState<number | null>(null);

  const { data: sellers, isLoading } = useListSellerVerificationRequests(
    { status: filter },
    { query: { queryKey: getListSellerVerificationRequestsQueryKey({ status: filter }) } },
  );
  const verifySeller = useVerifySeller();
  const rejectVerification = useRejectSellerVerification();

  function invalidate() {
    qc.invalidateQueries({ queryKey: getListSellerVerificationRequestsQueryKey() });
  }

  function handleApprove(id: number) {
    if (!confirm("Grant this seller the verified badge? It will show on all their listings.")) return;
    setActingOn(id);
    verifySeller.mutate(
      { id },
      {
        onSuccess: () => { toast.success("Seller verified"); invalidate(); setActingOn(null); },
        onError: (err: any) => { toast.error(err?.message ?? "Failed to verify seller"); setActingOn(null); },
      },
    );
  }

  function handleReject(id: number) {
    const reason = prompt("Optional reason (shown to the seller):") ?? undefined;
    setActingOn(id);
    rejectVerification.mutate(
      { id, data: { reason } },
      {
        onSuccess: () => { toast.success("Verification request rejected"); invalidate(); setActingOn(null); },
        onError: (err: any) => { toast.error(err?.message ?? "Failed to reject request"); setActingOn(null); },
      },
    );
  }

  const count = sellers?.length ?? 0;
  const filterLabel = filter === "requested" ? "Pending" : filter === "approved" ? "Verified" : "Rejected";

  return (
    <section className="pt-2">
      <div className="flex items-start gap-3 mb-4">
        <div className="hidden sm:flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <BadgeCheck className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Verified Seller Badge Requests
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Approving grants the public checkmark shown on this seller's listing cards.
          </p>
          <div className="mt-3">
            <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
              <TabsList className="rounded-lg bg-muted/50 p-1">
                {([
                  { value: "requested", label: "Pending" },
                  { value: "approved", label: "Verified" },
                  { value: "rejected", label: "Rejected" },
                ] as const).map((t) => (
                  <TabsTrigger
                    key={t.value}
                    value={t.value}
                    className="rounded-md text-xs gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
                  >
                    {t.label}
                    {filter === t.value && (
                      <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold tabular-nums bg-primary/15 text-primary">
                        {count}
                      </span>
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-4 sm:p-5">
              {[1, 2].map((i) => (
                <div key={i} className="h-20 rounded-xl bg-muted/40 animate-pulse" />
              ))}
            </div>
          ) : !sellers || sellers.length === 0 ? (
            <EmptyState
              icon={BadgeCheck}
              title={`No ${filterLabel.toLowerCase()} verification requests`}
              description="When a seller requests the verified badge, they'll appear here."
            />
          ) : (
            <div className="divide-y">
              {sellers.map((s: any) => (
                <div key={s.id} className="p-4 transition-colors hover:bg-muted/20">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary text-xs font-semibold">
                        {(s.businessName ?? "?").slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium text-sm text-foreground truncate">
                            {s.businessName}
                          </p>
                          {s.nurseryName && s.nurseryName !== s.businessName && (
                            <>
                              <span className="text-xs text-muted-foreground/70">·</span>
                              <p className="text-xs text-muted-foreground">{s.nurseryName}</p>
                            </>
                          )}
                        </div>
                        {s.location && (
                          <div className="mt-1">
                            <InfoRow icon={MapPin} title={s.location}>{s.location}</InfoRow>
                          </div>
                        )}
                        {filter === "requested" && s.verificationRequestedAt && (
                          <p className="text-xs text-muted-foreground/70 mt-1.5">
                            Requested {new Date(s.verificationRequestedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                          </p>
                        )}
                        {filter === "rejected" && s.verificationRejectionReason && (
                          <p className="text-xs text-destructive mt-1.5">
                            Reason: {s.verificationRejectionReason}
                          </p>
                        )}
                      </div>
                    </div>
                    {filter === "requested" && (
                      <div className="flex gap-2 shrink-0">
                        <Button
                          size="sm"
                          className="gap-1.5"
                          disabled={actingOn === s.id}
                          onClick={() => handleApprove(s.id)}
                        >
                          {actingOn === s.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          )}
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 text-destructive border-destructive/20 hover:bg-destructive/10 hover:text-destructive"
                          disabled={actingOn === s.id}
                          onClick={() => handleReject(s.id)}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          Reject
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ─── Sub-section: Payment & Courier Config Verification ───────────────────────

/**
 * Payment/courier config verification queue (Part 6). Separate from the
 * seller status queue above — a seller must already be "active" to have
 * saved a config at all (routes/sellerPaymentConfigs.ts and
 * sellerCourierConfigs.ts both gate on requireSeller, which requires
 * status === "active"), so this doesn't need its own status filter, just
 * a verified/unverified toggle per config type. Defaults to showing
 * unverified (the actual review queue); "Verified" lets admin
 * double-check or revoke an existing approval.
 */
function PendingConfigVerification() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"payment" | "courier">("payment");
  const [showVerified, setShowVerified] = useState(false);
  const [actingOn, setActingOn] = useState<number | null>(null);

  const paymentConfigs = useListAdminSellerPaymentConfigs(
    { verified: showVerified },
    { query: { queryKey: getListAdminSellerPaymentConfigsQueryKey({ verified: showVerified }), enabled: tab === "payment" } },
  );
  const courierConfigs = useListAdminSellerCourierConfigs(
    { verified: showVerified },
    { query: { queryKey: getListAdminSellerCourierConfigsQueryKey({ verified: showVerified }), enabled: tab === "courier" } },
  );
  const verifyPayment = useVerifySellerPaymentConfig();
  const verifyCourier = useVerifySellerCourierConfig();

  function invalidateBoth() {
    qc.invalidateQueries({ queryKey: getListAdminSellerPaymentConfigsQueryKey() });
    qc.invalidateQueries({ queryKey: getListAdminSellerCourierConfigsQueryKey() });
  }

  function handleVerifyPayment(id: number) {
    if (!confirm("Mark this bKash account as verified? This unlocks advance/bKash payment for the seller's listings. Confirm you've checked these credentials work before approving.")) return;
    setActingOn(id);
    verifyPayment.mutate(
      { id },
      {
        onSuccess: () => { toast.success("Payment config verified"); invalidateBoth(); setActingOn(null); },
        onError: (err: any) => { toast.error(err?.message ?? "Failed to verify payment config"); setActingOn(null); },
      },
    );
  }

  function handleVerifyCourier(id: number) {
    if (!confirm("Mark this courier account as verified?")) return;
    setActingOn(id);
    verifyCourier.mutate(
      { id },
      {
        onSuccess: () => { toast.success("Courier config verified"); invalidateBoth(); setActingOn(null); },
        onError: (err: any) => { toast.error(err?.message ?? "Failed to verify courier config"); setActingOn(null); },
      },
    );
  }

  const isLoading = tab === "payment" ? paymentConfigs.isLoading : courierConfigs.isLoading;
  const configs = tab === "payment" ? paymentConfigs.data : courierConfigs.data;
  const configCount = configs?.length ?? 0;

  return (
    <section className="pt-2">
      <div className="flex items-start gap-3 mb-4">
        <div className="hidden sm:flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <ShieldCheck className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Payment &amp; Courier Verification
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Manual review only — no live bKash/Pathao/Steadfast API check is performed here.
            Confirm credentials work by some means outside this system before approving.
          </p>
          <div className="mt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
              <TabsList className="rounded-lg bg-muted/50 p-1">
                <TabsTrigger
                  value="payment"
                  className="rounded-md text-xs gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
                >
                  <Wallet className="h-3 w-3" />
                  Payment
                </TabsTrigger>
                <TabsTrigger
                  value="courier"
                  className="rounded-md text-xs gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
                >
                  <Truck className="h-3 w-3" />
                  Courier
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Tabs value={String(showVerified)} onValueChange={(v) => setShowVerified(v === "true")}>
              <TabsList className="rounded-lg bg-muted/50 p-1">
                <TabsTrigger
                  value="false"
                  className="rounded-md text-xs gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
                >
                  Pending
                  <span
                    className={
                      "inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold tabular-nums " +
                      (!showVerified ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")
                    }
                  >
                    {configCount}
                  </span>
                </TabsTrigger>
                <TabsTrigger
                  value="true"
                  className="rounded-md text-xs gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
                >
                  Verified
                  <span
                    className={
                      "inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold tabular-nums " +
                      (showVerified ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")
                    }
                  >
                    {configCount}
                  </span>
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-4 sm:p-5">
              {[1, 2].map((i) => (
                <div key={i} className="h-16 rounded-xl bg-muted/40 animate-pulse" />
              ))}
            </div>
          ) : !configs || configs.length === 0 ? (
            <EmptyState
              icon={tab === "payment" ? Wallet : Truck}
              title={`No ${showVerified ? "verified" : "pending"} ${tab} configs`}
              description="When a seller saves a config for review, it'll appear here."
            />
          ) : (
            <div className="divide-y">
              {configs.map((c: any) => (
                <div key={c.id} className="p-4 transition-colors hover:bg-muted/20">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        {tab === "payment" ? (
                          <Wallet className="h-4 w-4" />
                        ) : (
                          <Truck className="h-4 w-4" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium text-sm text-foreground capitalize">
                            {c.provider}
                          </p>
                          <span className="text-xs text-muted-foreground/70">·</span>
                          <p className="text-xs text-muted-foreground">Seller #{c.sellerId}</p>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 font-mono">
                          {tab === "payment"
                            ? `App Key: ${c.merchantAppKeyMasked} · Username: ${c.merchantUsernameMasked}`
                            : `Key: ${c.apiKeyMasked} · Secret: ${c.apiSecretMasked}${c.storeId ? ` · Store ${c.storeId}` : ""}`}
                        </p>
                      </div>
                    </div>
                    {!showVerified && (
                      <Button
                        size="sm"
                        className="gap-1.5 shrink-0"
                        disabled={actingOn === c.id}
                        onClick={() => (tab === "payment" ? handleVerifyPayment(c.id) : handleVerifyCourier(c.id))}
                      >
                        {actingOn === c.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        )}
                        Verify
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
