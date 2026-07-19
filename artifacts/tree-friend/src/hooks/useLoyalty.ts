import { useState, useEffect } from "react";
import { useUser } from "@clerk/react";

interface LoyaltyData {
  points: number;
  takaValue: number;
  transactions: Array<{
    id: number;
    points: number;
    reason: string;
    orderId: number | null;
    createdAt: string;
  }>;
}

export function useLoyalty() {
  const { user } = useUser();
  const [data, setData] = useState<LoyaltyData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    fetch("/api/loyalty/me", { credentials: "include" })
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user]);

  return { data, loading };
}
