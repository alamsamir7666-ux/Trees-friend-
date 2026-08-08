import { useState, useEffect } from "react";
import { useUser } from "@clerk/react";
import { apiClient } from "@/lib/apiClient";

interface LoyaltyData {
  points: number;
  takaValue: number;
  transactions: {
    id: number;
    points: number;
    reason: string;
    orderId: number | null;
    createdAt: string;
  }[];
}

/**
 * Fetches the signed-in user's loyalty-points balance and transaction
 * ledger.
 *
 * Previously this hook used `fetch("/api/loyalty/me", { credentials:
 * "include" })` — no `Authorization: Bearer` header and no
 * `VITE_API_BASE_URL` prefix. On Vercel that URL resolves to the SPA
 * shell (index.html), `r.json()` throws on the HTML response, and the
 * `.catch(() => {})` swallowed the error — so the hook silently
 * returned `data: null` forever. Loyalty-points redemption on the
 * checkout page and the LoyaltyBanner on the profile were both dead.
 *
 * Now uses `apiClient.get`, which prepends `VITE_API_BASE_URL` and
 * attaches the Bearer token via the shared `getToken()` registered on
 * app boot. The same pattern the generated client uses for the rest of
 * the authenticated endpoints.
 */
export function useLoyalty() {
  const { user } = useUser();
  const [data, setData] = useState<LoyaltyData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiClient
      .get<LoyaltyData>("/loyalty/me")
      .then(({ data: d }) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load loyalty");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  return { data, loading, error };
}
