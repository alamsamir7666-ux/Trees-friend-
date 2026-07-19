import { useState, useEffect, memo } from "react";
import { Zap } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/apiClient";
import { ProductCard } from "@/components/ui/ProductCard";
import type { Product } from "@workspace/api-client-react";

function useCountdown(targetMs: number) {
  const [remaining, setRemaining] = useState(Math.max(0, targetMs - Date.now()));

  useEffect(() => {
    if (remaining <= 0) return;
    const interval = setInterval(() => {
      const r = Math.max(0, targetMs - Date.now());
      setRemaining(r);
      if (r === 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [targetMs]);

  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return { hours, minutes, seconds, expired: remaining === 0 };
}

function TimeBox({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col items-center bg-card border border-border rounded-xl px-3 py-2 min-w-[48px]">
      <span className="text-lg font-bold tabular-nums leading-none">
        {String(value).padStart(2, "0")}
      </span>
      <span className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">
        {label}
      </span>
    </div>
  );
}

// Flash sale ends at midnight every day
function getMidnight() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function FlashSaleSectionInner() {
  const { hours, minutes, seconds, expired } = useCountdown(getMidnight());

  const { data: products = [], isLoading } = useQuery({
    queryKey: ["flash-sales"],
    queryFn: () => apiClient.get<Product[]>("/api/flash-sales").then((r) => r.data),
    staleTime: 1000 * 60 * 2,
  });

  if (!isLoading && products.length === 0) return null;

  return (
    <section className="py-12 px-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-accent/10 rounded-xl">
              <Zap className="h-5 w-5 text-accent fill-accent" />
            </div>
            <div>
              <h2 className="font-serif text-2xl">Flash Sale</h2>
              <p className="text-sm text-muted-foreground">Limited time deals</p>
            </div>
          </div>

          {!expired && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground mr-1">Ends in</span>
              <TimeBox value={hours} label="hrs" />
              <span className="text-lg font-bold text-muted-foreground">:</span>
              <TimeBox value={minutes} label="min" />
              <span className="text-lg font-bold text-muted-foreground">:</span>
              <TimeBox value={seconds} label="sec" />
            </div>
          )}
        </div>

        {/* Products grid */}
        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="aspect-square bg-muted animate-pulse rounded-2xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {products.map((product: any, i: number) => (
              <ProductCard
                key={product.id}
                product={product}
                backContext="flash-sale"
                priority={i < 2}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export const FlashSaleSection = memo(FlashSaleSectionInner);
