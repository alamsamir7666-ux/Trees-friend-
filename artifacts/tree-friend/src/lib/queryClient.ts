import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 5 minutes stale time - data stays fresh, reduces unnecessary refetches
      staleTime: 1000 * 60 * 5,
      // Keep unused data in cache for 10 minutes
      gcTime: 1000 * 60 * 10,
      // Only retry once on failure (default is 3, which causes slow UX on real errors)
      retry: 1,
      // Don't refetch on window focus for better UX (prevents jarring refreshes)
      refetchOnWindowFocus: false,
      // Refetch on reconnect is still useful
      refetchOnReconnect: true,
    },
    mutations: {
      // Don't retry mutations by default (idempotency concerns)
      retry: 0,
    },
  },
});
