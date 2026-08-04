import { useRef, useEffect, useCallback } from "react";

/**
 * useInfiniteScroll — IntersectionObserver-based "load more on scroll" for
 * horizontal carousels and vertical lists.
 *
 * Attach the returned `sentinelRef` to a sentinel element placed at the END
 * of your scrollable list. When that sentinel scrolls into view (i.e. the
 * user has scrolled near the end), `onLoadMore` fires.
 *
 * Designed for the Browse All Trees page where each category section has a
 * horizontal carousel — the sentinel sits as the last "card" in the row,
 * so swiping to the end triggers the next page load automatically.
 *
 * Industry-standard pattern used by WhatsApp's message history, Twitter's
 * feed, Instagram's explore grid, etc.
 *
 * @param onLoadMore  Called when the sentinel enters the viewport. The
 *                    caller is responsible for guarding against duplicate
 *                    fires (e.g. checking `hasNextPage` + `isFetching`
 *                    before issuing the request).
 * @param options.enabled  When false, the observer is torn down and no
 *                    fires happen. Use this to disable once all data is
 *                    loaded (`hasNextPage === false`) so we don't keep
 *                    observing a sentinel that has nothing left to load.
 * @param options.root  Scroll container ref. For horizontal carousels this
 *                    MUST be the carousel's scroll container, otherwise
 *                    the IntersectionObserver uses the viewport as the
 *                    root and fires immediately (the sentinel is technically
 *                    "in view" relative to the viewport even if it's off
 *                    the right edge of the carousel). Pass the same ref you
 *                    attach to the scrollable div.
 * @param options.rootMargin  How early to trigger before the sentinel is
 *                    fully visible. Default "200px" — loads the next page
 *                    slightly before the user reaches the very end, so the
 *                    new cards are usually already there by the time they
 *                    finish scrolling. Tune per use case.
 * @param options.threshold  0..1, fraction of sentinel that must be visible.
 *                    Default 0 (any pixel is enough).
 */
interface UseInfiniteScrollOptions {
  enabled?: boolean;
  root?: React.RefObject<HTMLElement | null>;
  rootMargin?: string;
  threshold?: number;
}

export function useInfiniteScroll(
  onLoadMore: () => void,
  options: UseInfiniteScrollOptions = {},
) {
  const { enabled = true, root, rootMargin = "200px", threshold = 0 } = options;
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Keep the latest callback in a ref so the IntersectionObserver doesn't
  // need to be re-created on every render (which would happen if we closed
  // over `onLoadMore` directly). The observer is created ONCE per
  // (enabled, root, rootMargin, threshold) combo.
  const callbackRef = useRef(onLoadMore);
  useEffect(() => {
    callbackRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    if (!enabled) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // We only observe one element, so entries[0] is the sentinel.
        if (entries[0]?.isIntersecting) {
          callbackRef.current();
        }
      },
      {
        // root MUST be the scroll container for horizontal carousels.
        // If root is null/omitted, the browser viewport is used — which
        // would fire immediately for off-screen-but-in-viewport sentinels.
        root: root?.current ?? null,
        rootMargin,
        threshold,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [enabled, root, rootMargin, threshold]);

  // Expose a stable re-fire guard: callers can wrap their onLoadMore in
  // this to dedupe rapid fires (IntersectionObserver can fire multiple
  // times in quick succession during momentum scroll). Most callers should
  // just guard with their own `isFetching` flag instead — this is here as
  // a convenience for cases where that's not available.
  const isFiringRef = useRef(false);
  const guardedFire = useCallback(() => {
    if (isFiringRef.current) return;
    isFiringRef.current = true;
    // Reset on the next macrotask so the caller's state update has time
    // to land and re-evaluate `enabled`.
    setTimeout(() => {
      isFiringRef.current = false;
    }, 0);
    callbackRef.current();
  }, []);

  return { sentinelRef, guardedFire };
}
