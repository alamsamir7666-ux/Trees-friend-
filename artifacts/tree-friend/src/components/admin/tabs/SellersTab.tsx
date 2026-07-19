import { useState } from "react";
import { CheckCircle2, XCircle, Clock, Ban, Loader2, ExternalLink, Wallet, Truck, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useListSellers,
  useApproveSeller,
  useRejectSeller,
  useSuspendSeller,
  getListSellersQueryKey,
  useListAdminSellerPaymentConfigs,
  useVerifySellerPaymentConfig,
  getListAdminSellerPaymentConfigsQueryKey,
  useListAdminSellerCourierConfigs,
  useVerifySellerCourierConfig,
  getListAdminSellerCourierConfigsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const STATUS_TABS = [
  { value: "pending_verification", label: "Pending Review" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "vacation", label: "Vacation" },
] as const;

/**
 * Admin review queue for seller applications (plan doc §4 "Business
 * Verification" / §5.3). Manual document review only, per §9 -- this UI
 * doesn't attempt any automated KYC, it just surfaces the applicant's
 * submitted info/documents and lets admin approve or reject.
 *
 * Also hosts payment/courier config verification (Part 6) below the
 * seller status queue -- the "safer default" admin-review toggle chosen
 * over a live bKash/Pathao/Steadfast API check (see
 * routes/adminSellers.ts's doc comment on the verify routes for the full
 * rationale). Kept in this same tab per the task brief's suggestion
 * rather than a new top-level admin nav entry, since it's the same
 * "review something a seller submitted" pattern as the queue above it,
 * just for a different table.
 */
export function SellersTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_TABS)[number]["value"]>("pending_verification");
  const [actingOn, setActingOn] = useState<number | null>(null);

  const { data: sellers, isLoading } = useListSellers(
    { status: statusFilter },
    { query: { queryKey: getListSellersQueryKey({ status: statusFilter }) } },
  );
  const approveSeller = useApproveSeller();
  const rejectSeller = useRejectSeller();
  const suspendSeller = useSuspendSeller();

  function invalidate() {
    qc.invalidateQueries({ queryKey: getListSellersQueryKey() });
  }

  function handleApprove(id: number) {
    setActingOn(id);
    approveSeller.mutate(
      { id },
      {
        onSuccess: () => { toast.success("Seller approved"); invalidate(); setActingOn(null); },
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
        onSuccess: () => { toast.success("Application rejected"); invalidate(); setActingOn(null); },
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
        onSuccess: () => { toast.success("Seller suspended"); invalidate(); setActingOn(null); },
        onError: (err: any) => { toast.error(err?.message ?? "Failed to suspend seller"); setActingOn(null); },
      },
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3">
        <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <TabsList className="rounded-full">
            {STATUS_TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="rounded-full text-xs">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <p className="text-xs text-gray-400 shrink-0">{sellers?.length ?? 0} seller(s)</p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-24 rounded-2xl bg-muted animate-pulse" />)}
        </div>
      ) : !sellers || sellers.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground bg-white rounded-2xl border">
          <Clock className="h-8 w-8 mx-auto mb-2 opacity-30" />
          <p className="font-medium text-sm">No sellers in this status</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sellers.map((s: any) => (
            <div key={s.id} className="bg-white rounded-2xl border p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-gray-800">{s.businessName}</p>
                    <span className="text-xs text-gray-400">·</span>
                    <p className="text-sm text-gray-500">{s.nurseryName}</p>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {s.ownerName} · {s.contactPhone} · {s.contactEmail}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">{s.location}</p>
                  {s.description && <p className="text-sm text-gray-600 mt-2">{s.description}</p>}
                  {s.nidOrTradeLicenseUrl && (
                    <a
                      href={s.nidOrTradeLicenseUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mt-2"
                    >
                      View trade license/NID <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  <p className="text-xs text-gray-300 mt-2">
                    Applied {new Date(s.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  {s.status === "pending_verification" && (
                    <>
                      <Button
                        size="sm"
                        className="rounded-full gap-1.5"
                        disabled={actingOn === s.id}
                        onClick={() => handleApprove(s.id)}
                      >
                        {actingOn === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="rounded-full gap-1.5 text-red-600 border-red-200 hover:bg-red-50"
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
                      className="rounded-full gap-1.5 text-red-600 border-red-200 hover:bg-red-50"
                      disabled={actingOn === s.id}
                      onClick={() => handleSuspend(s.id)}
                    >
                      {actingOn === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                      Suspend
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <PendingConfigVerification />
    </div>
  );
}

/**
 * Payment/courier config verification queue (Part 6). Separate from the
 * seller status queue above -- a seller must already be "active" to have
 * saved a config at all (routes/sellerPaymentConfigs.ts and
 * sellerCourierConfigs.ts both gate on requireSeller, which requires
 * status === "active"), so this doesn't need its own status filter, just
 * a verified/unverified toggle per config type. Defaults to showing
 * unverified (the actual review queue); "Verified" lets admin double-check
 * or revoke an existing approval.
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

  return (
    <div className="mt-10 pt-8 border-t">
      <h2 className="font-medium text-gray-800 mb-1">Payment &amp; Courier Verification</h2>
      <p className="text-xs text-gray-400 mb-4">
        Manual review only -- no live bKash/Pathao/Steadfast API check is performed here. Confirm credentials work
        by some means outside this system before approving.
      </p>

      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className="rounded-full">
            <TabsTrigger value="payment" className="rounded-full text-xs gap-1"><Wallet className="h-3 w-3" /> Payment</TabsTrigger>
            <TabsTrigger value="courier" className="rounded-full text-xs gap-1"><Truck className="h-3 w-3" /> Courier</TabsTrigger>
          </TabsList>
        </Tabs>
        <Tabs value={String(showVerified)} onValueChange={(v) => setShowVerified(v === "true")}>
          <TabsList className="rounded-full">
            <TabsTrigger value="false" className="rounded-full text-xs">Pending</TabsTrigger>
            <TabsTrigger value="true" className="rounded-full text-xs">Verified</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => <div key={i} className="h-16 rounded-2xl bg-muted animate-pulse" />)}
        </div>
      ) : !configs || configs.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground bg-white rounded-2xl border">
          <ShieldCheck className="h-6 w-6 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No {showVerified ? "verified" : "pending"} {tab} configs</p>
        </div>
      ) : (
        <div className="space-y-3">
          {configs.map((c: any) => (
            <div key={c.id} className="bg-white rounded-2xl border p-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium text-sm text-gray-800 capitalize">{c.provider}</p>
                  <span className="text-xs text-gray-400">·</span>
                  <p className="text-xs text-gray-500">Seller #{c.sellerId}</p>
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  {tab === "payment"
                    ? `App Key: ${c.merchantAppKeyMasked} · Username: ${c.merchantUsernameMasked}`
                    : `Key: ${c.apiKeyMasked} · Secret: ${c.apiSecretMasked}${c.storeId ? ` · Store ${c.storeId}` : ""}`}
                </p>
              </div>
              {!showVerified && (
                <Button
                  size="sm"
                  className="rounded-full gap-1.5 shrink-0"
                  disabled={actingOn === c.id}
                  onClick={() => (tab === "payment" ? handleVerifyPayment(c.id) : handleVerifyCourier(c.id))}
                >
                  {actingOn === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  Verify
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
