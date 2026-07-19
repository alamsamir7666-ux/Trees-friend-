import { useEffect } from "react";
import { Gift, Star, TrendingUp, ShoppingBag } from "lucide-react";
import { updateSEO } from "@/lib/seo";
import { useUser, useAuth } from "@clerk/react";
import { apiClient } from "@/lib/apiClient";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";

function PointsBadge({ points }: { points: number }) {
  return (
    <div className="relative bg-gradient-to-br from-accent to-pink-400 rounded-2xl p-6 text-white overflow-hidden">
      <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -translate-y-1/2 translate-x-1/2" />
      <div className="absolute bottom-0 left-0 w-20 h-20 bg-white/10 rounded-full translate-y-1/2 -translate-x-1/2" />
      <div className="relative">
        <div className="flex items-center gap-2 mb-1">
          <Star className="h-4 w-4 fill-white" />
          <span className="text-sm font-medium opacity-90">Your Balance</span>
        </div>
        <p className="text-4xl font-bold tracking-tight">{points.toLocaleString()}</p>
        <p className="text-sm opacity-80 mt-1">points = Tk{points.toLocaleString()} discount</p>
      </div>
    </div>
  );
}

export default function LoyaltyPage() {
  const { user } = useUser();
  const { getToken } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ["loyalty"],
    queryFn: async () => {
      const token = await getToken();
      const res = await fetch(
        (import.meta.env.VITE_API_BASE_URL ?? "") + "/api/loyalty/me",
        { headers: { Authorization: "Bearer " + token } }
      );
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!user,
  });

  useEffect(() => {
    updateSEO({ title: "Loyalty Points", noIndex: true });
  }, []);

  if (!user) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center">
          <Gift className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <h2 className="font-serif text-xl mb-2">Sign in to view your points</h2>
          <Link href="/sign-in" className="text-accent underline underline-offset-4 text-sm">Sign In</Link>
        </div>
      </div>
    );
  }

  const points = data?.points ?? 0;
  const transactions = data?.transactions ?? [];

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <PageBreadcrumb crumbs={[{ label: "Loyalty Points", icon: <Star className="h-3 w-3" /> }]} className="mb-4" />
      <h1 className="font-serif text-3xl mb-2">Loyalty Points</h1>
      <p className="text-muted-foreground text-sm mb-8">Earn 1 point for every Tk100 spent. Redeem at checkout.</p>

      {isLoading ? (
        <div className="h-32 bg-muted animate-pulse rounded-2xl mb-8" />
      ) : (
        <div className="mb-8">
          <PointsBadge points={points} />
        </div>
      )}

      {/* How it works */}
      <div className="grid grid-cols-3 gap-4 mb-10">
        {[
          { icon: ShoppingBag, label: "Shop", desc: "Place any order" },
          { icon: Star, label: "Earn", desc: "1 pt per Tk100" },
          { icon: Gift, label: "Redeem", desc: "Tk1 per point" },
        ].map(({ icon: Icon, label, desc }) => (
          <div key={label} className="text-center p-4 bg-muted/30 rounded-2xl">
            <Icon className="h-6 w-6 mx-auto mb-2 text-accent" />
            <p className="font-medium text-sm">{label}</p>
            <p className="text-xs text-muted-foreground">{desc}</p>
          </div>
        ))}
      </div>

      {/* Transaction history */}
      <h2 className="font-serif text-xl mb-4">Transaction History</h2>
      {transactions.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <TrendingUp className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No transactions yet. Start shopping to earn points!</p>
          <Link href="/products" className="text-accent text-sm underline underline-offset-4 mt-2 inline-block">
            Browse Products
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {transactions.map((t: any) => (
            <div
              key={t.id}
              className="flex items-center justify-between p-4 bg-card border border-border rounded-xl"
            >
              <div>
                <p className="text-sm font-medium capitalize">
                  {t.reason.replace(/_/g, " ")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(t.createdAt).toLocaleDateString("en-BD", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </div>
              <span
                className={`font-semibold text-sm ${
                  t.points > 0 ? "text-green-600" : "text-destructive"
                }`}
              >
                {t.points > 0 ? "+" : ""}{t.points} pts
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
