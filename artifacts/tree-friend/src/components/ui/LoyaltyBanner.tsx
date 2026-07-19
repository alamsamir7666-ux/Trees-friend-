import { Star, Gift } from "lucide-react";
import { useLoyalty } from "@/hooks/useLoyalty";
import { Link } from "wouter";

export function LoyaltyBanner() {
  const { data, loading } = useLoyalty();
  if (loading || !data) return null;

  return (
    <div className="flex items-center gap-3 bg-gradient-to-r from-accent/10 to-accent/5 border border-accent/20 rounded-xl px-4 py-3 text-sm">
      <div className="h-8 w-8 rounded-full bg-accent/20 flex items-center justify-center flex-shrink-0">
        <Star className="h-4 w-4 text-accent fill-accent" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-foreground">
          {data.points} Loyalty Points
          <span className="text-muted-foreground font-normal ml-1.5">
            = Tk{data.takaValue} discount
          </span>
        </p>
        <p className="text-xs text-muted-foreground">Earn 1 point per Tk100 spent</p>
      </div>
      <Link href="/loyalty" className="text-xs text-accent hover:underline whitespace-nowrap flex items-center gap-1">
        <Gift className="h-3.5 w-3.5" />
        Redeem
      </Link>
    </div>
  );
}
