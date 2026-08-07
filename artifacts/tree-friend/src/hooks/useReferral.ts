import { useState, useEffect, useCallback } from "react";
import { useUser } from "@clerk/react";
import { apiClient } from "@/lib/apiClient";

interface ReferralData {
  code: string;
  totalReferrals: number;
  successfulReferrals: number;
  earnedPoints: number;
  shareUrl: string;
}

interface ApplyReferralResponse {
  success?: boolean;
  error?: string;
}

/**
 * Fetches the signed-in user's referral code + stats.
 *
 * Previously this hook used `fetch("/api/referrals/my-code", { credentials:
 * "include" })` — no Bearer token, no `VITE_API_BASE_URL` prefix. On Vercel
 * the URL resolved to the SPA shell, the response was HTML, and the
 * `.catch(() => {})` swallowed the resulting JSON parse error. The
 * ReferralSection on the profile page silently rendered nothing.
 *
 * Now uses `apiClient`, which prepends `VITE_API_BASE_URL` and attaches
 * the Bearer token. `applyReferralCode` returns a typed response so the
 * caller can branch on `success`/`error` instead of always treating the
 * payload as `any`.
 */
export function useReferral() {
  const { user } = useUser();
  const [data, setData] = useState<ReferralData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiClient
      .get<ReferralData>("/referrals/my-code")
      .then(({ data: d }) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load referral code");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const applyReferralCode = useCallback(async (code: string): Promise<ApplyReferralResponse> => {
    try {
      const { data: result } = await apiClient.post<ApplyReferralResponse>(
        "/referrals/apply",
        { code },
      );
      return result ?? { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Failed to apply referral code",
      };
    }
  }, []);

  return { data, loading, error, applyReferralCode };
}
