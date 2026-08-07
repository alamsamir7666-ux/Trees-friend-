import { useState, useEffect } from "react";
import { useApiFetch } from "@/lib/useApiFetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, ShieldCheck, ShieldAlert, KeyRound } from "lucide-react";
import { toast } from "sonner";

/**
 * Admin UI for the platform's single bKash merchant config -- Part 4 of 4
 * (see PART4_HANDOFF.md, item 1). Part 1 built the GET/POST routes but
 * explicitly deferred any admin-facing UI to this part (see
 * PART1_HANDOFF.md's own "Open items"); this is that UI, plus the new
 * "Test Connection" action that's the actual point of this whole section
 * -- isVerified is the single flag every bKash checkout (Part 2) and
 * payout (Part 3) call is gated behind, and until this button existed,
 * nothing anywhere in this codebase could ever set it true.
 *
 * Follows CashoutsSection.tsx's own raw-fetch + getToken() pattern
 * (fetch-on-mount, no generated api-client-react hooks) rather than
 * introducing a mix of both approaches for this one section -- the new
 * `/verify` route has no generated hook yet either way (it didn't exist
 * before this part), so there's no codegen step this skips that the rest
 * of this section would otherwise need.
 *
 * Two independent states this component can be in:
 *  - No config row yet (GET 404) -- show a create form (4 credential
 *    fields, matches the OLD per-seller form's shape exactly, since this
 *    is the same bKash Merchant/Checkout credential set, just admin-held).
 *  - A config row exists -- show it masked (server already masks these,
 *    never sends raw secrets to the browser) with its isVerified badge and
 *    the Test Connection button, plus a "Replace Credentials" affordance
 *    that reuses the same form (POST is create-or-replace, per Part 1's
 *    delete-then-insert convention -- confirmed by reading
 *    routes/platformPaymentConfig.ts before writing this).
 */
export function PlatformPaymentConfigSection() {
  const apiFetch = useApiFetch();
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    merchantAppKey: "",
    merchantAppSecret: "",
    merchantUsername: "",
    merchantPassword: "",
  });

  async function fetchConfig() {
    setLoading(true);
    try {
      const r = await apiFetch("/api/platform-payment-config");
      if (r.status === 404) {
        setConfig(null);
      } else {
        const d = await r.json();
        if (d) setConfig(d);
      }
    } catch {} finally { setLoading(false); }
  }

  useEffect(() => {
    fetchConfig();
  }, []);

  async function handleSave() {
    if (!form.merchantAppKey.trim() || !form.merchantAppSecret.trim() || !form.merchantUsername.trim() || !form.merchantPassword.trim()) {
      toast.error("All four credential fields are required");
      return;
    }
    setSaving(true);
    try {
      const r = await apiFetch("/api/platform-payment-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "bkash", ...form }),
      });
      const data = await r.json();
      if (!r.ok) {
        toast.error(data?.error ?? "Failed to save platform payment config");
        return;
      }
      toast.success("Platform bKash credentials saved. Verify the connection below before checkout/payouts can use them.");
      setConfig(data);
      setShowForm(false);
      setForm({ merchantAppKey: "", merchantAppSecret: "", merchantUsername: "", merchantPassword: "" });
    } finally {
      setSaving(false);
    }
  }

  // Grant Token is bKash's pure auth handshake -- no money moves, no
  // payment intent is created (see routes/platformPaymentConfig.ts's own
  // doc comment on this route). Safe to call as often as the admin wants,
  // e.g. immediately after rotating credentials above.
  async function handleVerify() {
    setVerifying(true);
    try {
      const r = await apiFetch("/api/admin/platform-payment-config/verify", {
        method: "POST",
      });
      const data = await r.json();
      if (!r.ok) {
        toast.error(data?.error ?? "Verification failed", {
          description: data?.step ? `Failed at step: ${data.step}` : undefined,
        });
        return;
      }
      toast.success("Connection verified -- bKash checkout and payouts are now live.");
      setConfig(data);
    } finally {
      setVerifying(false);
    }
  }

  if (loading) return <div className="h-32 rounded-xl bg-muted animate-pulse" />;

  return (
    <div>
      <h3 className="font-semibold text-base mb-1 flex items-center gap-2">
        <KeyRound className="h-4 w-4" />
        Platform bKash Merchant Account
      </h3>
      <p className="text-sm text-muted-foreground mb-4">
        The platform's single bKash merchant account. Buyers pay into this account at checkout; sellers are paid out
        separately after delivery. This must be verified before bKash checkout or payouts can do anything.
      </p>

      {!config || showForm ? (
        <div className="border rounded-xl p-4 space-y-3 bg-card">
          {config && (
            <p className="text-xs text-warning-foreground bg-warning rounded-lg px-3 py-2">
              Saving new credentials replaces the existing ones and resets verification -- you'll need to Test
              Connection again.
            </p>
          )}
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">App Key</Label>
              <Input
                value={form.merchantAppKey}
                onChange={(e) => setForm((f) => ({ ...f, merchantAppKey: e.target.value }))}
                className="mt-1 h-9 rounded-lg text-sm"
                autoComplete="off"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">App Secret</Label>
              <Input
                type="password"
                value={form.merchantAppSecret}
                onChange={(e) => setForm((f) => ({ ...f, merchantAppSecret: e.target.value }))}
                className="mt-1 h-9 rounded-lg text-sm"
                autoComplete="off"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Merchant Username</Label>
              <Input
                value={form.merchantUsername}
                onChange={(e) => setForm((f) => ({ ...f, merchantUsername: e.target.value }))}
                className="mt-1 h-9 rounded-lg text-sm"
                autoComplete="off"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Merchant Password</Label>
              <Input
                type="password"
                value={form.merchantPassword}
                onChange={(e) => setForm((f) => ({ ...f, merchantPassword: e.target.value }))}
                className="mt-1 h-9 rounded-lg text-sm"
                autoComplete="off"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={saving} className="rounded-full gap-1.5">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save Credentials
            </Button>
            {config && (
              <Button variant="outline" className="rounded-full" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="border rounded-xl p-4 bg-card space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-sm font-medium">bKash merchant account configured</p>
              <p className="text-xs text-muted-foreground">
                App Key: {config.merchantAppKeyMasked} &middot; Username: {config.merchantUsernameMasked}
              </p>
            </div>
            {config.isVerified ? (
              <span className="text-xs px-2.5 py-1 rounded-full font-medium bg-success text-success-foreground flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5" /> Verified &mdash; live
              </span>
            ) : (
              <span className="text-xs px-2.5 py-1 rounded-full font-medium bg-destructive/10 text-destructive flex items-center gap-1">
                <ShieldAlert className="h-3.5 w-3.5" /> Not verified &mdash; checkout/payouts blocked
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button onClick={handleVerify} disabled={verifying} className="rounded-full gap-1.5">
              {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Test Connection
            </Button>
            <Button variant="outline" className="rounded-full" onClick={() => setShowForm(true)}>
              Replace Credentials
            </Button>
          </div>
          {!config.isVerified && (
            <p className="text-xs text-muted-foreground">
              Click Test Connection to confirm these credentials work against bKash. No money moves and no payment is
              created by this check -- it's safe to run as often as you like, including right after rotating
              credentials.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
