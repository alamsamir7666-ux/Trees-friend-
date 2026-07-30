import { useState } from "react";
import {
  Truck, Loader2, Trash2, ShieldCheck, ShieldAlert, CheckCircle2,
  ExternalLink, Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  useGetMySellerCourierConfig,
  useCreateSellerCourierConfig,
  useDeleteMySellerCourierConfig,
  getGetMySellerCourierConfigQueryKey,
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

export function CourierSettingsForm() {
  const qc = useQueryClient();
  const { data: config, isLoading } = useGetMySellerCourierConfig();
  const createConfig = useCreateSellerCourierConfig();
  const deleteConfig = useDeleteMySellerCourierConfig();

  const [provider, setProvider] = useState<"pathao" | "steadfast">("pathao");
  const [apiKey, setApiKey] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [apiSecretSteadfast, setApiSecretSteadfast] = useState("");
  const [storeId, setStoreId] = useState("");

  function invalidate() {
    qc.invalidateQueries({ queryKey: getGetMySellerCourierConfigQueryKey() });
  }

  function handleSave() {
    if (!apiKey.trim()) {
      toast.error(provider === "pathao" ? "Enter your Pathao Client ID" : "Enter your Steadfast Api Key");
      return;
    }
    let apiSecret: string;
    if (provider === "pathao") {
      if (!clientSecret.trim() || !username.trim() || !password.trim()) {
        toast.error("Fill in Client Secret, Pathao username, and password");
        return;
      }
      if (!storeId.trim()) {
        toast.error("Enter your Pathao Store ID");
        return;
      }
      apiSecret = `${clientSecret.trim()}|${username.trim()}|${password.trim()}`;
    } else {
      if (!apiSecretSteadfast.trim()) {
        toast.error("Enter your Steadfast Secret Key");
        return;
      }
      apiSecret = apiSecretSteadfast.trim();
    }

    createConfig.mutate(
      { data: { provider, apiKey: apiKey.trim(), apiSecret, storeId: provider === "pathao" ? storeId.trim() : undefined } },
      {
        onSuccess: () => {
          toast.success("Courier account connected");
          setApiKey(""); setClientSecret(""); setUsername(""); setPassword(""); setApiSecretSteadfast(""); setStoreId("");
          invalidate();
        },
        onError: (err: any) => toast.error(err?.message ?? "Failed to save courier settings"),
      },
    );
  }

  function handleDelete() {
    if (!confirm("Disconnect your courier account? Orders will fall back to manual status updates.")) return;
    deleteConfig.mutate(undefined, {
      onSuccess: () => { toast.success("Courier account disconnected"); invalidate(); },
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
            <h3 className="text-sm font-semibold text-foreground">Courier Account</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Your connected courier integration</p>
          </header>
          <div className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-12 w-12 rounded-xl bg-violet-50 flex items-center justify-center shrink-0">
                  <Truck className="h-5 w-5 text-violet-700" />
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
                    Key: <span className="font-mono">{config.apiKeyMasked}</span> · Secret: <span className="font-mono">{config.apiSecretMasked}</span>
                    {config.storeId ? ` · Store ${config.storeId}` : ""}
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

            {!config.isVerified && (
              <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-2.5">
                <ShieldCheck className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-medium text-amber-800">Pending admin verification</p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    An admin needs to verify this account before you can use "Book Courier". Use manual status updates on orders until then.
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
            <div className="h-10 w-10 rounded-xl bg-violet-50 flex items-center justify-center shrink-0">
              <Truck className="h-5 w-5 text-violet-700" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Connect a courier account</h3>
              <p className="text-xs text-muted-foreground mt-0.5">Book shipments directly from your order list.</p>
            </div>
          </div>
        </header>

        <div className="p-5 space-y-4">
          {/* Info banner */}
          <div className="bg-sky-50 border border-sky-200 rounded-xl px-4 py-3 flex items-start gap-2.5">
            <Info className="h-4 w-4 text-sky-700 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium text-sky-800">Why connect a courier?</p>
              <p className="text-xs text-sky-700 mt-0.5">
                Once connected, you can click "Book courier" on any order to auto-create a shipment via Pathao or Steadfast, no manual data entry.
              </p>
            </div>
          </div>

          <FieldRow label="Courier provider" required>
            <Select value={provider} onValueChange={(v) => setProvider(v as any)}>
              <SelectTrigger className="h-10 rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pathao">Pathao</SelectItem>
                <SelectItem value="steadfast">Steadfast</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>

          {provider === "pathao" ? (
            <div className="space-y-4 pt-2 border-t border-border/60">
              <p className="text-xs font-medium text-muted-foreground">Pathao credentials — find these in your Pathao Merchant Panel.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FieldRow label="Client ID" required>
                  <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="h-10 rounded-xl" />
                </FieldRow>
                <FieldRow label="Client Secret" required>
                  <Input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} type="password" className="h-10 rounded-xl" />
                </FieldRow>
                <FieldRow label="Pathao username" required>
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} className="h-10 rounded-xl" />
                </FieldRow>
                <FieldRow label="Pathao password" required>
                  <Input value={password} onChange={(e) => setPassword(e.target.value)} type="password" className="h-10 rounded-xl" />
                </FieldRow>
              </div>
              <FieldRow
                label="Store ID"
                required
                hint="Find this in your Pathao Merchant Panel under Stores."
              >
                <Input value={storeId} onChange={(e) => setStoreId(e.target.value)} className="h-10 rounded-xl" />
              </FieldRow>
            </div>
          ) : (
            <div className="space-y-4 pt-2 border-t border-border/60">
              <p className="text-xs font-medium text-muted-foreground">Steadfast credentials — find these in your Steadfast Courier dashboard.</p>
              <FieldRow label="API Key" required>
                <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="h-10 rounded-xl" />
              </FieldRow>
              <FieldRow label="Secret Key" required>
                <Input value={apiSecretSteadfast} onChange={(e) => setApiSecretSteadfast(e.target.value)} type="password" className="h-10 rounded-xl" />
              </FieldRow>
            </div>
          )}

          <div className="pt-2 flex items-center justify-between gap-3 flex-wrap">
            <a
              href={provider === "pathao" ? "https://merchant.pathao.com" : "https://steadfast.com.bd"}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-accent-text hover:underline"
            >
              Open {provider === "pathao" ? "Pathao" : "Steadfast"} dashboard
              <ExternalLink className="h-3 w-3" />
            </a>
            <Button
              onClick={handleSave}
              disabled={createConfig.isPending}
              className="rounded-xl"
            >
              {createConfig.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Truck className="h-4 w-4 mr-1.5" />}
              Connect account
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
