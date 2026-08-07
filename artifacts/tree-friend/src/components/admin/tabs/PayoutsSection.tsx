import { useState, useEffect } from "react";
import { useApiFetch } from "@/lib/useApiFetch";
import { Button } from "@/components/ui/button";
import { RotateCcw, StickyNote, Loader2 } from "lucide-react";
import { toast } from "sonner";

/**
 * Admin payout visibility + manual retry + case-by-case return notes --
 * Part 4 of 4 (see PART4_HANDOFF.md, items 2 and 3). Structurally follows
 * CashoutsSection.tsx directly, per the prompt's explicit instruction to
 * read that file in full and match its patterns rather than inventing a
 * different shape: fetch-on-mount via getToken(), the same API base-URL
 * constant, and an optimistic local state update after a successful
 * PATCH/POST rather than a full refetch.
 *
 * payoutsTable rows have existed and been written to since Part 3 (bKash
 * B2C disbursement on courier delivery), but nothing surfaced them
 * anywhere in the admin dashboard until this component.
 *
 * Grouped by status the same way CashoutsSection groups pending vs.
 * processed -- here: failed (needs attention / retryable) vs. everything
 * else (pending/success, informational).
 *
 * The "Add Note" affordance (item 3) is DELIBERATELY the lightest-weight
 * piece here: a free-text note plus an optional amount, purely for the
 * admin's own record-keeping about a return that happened after a payout
 * already went out. It does not call bKash, does not adjust any balance,
 * and is not shown to sellers -- see routes/admin.ts's
 * `PATCH /admin/payouts/:id/note` for the enforcement of that boundary.
 */
