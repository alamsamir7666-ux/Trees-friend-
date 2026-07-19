import { useState, useEffect } from "react";
import { useUser } from "@clerk/react";

interface ReferralData {
  code: string;
  totalReferrals: number;
  successfulReferrals: number;
  earnedPoints: number;
  shareUrl: string;
}

export function useReferral() {
  const { user } = useUser();
  const [data, setData] = useState<ReferralData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    fetch("/api/referrals/my-code", { credentials: "include" })
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user]);

  async function applyReferralCode(code: string) {
    const r = await fetch("/api/referrals/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ code }),
    });
    return r.json();
  }

  return { data, loading, applyReferralCode };
}
