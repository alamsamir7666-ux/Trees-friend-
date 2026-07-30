import { useState } from "react";
import {
  Wallet, Loader2, Trash2, ShieldCheck, ShieldAlert, CheckCircle2,
  Info, ExternalLink,
} from "lucide-react";
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

function FieldRow({
  label, children, hint, required,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  required?: boolean;
}) {
  return (
    <div>
      <Label className="text-xs font-medium text-foreground">
        {label}{required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

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
    return (
      <div className="space-y-4">
        <div className="h-32 rounded-2xl bg-muted animate-pulse" />
        <div className="h-64 rounded-2xl bg-muted animate-pulse" />
      </div>
    );
  }

  // Connected state
  if (config) {
    return (
      <div className="space-y-5 max-w-3xl">
        <section className="rounded-2xl border border-border bg-card overflow-hidden">
          <header className="px-5 py-4 border-b border-border/60">
            <h3 className="text-sm font-semibold text-foreground">Payment Account</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Your connected bKash Merchant account</p>
          </header>
          <div className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-12 w-12 rounded-xl bg-emerald-50 flex items-center justify-center shrink-0">
                  <Wallet className="h-5 w-5 text-emerald-700" />
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-foreground capitalize flex items-center gap-2">
                    {config.provider}
                    {config.isVerified ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium rounded-full px-2 py-0.5 ring-1 ring-emerald-200/60 bg-emerald-50 text-emerald-700">
                        <CheckCircle2 className="h-3 w-3" /> Verified
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium rounded-full px-2 py-0.5 ring-1 ring-amber-200/60 bg-amber-50 text-amber-700">
                        <ShieldAlert className="h-3 w-3" /> Pending
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    App Key: <span className="font-mono">{config.merchantAppKeyMasked}</span> · Username: <span className="font-mono">{config.merchantUsernameMasked}</span>
                  </p>
                </div>
              </div>
              <Button
                onClick={handleDelete}
                disabled={deleteConfig.isPending}
                variant="outline"
                size="sm"
                className="text-destructive hover:bg-rose-50 hover:border-rose-300 shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Disconnect
              </Button>
            </div>

            {config.isVerified ? (
              <div className="mt-4 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 flex items-start gap-2.5">
                <ShieldCheck className="h-4 w-4 text-emerald-700 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-medium text-emerald-800">Verified — advance payment is live</p>
                  <p className="text-xs text-emerald-700 mt-0.5">
                    Your listings can offer advance / bKash payment options to buyers.
                  </p>
                </div>
              </div>
            ) : (
              <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-2.5">
                <ShieldAlert className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-medium text-amber-800">Saved, pending verification</p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    An admin reviews new payment accounts before advance/bKash payment unlocks. Your listings stay COD-only until then.
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    );
  }

  // Setup state
  return (
    <div className="space-y-5 max-w-3xl">
      <section className="rounded-2xl border border-border bg-card overflow-hidden">
        <header className="px-5 py-4 border-b border-border/60">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-emerald-50 flex items-center justify-center shrink-0">
              <Wallet className="h-5 w-5 text-emerald-700" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Connect your bKash Merchant account</h3>
              <p className="text-xs text-muted-foreground mt-0.5">Required to offer advance or bKash payment on your listings.</p>
            </div>
          </div>
        </header>

        <div className="p-5 space-y-4">
          <div className="bg-sky-50 border border-sky-200 rounded-xl px-4 py-3 flex items-start gap-2.5">
            <Info className="h-4 w-4 text-sky-700 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium text-sky-800">Why connect bKash?</p>
              <p className="text-xs text-sky-700 mt-0.5">
                By default your listings only accept Cash on Delivery. Connecting bKash lets buyers pay online — once an admin verifies the account, advance/bKash payment becomes available.
              </p>
            </div>
          </div>

          <p className="text-xs font-medium text-muted-foreground">Find these in your bKash Merchant Panel under API Credentials.</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FieldRow label="App Key" required>
              <Input value={merchantAppKey} onChange={(e) => setMerchantAppKey(e.target.value)} className="h-10 rounded-xl" />
            </FieldRow>
            <FieldRow label="App Secret" required>
              <Input value={merchantAppSecret} onChange={(e) => setMerchantAppSecret(e.target.value)} type="password" className="h-10 rounded-xl" />
            </FieldRow>
            <FieldRow label="Merchant Username" required>
              <Input value={merchantUsername} onChange={(e) => setMerchantUsername(e.target.value)} className="h-10 rounded-xl" />
            </FieldRow>
            <FieldRow label="Merchant Password" required>
              <Input value={merchantPassword} onChange={(e) => setMerchantPassword(e.target.value)} type="password" className="h-10 rounded-xl" />
            </FieldRow>
          </div>

          <div className="pt-2 flex items-center justify-between gap-3 flex-wrap">
            <a
              href="https://developer.bka.sh/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-accent-text hover:underline"
            >
              Open bKash developer docs
              <ExternalLink className="h-3 w-3" />
            </a>
            <Button
              onClick={handleSave}
              disabled={createConfig.isPending}
              className="rounded-xl"
            >
              {createConfig.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Wallet className="h-4 w-4 mr-1.5" />}
              Connect account
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