export function PayoutsSection() {
  const apiFetch = useApiFetch();
  const [payouts, setPayouts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [noteEditingId, setNoteEditingId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [amountDraft, setAmountDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  async function fetchPayouts() {
    setLoading(true);
    try {
      const r = await apiFetch("/api/admin/payouts");
      const d = await r.json();
      if (Array.isArray(d?.payouts)) setPayouts(d.payouts);
    } catch {} finally { setLoading(false); }
  }

  useEffect(() => {
    fetchPayouts();
  }, []);

  async function handleRetry(id: number) {
    setRetryingId(id);
    try {
      const r = await apiFetch(`/api/admin/payouts/${id}/retry`, { method: "POST" });
      const data = await r.json();
      if (!r.ok) {
        toast.error(data?.error ?? "Retry failed");
        return;
      }
      // Per Part 3's "new row per attempt" retry policy (reused unchanged
      // by this retry route -- see lib/payouts.ts), the retry's outcome
      // lands in a BRAND NEW payout row, not the one the admin clicked
      // retry on. The original row is untouched. Prepend the new row
      // rather than trying to patch the old one in place, so the list
      // reflects the real one-row-per-attempt history.
      setPayouts((prev) => [data, ...prev]);
      toast[data.status === "success" ? "success" : "error"](
        data.status === "success" ? "Retry succeeded" : `Retry failed: ${data.failureReason ?? "unknown reason"}`,
      );
    } finally {
      setRetryingId(null);
    }
  }

  function openNoteEditor(p: any) {
    setNoteEditingId(p.id);
    setNoteDraft(p.adminNote ?? "");
    setAmountDraft(p.clawbackNotedAmount != null ? String(p.clawbackNotedAmount) : "");
  }

  async function handleSaveNote(id: number) {
    setSavingNote(true);
    try {
      const r = await apiFetch(`/api/admin/payouts/${id}/note`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminNote: noteDraft.trim() || null,
          clawbackNotedAmount: amountDraft.trim() === "" ? null : Number(amountDraft),
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        toast.error(data?.error ?? "Failed to save note");
        return;
      }
      setPayouts((prev) => prev.map((p) => (p.id === id ? { ...p, ...data } : p)));
      toast.success("Note saved");
      setNoteEditingId(null);
    } finally {
      setSavingNote(false);
    }
  }

  if (loading) return <div className="h-24 rounded-xl bg-muted animate-pulse" />;

  const failed = payouts.filter((p) => p.status === "failed");
  const other = payouts.filter((p) => p.status !== "failed");

  function statusPill(status: string) {
    const cls =
      status === "success"
        ? "bg-success text-success-foreground"
        : status === "failed"
          ? "bg-destructive/10 text-destructive"
          : "bg-warning text-warning-foreground";
    return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{status}</span>;
  }

  function renderRow(p: any) {
    return (
      <div key={p.id} className="border rounded-xl p-4 space-y-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="font-semibold text-sm">
              {p.orderTrackingId ?? `Order #${p.orderId}`}{" "}
              <span className="text-muted-foreground font-normal">
                &middot; {p.sellerBusinessName ?? `Seller #${p.sellerId}`}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              {new Date(p.createdAt).toLocaleString()} {p.orderStatus && `· order: ${p.orderStatus}`}
            </p>
            {p.failureReason && <p className="text-xs text-destructive mt-1">{p.failureReason}</p>}
            {p.bkashTransactionId && <p className="text-xs text-muted-foreground mt-1">trxID: {p.bkashTransactionId}</p>}
            {(p.adminNote || p.clawbackNotedAmount != null) && (
              <div className="text-xs bg-warning text-warning-foreground rounded-lg px-2.5 py-1.5 mt-2 flex items-start gap-1.5">
                <StickyNote className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>
                  {p.adminNote}
                  {p.clawbackNotedAmount != null && (
                    <span className="block font-medium">Noted amount: Tk{Number(p.clawbackNotedAmount).toLocaleString()}</span>
                  )}
                </span>
              </div>
            )}
          </div>
          <div className="text-right shrink-0 space-y-2">
            <p className="font-bold text-lg">Tk{Number(p.amount).toLocaleString()}</p>
            {statusPill(p.status)}
          </div>
        </div>

        {noteEditingId === p.id ? (
          <div className="border-t pt-2 space-y-2">
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="e.g. Buyer returned this item on 2026-08-02, handling refund with seller manually outside the app."
              className="w-full text-sm rounded-lg border p-2 min-h-[60px]"
            />
            <input
              type="number"
              min="0"
              step="0.01"
              value={amountDraft}
              onChange={(e) => setAmountDraft(e.target.value)}
              placeholder="Noted amount (optional, for your own reference only)"
              className="w-full text-sm rounded-lg border p-2"
            />
            <div className="flex gap-2">
              <Button size="sm" className="rounded-full" disabled={savingNote} onClick={() => handleSaveNote(p.id)}>
                {savingNote ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Save Note
              </Button>
              <Button size="sm" variant="outline" className="rounded-full" onClick={() => setNoteEditingId(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 border-t pt-2">
            {p.status === "failed" && (
              <Button
                size="sm"
                className="rounded-full gap-1.5"
                disabled={retryingId === p.id}
                onClick={() => handleRetry(p.id)}
              >
                {retryingId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                Retry
              </Button>
            )}
            <Button size="sm" variant="outline" className="rounded-full gap-1.5" onClick={() => openNoteEditor(p)}>
              <StickyNote className="h-3.5 w-3.5" />
              {p.adminNote || p.clawbackNotedAmount != null ? "Edit Note" : "Add Note"}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-8">
      <h3 className="font-semibold text-base mb-1">Seller Payouts</h3>
      <p className="text-sm text-muted-foreground mb-4">
        Automatic bKash disbursements to sellers after courier delivery. A failed payout can be retried once its
        cause is fixed (e.g. the seller adds a payout number). Returns that happen after a payout has already
        succeeded are handled manually -- use "Add Note" to record that here; no automatic clawback happens.
      </p>
      {payouts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No payout attempts yet.</p>
      ) : (
        <div className="space-y-4">
          {failed.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2 font-medium">
                Failed -- needs attention ({failed.length})
              </p>
              <div className="space-y-3">{failed.map(renderRow)}</div>
            </div>
          )}
          {other.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2 font-medium">All other payouts</p>
              <div className="space-y-3">{other.map(renderRow)}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
