import { useState, useEffect } from "react";
import { Zap } from "lucide-react";
import { Link } from "wouter";

function useCountdown(targetDate: Date) {
  const [timeLeft, setTimeLeft] = useState({ hours: 0, minutes: 0, seconds: 0, expired: false });

  useEffect(() => {
    function tick() {
      const diff = targetDate.getTime() - Date.now();
      if (diff <= 0) {
        setTimeLeft({ hours: 0, minutes: 0, seconds: 0, expired: true });
        return;
      }
      const hours = Math.floor(diff / 3_600_000);
      const minutes = Math.floor((diff % 3_600_000) / 60_000);
      const seconds = Math.floor((diff % 60_000) / 1_000);
      setTimeLeft({ hours, minutes, seconds, expired: false });
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetDate]);

  return timeLeft;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

interface FlashSaleBannerProps {
  label?: string;
  endsAt: Date;
  href?: string;
}

export function FlashSaleBanner({
  label = "Flash Sale",
  endsAt,
  href = "/products",
}: FlashSaleBannerProps) {
  const { hours, minutes, seconds, expired } = useCountdown(endsAt);
  if (expired) return null;

  return (
    <div className="bg-gradient-to-r from-rose-600 to-pink-500 text-white">
      <Link href={href}>
        <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center justify-center gap-4 text-sm cursor-pointer">
          <div className="flex items-center gap-1.5 font-semibold">
            <Zap className="h-4 w-4 fill-current animate-pulse" />
            {label}
          </div>
          <span className="opacity-70 hidden sm:inline">Ends in</span>
          <div className="flex items-center gap-1 font-mono font-bold">
            <span className="bg-white/20 rounded px-1.5 py-0.5">{pad(hours)}</span>
            <span>:</span>
            <span className="bg-white/20 rounded px-1.5 py-0.5">{pad(minutes)}</span>
            <span>:</span>
            <span className="bg-white/20 rounded px-1.5 py-0.5">{pad(seconds)}</span>
          </div>
          <span className="hidden sm:inline text-white/80 text-xs">→ Shop Now</span>
        </div>
      </Link>
    </div>
  );
}
