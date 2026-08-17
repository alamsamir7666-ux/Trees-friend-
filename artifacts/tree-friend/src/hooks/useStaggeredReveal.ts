/**
 * useStaggeredReveal — staggered fade-in animation for list/card content.
 *
 * v6.2 Part 9 (Gap 17 fix — Phase A: frontend progressive rendering).
 *
 * Industry context: Claude's artifact streaming renders content piece by
 * piece (rows fade in with a 50ms stagger, timeline steps animate in
 * sequence). This delivers the perceived "streaming" feel even when data
 * arrives all at once — which is the common case for our SQL-based tools
 * (search_seller_listings, get_user_orders, etc. execute in <100ms).
 *
 * Pattern: each item gets `animationDelay: i * stepMs` + the
 * `animate-in fade-in slide-in-from-bottom-2` Tailwind classes. CSS
 * handles the actual animation; we just set the delay.
 *
 * Accessibility:
 *   - The animation is purely visual. Screen readers announce the
 *     content immediately (it's in the DOM from the first render).
 *   - `prefers-reduced-motion: reduce` (Part 6, P2-15) zeroes out
 *     animation-duration globally, so the stagger becomes instant —
 *     the delays are still applied but have no visible effect. No JS
 *     check needed.
 *
 * Performance:
 *   - The hook returns a STABLE style object per index (memoized via
 *     useMemo). React doesn't re-render the item when the parent
 *     re-renders (assuming the item is wrapped in React.memo, which
 *     all 4 tool cards now are — Part 6 P2-14).
 *   - The delay is capped at `maxDelay` (default 600ms) so large lists
 *     don't take forever to fully reveal. A 10-row table at 50ms/row
 *     = 500ms total, which is the upper bound of "feels snappy".
 *
 * @param count — number of items in the list
 * @param stepMs — delay between each item (default 50ms)
 * @param maxDelayMs — cap on total delay (default 600ms)
 * @returns array of style objects, one per item: `{ animationDelay: '<n>ms' }`
 */
import { useMemo } from "react";

export function useStaggeredReveal(
  count: number,
  stepMs: number = 50,
  maxDelayMs: number = 600,
): React.CSSProperties[] {
  return useMemo(() => {
    const styles: React.CSSProperties[] = [];
    for (let i = 0; i < count; i++) {
      const delay = Math.min(i * stepMs, maxDelayMs);
      styles.push({
        animationDelay: `${delay}ms`,
        // animationFillMode: both — so the item starts at opacity:0
        // (the `from` keyframe of fade-in) BEFORE the delay expires.
        // Without this, the item would flash visible then animate in.
        animationFillMode: "both",
      });
    }
    return styles;
  }, [count, stepMs, maxDelayMs]);
}
