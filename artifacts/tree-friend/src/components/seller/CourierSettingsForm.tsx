import { useState } from "react";
import { Truck, Loader2, Trash2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

/**
 * Courier Settings (plan doc §4, §8 — Part 4). Lets a seller connect a
 * Pathao or Steadfast merchant account so "Book Courier" on an order can
 * call that courier's API directly, instead of falling back to manual
 * status updates.
 *
 * Pathao's form asks for 4 fields (Client ID / Client Secret / Pathao
 * username+password / Store ID) because Pathao's OAuth needs all 4, while
 * seller_courier_configs only has 2 credential columns -- this form packs
 * clientSecret+username+password into one string before sending, matching
 * the "clientSecret|username|password" convention documented in
 * lib/courierAdapters/pathao.ts and enforced by the backend route.
 */
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
    return <div className="h-40 rounded-2xl bg-muted animate-pulse" />;
  }

  if (config) {
    return (
      <div className="bg-card rounded-2xl border p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-10 w-10 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
              <Truck className="h-5 w-5 text-accent" />
            </div>
            <div>
              <p className="font-medium text-sm capitalize">{config.provider}</p>
              <p className="text-xs text-muted-foreground">
                Key: {config.apiKeyMasked} · Secret: {config.apiSecretMasked}
                {config.storeId ? ` · Store ${config.storeId}` : ""}
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
        {!config.isVerified && (
          <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mt-3 flex items-start gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            Not verified yet — an admin needs to verify this account before you can use "Book Courier". Use manual status updates on orders until then.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="bg-card rounded-2xl border p-5">
      <div className="flex items-center gap-2.5 mb-4">
        <div className="h-10 w-10 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
          <Truck className="h-5 w-5 text-accent" />
        </div>
        <div>
          <p className="font-medium text-sm">Connect a courier account</p>
          <p className="text-xs text-muted-foreground">Book shipments directly from your order list.</p>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <Label className="text-xs text-muted-foreground">Courier</Label>
          <Select value={provider} onValueChange={(v) => setProvider(v as any)}>
            <SelectTrigger className="mt-1 h-9 rounded-lg text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pathao">Pathao</SelectItem>
              <SelectItem value="steadfast">Steadfast</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {provider === "pathao" ? (
          <>
            <div>
              <Label className="text-xs text-muted-foreground">Client ID</Label>
              <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="mt-1 h-9 rounded-lg text-sm" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Client Secret</Label>
              <Input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} type="password" className="mt-1 h-9 rounded-lg text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">Pathao username</Label>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} className="mt-1 h-9 rounded-lg text-sm" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Pathao password</Label>
                <Input value={password} onChange={(e) => setPassword(e.target.value)} type="password" className="mt-1 h-9 rounded-lg text-sm" />
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Store ID</Label>
              <Input value={storeId} onChange={(e) => setStoreId(e.target.value)} className="mt-1 h-9 rounded-lg text-sm" />
              <p className="text-xs text-muted-foreground mt-1">Find this in your Pathao Merchant Panel under Stores.</p>
            </div>
          </>
        ) : (
          <>
            <div>
              <Label className="text-xs text-muted-foreground">Api Key</Label>
              <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="mt-1 h-9 rounded-lg text-sm" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Secret Key</Label>
              <Input value={apiSecretSteadfast} onChange={(e) => setApiSecretSteadfast(e.target.value)} type="password" className="mt-1 h-9 rounded-lg text-sm" />
            </div>
          </>
        )}

        <Button onClick={handleSave} disabled={createConfig.isPending} className="w-full rounded-full gap-1.5 mt-2">
          {createConfig.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
          Connect
        </Button>
      </div>
    </div>
  );
}
