import { useEffect, useState } from "react";
import { Users, Copy, Check, Share2, Gift } from "lucide-react";
import { updateSEO } from "@/lib/seo";
import { useUser } from "@clerk/react";
import { apiClient } from "@/lib/apiClient";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";

type ReferralCodeResponse = {
  code: string;
  totalReferrals: number;
  successfulReferrals: number;
  earnedPoints: number;
  shareUrl: string;
};

export default function ReferralPage() {
  const { user } = useUser();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["referral-code"],
    queryFn: () =>
      apiClient.get<ReferralCodeResponse>("/api/referrals/my-code").then((r) => r.data),
    enabled: !!user,
  });

  useEffect(() => {
    updateSEO({ title: "Refer & Earn", noIndex: true });
  }, []);

  function handleCopy() {
    if (!data?.shareUrl) return;
    navigator.clipboard.writeText(data.shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Link copied!", description: "Share it with your friends." });
    });
  }

  function handleShare() {
    if (!data?.shareUrl) return;
    if (navigator.share) {
      navigator.share({
        title: "Join Tree Friend",
        text: "Use my referral link and get Tk100 off your first order!",
        url: data.shareUrl,
      });
    } else {
      handleCopy();
    }
  }

  if (!user) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center">
          <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <h2 className="font-serif text-xl mb-2">Sign in to refer friends</h2>
          <Link href="/sign-in" className="text-accent underline underline-offset-4 text-sm">Sign In</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <PageBreadcrumb crumbs={[{ label: "Refer & Earn", icon: <Users className="h-3 w-3" /> }]} className="mb-4" />
      <h1 className="font-serif text-3xl mb-2">Refer & Earn</h1>
      <p className="text-muted-foreground text-sm mb-8">
        Share your unique link. Your friend gets Tk100 off. You earn 100 loyalty points.
      </p>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        <div className="bg-card border border-border rounded-2xl p-5 text-center">
          <p className="text-3xl font-bold text-accent">{data?.totalReferrals ?? 0}</p>
          <p className="text-sm text-muted-foreground mt-1">Friends Referred</p>
        </div>
        <div className="bg-card border border-border rounded-2xl p-5 text-center">
          <p className="text-3xl font-bold text-green-600">{data?.successfulReferrals ?? 0}</p>
          <p className="text-sm text-muted-foreground mt-1">Successful Orders</p>
        </div>
      </div>

      {/* Share card */}
      <div className="bg-gradient-to-br from-accent/10 to-pink-100/50 dark:from-accent/5 dark:to-pink-900/10 border border-accent/20 rounded-2xl p-6 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Gift className="h-5 w-5 text-accent" />
          <span className="font-medium">Your Referral Link</span>
        </div>

        {isLoading ? (
          <div className="h-12 bg-muted/50 animate-pulse rounded-xl" />
        ) : (
          <div className="flex gap-2">
            <div className="flex-1 bg-background border border-border rounded-xl px-4 py-3 text-sm font-mono text-muted-foreground truncate">
              {data?.shareUrl}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleCopy}
              className="shrink-0 rounded-xl"
            >
              {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        )}

        <div className="flex gap-3 mt-4">
          <Button className="flex-1 rounded-full" onClick={handleShare}>
            <Share2 className="h-4 w-4 mr-2" />
            Share Link
          </Button>
          <Button variant="outline" className="flex-1 rounded-full" onClick={handleCopy}>
            {copied ? "Copied!" : "Copy Link"}
          </Button>
        </div>
      </div>

      {/* How it works */}
      <h2 className="font-serif text-lg mb-4">How it works</h2>
      <ol className="space-y-3">
        {[
          "Share your unique link with friends",
          "They sign up and get Tk100 off their first order",
          "When they complete their first purchase, you earn 100 loyalty points",
          "Redeem your points for discounts on future orders",
        ].map((step, i) => (
          <li key={i} className="flex gap-3 text-sm">
            <span className="w-6 h-6 rounded-full bg-accent/20 text-accent flex items-center justify-center font-semibold text-xs shrink-0 mt-0.5">
              {i + 1}
            </span>
            <span className="text-muted-foreground">{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
