import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { useUser } from "@clerk/react";

/**
 * Single source of truth for "current user" lookups.
 *
 * Before this hook existed, the codebase called `useGetMe` in three
 * different places with three different option sets, all keyed on the
 * same `["me"]` query key:
 *
 *   - `App.tsx` AdminRoute:
 *       { retry: false, queryKey: ["me"], staleTime: Infinity,
 *         refetchOnMount: false, refetchOnReconnect: false }
 *   - `Navbar.tsx`:
 *       { enabled: !!user, retry: false, queryKey: ["me"] }
 *   - `ProfilePage.tsx`:
 *       { retry: false, queryKey: ["me"] }
 *
 * The `Infinity` staleTime in `AdminRoute` meant the admin gate never
 * re-fetched on its own, while `Navbar` and `ProfilePage` would. If a
 * user's role changed server-side (e.g. promoted to admin), the navbar
 * would reflect it but the admin gate wouldn't (or vice versa) —
 * depending on which subscriber happened to refetch first.
 *
 * This hook consolidates the configuration: every consumer uses the
 * same `enabled`, `retry`, `staleTime`, and `refetchOn*` settings, so
 * TanStack Query's deduplication is consistent and all subscribers see
 * the same value at the same time.
 *
 * The hook also auto-gates on `useUser().user` — the underlying
 * `GET /api/users/me` call returns 401 for unauthenticated requests,
 * which would otherwise produce error toasts and retries on every cold
 * load of a signed-out user.
 */

interface MeUser {
  id: number;
  clerkId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  role: "user" | "admin" | "seller";
  isBlocked: boolean;
  [key: string]: unknown;
}

// The canonical query key (re-exported so consumers can invalidate).
export const ME_QUERY_KEY = getGetMeQueryKey();

export function useMe() {
  const { user } = useUser();
  return useGetMe<MeUser>({
    query: {
      // Canonical key — matches what getGetMeQueryKey() returns so all
      // useGetMe callers share the same cache entry.
      queryKey: ME_QUERY_KEY,
      enabled: !!user,
      retry: false,
      // 5 minutes — matches the global queryClient default. Previously
      // AdminRoute used `Infinity` which froze the admin gate until a
      // manual invalidateQueries() call.
      staleTime: 5 * 60 * 1000,
      refetchOnMount: true,
      refetchOnReconnect: true,
      refetchOnWindowFocus: false,
    },
  });
}

export type { MeUser };
