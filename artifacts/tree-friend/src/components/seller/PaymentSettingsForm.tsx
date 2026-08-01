import { useState } from "react";
import { Wallet, Loader2, Trash2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useGetMySellerPayoutAccount,
  useCreateSellerPayoutAccount,
  useDeleteMySellerPayoutAccount,
  getGetMySellerPayoutAccountQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * Payment Settings — new admin-custodial bKash payments design (Part 1 of
 * 4, see PART1_HANDOFF.md). Replaces the old merchant-API-credentials form
 * (App Key/App Secret/Merchant Username/Merchant Password, backed by
 * seller-payment-configs) with a SINGLE bkashNumber field, backed by
 * seller-payout-accounts, because sellers no longer need their own bKash
 * merchant account under the new model — the platform holds one merchant
 * account, buyers pay into it, and sellers just receive disbursements at
 * a plain phone number after courier delivery is confirmed (Part 3).
 *
 * Mirrors the old form's loading/empty/connected-state shape and the
 * delete-confirm pattern (kept for visual/UX continuity with
 * CourierSettingsForm.tsx, which this dashboard tab sits next to) but:
 *  - No isVerified/pending-verification messaging. This table has no
 *    isVerified column (a payout number isn't "verified" the way merchant
 *    API credentials are — see schema doc comment) and nothing downstream
 *    reads this table's existence yet (Part 2/3's job), so there's no
 *    "pending admin review" state to show here, unlike the old form's
 *    amber notice.
 *  - No password-masked input type on any field — bkashNumber isn't a
 *    secret (see sellerPayoutAccounts.ts's schema doc comment on why it's
 *    stored unencrypted), so it's shown/typed as plain text, and the
 *    connected-state card shows the full number rather than a masked one
 *    (the GET route returns it unmasked, matching the schema's own
 *    "not a credential" stance).
 */
export function PaymentSettingsForm() {
  const qc = useQueryClient();
  const { data: account, isLoading } = useGetMySellerPayoutAccount();
  const createAccount = useCreateSellerPayoutAccount();
  const deleteAccount = useDeleteMySellerPayoutAccount();

  const [bkashNumber, setBkashNumber] = useState("");
  const [accountHolderName, setAccountHolderName] = useState("");

  function invalidate() {
    qc.invalidateQueries({ queryKey: getGetMySellerPayoutAccountQueryKey() });
  }

  function handleSave() {
    if (!bkashNumber.trim()) {
      toast.error("Enter your bKash number");
      return;
    }

    createAccount.mutate(
      {
        data: {
          bkashNumber: bkashNumber.trim(),
          accountHolderName: accountHolderName.trim() || undefined,
        },
      },
      {
        onSuccess: () => {
          toast.success("bKash number saved");
          setBkashNumber("");
          setAccountHolderName("");
          invalidate();
        },
        onError: (err: any) => toast.error(err?.message ?? "Failed to save payout account"),
      },
    );
  }

  function handleDelete() {
    if (!confirm("Remove your bKash payout number? You won't be able to receive payouts until you add a new one.")) return;
    deleteAccount.mutate(undefined, {
      onSuccess: () => { toast.success("Payout number removed"); invalidate(); },
      onError: (err: any) => toast.error(err?.message ?? "Failed to remove payout account"),
    });
  }

  if (isLoading) {
    return <div className="h-40 rounded-2xl bg-muted animate-pulse" />;
  }

  if (account) {
    return (
      <div className="bg-card rounded-2xl border p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-10 w-10 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
              <Wallet className="h-5 w-5 text-accent" />
            </div>
            <div>
              <p className="font-medium text-sm">{account.bkashNumber}</p>
              <p className="text-xs text-muted-foreground">
                {account.accountHolderName ? `Account holder: ${account.accountHolderName}` : "bKash payout number"}
              </p>
            </div>
          </div>
          <button
            onClick={handleDelete}
            disabled={deleteAccount.isPending}
            className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-red-50 transition-colors"
            title="Remove"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground bg-muted rounded-lg px-3 py-2 mt-3 flex items-start gap-1.5">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          Payouts are sent here automatically after courier delivery is confirmed.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-2xl border p-5">
      <div className="flex items-center gap-2.5 mb-4">
        <div className="h-10 w-10 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
          <Wallet className="h-5 w-5 text-accent" />
        </div>
        <div>
          <p className="font-medium text-sm">Add your bKash number to receive payouts</p>
          <p className="text-xs text-muted-foreground">Buyers pay Tree Friend directly — you get paid out here after delivery.</p>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <Label className="text-xs text-muted-foreground">bKash Number</Label>
          <Input
            value={bkashNumber}
            onChange={(e) => setBkashNumber(e.target.value)}
            placeholder="01712345678"
            className="mt-1 h-9 rounded-lg text-sm"
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Account Holder Name (optional)</Label>
          <Input
            value={accountHolderName}
            onChange={(e) => setAccountHolderName(e.target.value)}
            className="mt-1 h-9 rounded-lg text-sm"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Use a bKash Personal or Agent number you check regularly — this is where your payouts arrive.
        </p>

        <Button onClick={handleSave} disabled={createAccount.isPending} className="w-full rounded-full gap-1.5 mt-2">
          {createAccount.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
          Save
        </Button>
      </div>
    </div>
  );
}
