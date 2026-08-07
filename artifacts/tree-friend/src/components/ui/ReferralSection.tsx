import { useState } from "react";
import { Copy, Check, Users, Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useReferral } from "@/hooks/useReferral";

/**
 * Referral summary shown on the Profile page.
 *
 * Previously this component ALSO rendered an affiliate-stats panel
 * (total orders, total commission, cashout button, cashout history)
 * sourced from `/api/affiliate/me` and `/api/affiliate/cashouts`.
 * The affiliate program has been retired — the UI is removed here,
 * and the backend routes (`/api/affiliate/*`) + DB tables
 * (`affiliates`, `affiliate_cashouts`) have been removed too.
 *
 * What remains: the referral code display, share stats, copy-link,
 * and WhatsApp share button — all powered by `useReferral()` which
 * hits `/api/referrals/my-code`.
 */
export function ReferralSection() {
  const { data, loading } = useReferral();
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (!data?.shareUrl) return;
    navigator.clipboard.writeText(data.shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  if (loading) {
    return <div className="space-y-4"><div className="h-32 rounded-2xl bg-muted animate-pulse" /></div>;
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      {/* Referral Section */}
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
            {copied ? <><Check className="h-4 w-4 text-success-foreground" />Copied!</> : <><Copy className="h-4 w-4" />Copy Link</>}
          </Button>
        </div>

        <a
          href={`https://wa.me/?text=${encodeURIComponent(`Hey! Use my code ${data.code} for Tk100 off your first order at Tree Friend - quality trees & plants for your home! ${data.shareUrl}`)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 w-full flex items-center justify-center gap-2 bg-success-foreground hover:bg-success-foreground/90 text-success text-sm font-medium py-2.5 px-4 rounded-xl transition-colors"
        >
          <Gift className="h-4 w-4" />
          Share on WhatsApp
        </a>
      </div>
    </div>
  );
}
