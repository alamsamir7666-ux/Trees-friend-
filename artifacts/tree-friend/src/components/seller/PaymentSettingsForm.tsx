import { useState } from "react";
import { Wallet, Loader2, Trash2, ShieldCheck, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useGetMySellerPaymentConfig,
  useCreateSellerPaymentConfig,
  useDeleteMySellerPaymentConfig,
  getGetMySellerPaymentConfigQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * Payment Settings (plan doc §4, §7 — Part 6). Lets a seller connect their
 * own bKash Merchant API account so listings can offer "advance"/"both"
 * payment instead of COD-only.
 *
 * Mirrors CourierSettingsForm.tsx's shape and conventions exactly (same
 * loading/empty/connected states, same delete-confirm pattern, same
 * invalidate-on-success), adapted for bKash's 4-field credential shape
 * (merchantAppKey/merchantAppSecret/merchantUsername/merchantPassword --
 * routes/sellerPaymentConfigs.ts requires all four together, there's no
 * partial-credential state, unlike courier's provider-conditional fields).
 *
 * Saving credentials here does NOT immediately unlock advance payment --
 * isVerified starts false and only an admin can flip it (Part 6's
 * admin-review verification flow, routes/adminSellers.ts's
 * /admin/seller-payment-configs/:id/verify). The connected-state card
 * below makes that explicit with a "Saved, pending verification" notice
 * rather than letting a seller wonder why advance payment still isn't
 * available after saving.
 */
export function PaymentSettingsForm() {
  const qc = useQueryClient();
  const { data: config, isLoading } = useGetMySellerPaymentConfig();
  const createConfig = useCreateSellerPaymentConfig();
  const deleteConfig = useDeleteMySellerPaymentConfig();

  const [merchantAppKey, setMerchantAppKey] = useState("");
  const [merchantAppSecret, setMerchantAppSecret] = useState("");
  const [merchantUsername, setMerchantUsername] = useState("");
  const [merchantPassword, setMerchantPassword] = useState("");

  function invalidate() {
    qc.invalidateQueries({ queryKey: getGetMySellerPaymentConfigQueryKey() });
  }

  function handleSave() {
    if (!merchantAppKey.trim() || !merchantAppSecret.trim() || !merchantUsername.trim() || !merchantPassword.trim()) {
      toast.error("Fill in App Key, App Secret, Merchant Username, and Merchant Password");
      return;
    }

    createConfig.mutate(
      {
        data: {
          provider: "bkash",
          merchantAppKey: merchantAppKey.trim(),
          merchantAppSecret: merchantAppSecret.trim(),
          merchantUsername: merchantUsername.trim(),
          merchantPassword: merchantPassword.trim(),
        },
      },
      {
        onSuccess: () => {
          toast.success("bKash account saved — pending admin verification");
          setMerchantAppKey(""); setMerchantAppSecret(""); setMerchantUsername(""); setMerchantPassword("");
          invalidate();
        },
        onError: (err: any) => toast.error(err?.message ?? "Failed to save payment settings"),
      },
    );
  }

  function handleDelete() {
    if (!confirm("Disconnect your bKash account? Your listings will fall back to COD-only.")) return;
    deleteConfig.mutate(undefined, {
      onSuccess: () => { toast.success("bKash account disconnected"); invalidate(); },
      onError: (err: any) => toast.error(err?.message ?? "Failed to disconnect"),
    });
  }

  if (isLoading) {
    return <div className="h-40 rounded-2xl bg-muted animate-pulse" />;
  }

  if (config) {
    return (
      <div className="bg-card rounded-2xl border p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-10 w-10 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
              <Wallet className="h-5 w-5 text-accent" />
            </div>
            <div>
              <p className="font-medium text-sm capitalize">{config.provider}</p>
              <p className="text-xs text-muted-foreground">
                App Key: {config.merchantAppKeyMasked} · Username: {config.merchantUsernameMasked}
              </p>
            </div>
          </div>
          <button
            onClick={handleDelete}
            disabled={deleteConfig.isPending}
            className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-red-50 transition-colors"
            title="Disconnect"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        {config.isVerified ? (
          <p className="text-xs text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 mt-3 flex items-start gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            Verified — your listings can offer advance/bKash payment.
          </p>
        ) : (
          <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mt-3 flex items-start gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            Saved, pending verification — an admin reviews new payment accounts before advance/bKash payment
            unlocks. Your listings stay COD-only until then.
          </p>
        )}
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
          <p className="font-medium text-sm">Connect your bKash Merchant account</p>
          <p className="text-xs text-muted-foreground">Required to offer advance or bKash payment on your listings.</p>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <Label className="text-xs text-muted-foreground">App Key</Label>
          <Input value={merchantAppKey} onChange={(e) => setMerchantAppKey(e.target.value)} className="mt-1 h-9 rounded-lg text-sm" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">App Secret</Label>
          <Input value={merchantAppSecret} onChange={(e) => setMerchantAppSecret(e.target.value)} type="password" className="mt-1 h-9 rounded-lg text-sm" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">Merchant Username</Label>
            <Input value={merchantUsername} onChange={(e) => setMerchantUsername(e.target.value)} className="mt-1 h-9 rounded-lg text-sm" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Merchant Password</Label>
            <Input value={merchantPassword} onChange={(e) => setMerchantPassword(e.target.value)} type="password" className="mt-1 h-9 rounded-lg text-sm" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Find these in your bKash Merchant Panel under API Credentials.
        </p>

        <Button onClick={handleSave} disabled={createConfig.isPending} className="w-full rounded-full gap-1.5 mt-2">
          {createConfig.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
          Connect
        </Button>
      </div>
    </div>
  );
}
