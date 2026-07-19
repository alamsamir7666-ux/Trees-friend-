import { useState, useEffect } from "react";
import { useAuth } from "@clerk/react";
const API = import.meta.env.VITE_API_BASE_URL ?? "";
import { Copy, Check, Users, Gift, TrendingUp, ShoppingBag, DollarSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useReferral } from "@/hooks/useReferral";

export function ReferralSection() {
  const { data, loading } = useReferral();
  const { getToken } = useAuth();
  const [copied, setCopied] = useState(false);
  const [affiliate, setAffiliate] = useState<any>(null);
  const [affiliateLoading, setAffiliateLoading] = useState(true);
  const [cashouts, setCashouts] = useState<any[]>([]);
  const [cashoutLoading, setCashoutLoading] = useState(false);
  const [cashoutError, setCashoutError] = useState("");
  const [cashoutSuccess, setCashoutSuccess] = useState(false);
  useEffect(() => {
    if (!affiliate) return;
    getToken().then(token =>
      fetch(`${API}/api/affiliate/cashouts`, { headers: { Authorization: "Bearer " + token } })
        .then(res => res.ok ? res.json() : [])
        .then(data => setCashouts(data))
        .catch(() => {})
    );
  }, [affiliate]);

  async function handleCashout() {
    setCashoutLoading(true);
    setCashoutError("");
    setCashoutSuccess(false);
    try {
      const token = await getToken();
      const res = await fetch(`${API}/api/affiliate/cashout`, {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
      });
      const data = await res.json();
      if (!res.ok) { setCashoutError(data.error ?? "Failed"); return; }
      setCashoutSuccess(true);
      setCashouts(prev => [data, ...prev]);
    } catch { setCashoutError("Something went wrong"); }
    finally { setCashoutLoading(false); }
  }

  useEffect(() => {
    getToken().then(token =>
      fetch(`${API}/api/affiliate/me`, { headers: { Authorization: "Bearer " + token } })
        .then(res => { console.log("[affiliate/me] status:", res.status); return res.ok ? res.json() : null; })
    )
      .then(data => { console.log("[affiliate/me] data:", data); setAffiliate(data); })
      .catch(e => { console.log("[affiliate/me] error:", e); setAffiliate(null); })
      .finally(() => setAffiliateLoading(false));
  }, []);

  function handleCopy() {
    if (!data?.shareUrl) return;
    navigator.clipboard.writeText(data.shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  if (loading || affiliateLoading) {
    return <div className="space-y-4"><div className="h-32 rounded-2xl bg-muted animate-pulse" /><div className="h-32 rounded-2xl bg-muted animate-pulse" /></div>;
  }

  return (
    <div className="space-y-4">
      {/* Affiliate Stats - only shown if user is an affiliate */}
      {affiliate && (
        <div className="rounded-2xl border bg-gradient-to-br from-amber-50/50 to-background p-6">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="h-5 w-5 text-amber-600" />
            <h3 className="font-semibold text-base">Your Affiliate Stats</h3>
            <span className={`ml-auto text-xs px-2 py-0.5 rounded-full font-medium ${affiliate.isActive ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>
              {affiliate.isActive ? "Active" : "Inactive"}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Your affiliate code: <strong className="font-mono tracking-wider text-foreground">{affiliate.code}</strong>
          </p>

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-muted/50 p-3 text-center">
              <ShoppingBag className="h-4 w-4 text-amber-600 mx-auto mb-1" />
              <p className="text-xl font-bold text-amber-600">{affiliate.totalOrders}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Orders</p>
            </div>

            <div className="rounded-xl bg-muted/50 p-3 text-center">
              <TrendingUp className="h-4 w-4 text-amber-600 mx-auto mb-1" />
              <p className="text-xl font-bold text-amber-600">Tk{affiliate.totalCommission.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Commission</p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground mt-3 text-center">
            Commission rate: {affiliate.commissionRate}% per sale
          </p>

          {/* Cashout button */}
          <div className="mt-4">
            {cashoutError && <p className="text-xs text-destructive text-center mb-2">{cashoutError}</p>}
            {cashoutSuccess && <p className="text-xs text-green-600 text-center mb-2">Cashout request sent! Admin will process it soon.</p>}
            <Button
              className="w-full rounded-full"
              disabled={cashoutLoading || affiliate.totalCommission < 500 || cashouts.some((c: any) => c.status === "pending")}
              onClick={handleCashout}
            >
              {cashoutLoading ? "Sending..." :
               cashouts.some((c: any) => c.status === "pending") ? "Cashout Pending..." :
               affiliate.totalCommission < 500 ? `Need Tk${(500 - affiliate.totalCommission).toFixed(0)} more to cashout` :
               `Request Cashout (Tk${Number(affiliate.totalCommission).toLocaleString()})`}
            </Button>
          </div>

          {/* Cashout history */}
          {cashouts.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cashout History</p>
              {cashouts.map((co: any) => (
                <div key={co.id} className="flex items-center justify-between text-sm bg-muted/40 rounded-xl px-3 py-2">
                  <div>
                    <p className="font-medium">Tk{Number(co.amount).toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">{new Date(co.createdAt).toLocaleDateString()}</p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    co.status === "approved" ? "bg-green-100 text-green-700" :
                    co.status === "rejected" ? "bg-red-100 text-red-600" :
                    "bg-yellow-100 text-yellow-700"
                  }`}>{co.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Referral Section */}
      {data && (
        <div className="rounded-2xl border bg-gradient-to-br from-accent/5 to-background p-6">
          <div className="flex items-center gap-2 mb-1">
            <Users className="h-5 w-5 text-accent" />
            <h3 className="font-semibold text-base">Refer & Earn</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Share your code. Your friend gets <strong>Tk100 off</strong> their first order, and you earn <strong>100 loyalty points</strong>.
          </p>

          <div className="grid grid-cols-2 gap-3 mb-5">
            <div className="rounded-xl bg-muted/50 p-3 text-center">
              <p className="text-2xl font-bold text-accent">{data.successfulReferrals}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Successful Referrals</p>
            </div>
            <div className="rounded-xl bg-muted/50 p-3 text-center">
              <p className="text-2xl font-bold text-accent">{data.earnedPoints}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Points Earned</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1 bg-muted rounded-xl px-4 py-2.5 font-mono text-sm font-semibold tracking-widest text-center select-all">
              {data.code}
            </div>
            <Button size="sm" variant="outline" className="rounded-xl gap-1.5 shrink-0" onClick={handleCopy} aria-label="Copy referral link">
              {copied ? <><Check className="h-4 w-4 text-green-500" />Copied!</> : <><Copy className="h-4 w-4" />Copy Link</>}
            </Button>
          </div>

          <a
            href={`https://wa.me/?text=${encodeURIComponent(`Hey! Use my code ${data.code} for Tk100 off your first order at Tree Friend - quality trees & plants for your home! ${data.shareUrl}`)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 w-full flex items-center justify-center gap-2 bg-green-500 hover:bg-green-600 text-white text-sm font-medium py-2.5 px-4 rounded-xl transition-colors"
          >
            <Gift className="h-4 w-4" />
            Share on WhatsApp
          </a>
        </div>
      )}
    </div>
  );
}
