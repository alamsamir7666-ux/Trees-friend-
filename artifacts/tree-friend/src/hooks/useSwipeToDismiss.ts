/**
 * useSwipeToDismiss — touch gesture hook for swipe-to-dismiss on a sheet/drawer.
 *
 * v6.2 Part 7 (P3-13): enables the Telegram/iOS Messages pattern of
 * swiping a chat sheet right-to-dismiss. Radix UI's `Sheet` component
 * doesn't support native swipe gestures (it's keyboard + click-away only),
 * so we add custom touch handlers on a wrapper div inside SheetContent.
 *
 * Gesture contract:
 *   1. `touchstart` records the starting X/Y.
 *   2. `touchmove` decides whether the gesture is horizontal-dominant
 *      (|dx| > |dy| AND |dx| > 8px) AND started within `edgeWidth` of
 *      the sheet's left edge. If yes → start dragging (translate the
 *      wrapper right). If no → ignore (let vertical scroll / tap happen).
 *   3. `touchmove` (while dragging) translates the wrapper right by `dx`
 *      (clamped to [0, maxWidth] — can't drag left past 0, can't drag
 *      past the sheet width).
 *   4. `touchend`: if `dragX > threshold` → call `onDismiss`. Always
 *      reset `dragX` to 0 (with a CSS transition for snap-back).
 *
 * Why edge-zone check (`edgeWidth`, default 32px):
 *   - Without it, any horizontal-dominant touch would hijack the gesture —
 *     breaking horizontal scrolls inside the chat (suggestion cards row,
 *     tool card grids, citation chips wrap).
 *   - With it, only touches starting within 32px of the sheet's left edge
 *     can become a swipe-to-dismiss. This matches the iOS Messages native
 *     pattern (interactive pop from screen edge).
 *
 * Why `|dx| > |dy|` direction gate:
 *   - Prevents vertical scrolls (chat messages list) from triggering a
 *     horizontal drag. The 8px dead zone filters out micro-jitter.
 *
 * Dual state pattern (state + ref):
 *   - `dragX` (state) drives the re-render (the wrapper's transform updates
 *     on every touchmove). React 18+ batches these automatically.
 *   - `dragXRef` (ref) mirrors `dragX` so `onTouchEnd` can read the latest
 *     value WITHOUT re-creating the callback on every dragX change. This
 *     is critical: if `onTouchEnd` had `[dragX]` deps, the wrapper would
 *     re-attach the touch handler on every move (60fps), which would drop
 *     events mid-gesture. The ref avoids this — the callback is stable
 *     (empty deps) but still reads the current dragX via the ref.
 *
 * Returns:
 *   - `handlers` — spread onto the wrapper div: `{ onTouchStart, onTouchMove, onTouchEnd }`
 *   - `dragX` — current horizontal translation in px (apply as `transform: translateX(${dragX}px)`)
 *   - `isDragging` — true while actively dragging (disables CSS transition for 1:1 tracking)
 */
import { useCallback, useRef, useState } from "react";

interface UseSwipeToDismissOptions {
  /** Called when the user releases a drag past `threshold`. */
  onDismiss: () => void;
  /** px — how far to drag before dismissing (default 100). */
  threshold?: number;
  /** px — touch must start within this distance from the left edge to
   *  become a swipe (default 32). Matches the iOS Messages interactive
   *  pop gesture zone. */
  edgeWidth?: number;
  /** px — maximum drag distance (default 320, roughly the sheet width
   *  on mobile). Prevents dragging the sheet completely off-screen. */
  maxWidth?: number;
}

interface UseSwipeToDismissResult {
  handlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
  };
  dragX: number;
  isDragging: boolean;
}

export function useSwipeToDismiss({
  onDismiss,
  threshold = 100,
  edgeWidth = 32,
  maxWidth = 320,
}: UseSwipeToDismissOptions): UseSwipeToDismissResult {
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // Refs for tracking gesture state without triggering re-renders.
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const draggingRef = useRef(false);
  const decidedRef = useRef(false); // whether we've committed to horizontal vs vertical
  const dragXRef = useRef(0); // mirrors dragX so onTouchEnd can read the latest value
  // v6.2 Part 8 (Gap G fix): tracks whether we've already vibrated for this
  // gesture. Without this, navigator.vibrate(15) would fire on EVERY
  // touchmove where dragX crosses the threshold (dozens of times per
  // gesture — a buzzing phone). We vibrate ONCE when the threshold is
  // first crossed, matching the useSwipeToReply hook's pattern.
  const vibratedRef = useRef(false);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    startXRef.current = touch.clientX;
    startYRef.current = touch.clientY;
    decidedRef.current = false;
    draggingRef.current = false;
    // v6.2 Part 8 (Gap G fix): reset the vibration flag for this new gesture.
    vibratedRef.current = false;
  }, []);

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      const dx = touch.clientX - startXRef.current;
      const dy = touch.clientY - startYRef.current;

      // Direction-decision phase: haven't yet decided if this is H or V.
      if (!decidedRef.current) {
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
          // Horizontal-dominant — check edge zone.
          if (startXRef.current <= edgeWidth) {
            decidedRef.current = true;
            draggingRef.current = true;
            setIsDragging(true);
          } else {
            // Horizontal but not from edge — let it pass (don't decide,
            // so a subsequent vertical scroll can still work).
            return;
          }
        } else if (Math.abs(dy) > 8) {
          // Vertical-dominant — commit to "not a swipe", let scroll happen.
          decidedRef.current = true;
          return;
        } else {
          // Micro-movement (< 8px) — wait for more data.
          return;
        }
      }

      if (draggingRef.current) {
        // Translate right only (clamp to [0, maxWidth]).
        const clamped = Math.max(0, Math.min(maxWidth, dx));
        dragXRef.current = clamped;
        setDragX(clamped);

        // v6.2 Part 8 (Gap G fix): vibrate ONCE when the drag crosses the
        // dismiss threshold. The tactile feedback signals "release now to
        // dismiss" — matches useSwipeToReply's pattern + the iOS native
        // swipe-to-dismiss haptics. The vibratedRef guard ensures we only
        // fire once per gesture (not on every touchmove past the threshold).
        //
        // navigator.vibrate is gated behind a feature check — it's
        // undefined on desktop browsers + iOS Safari (Apple doesn't
        // support the Vibration API on iOS). The feature check avoids a
        // runtime error; the hook silently no-ops on those platforms.
        if (clamped >= threshold && !vibratedRef.current) {
          vibratedRef.current = true;
          if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
            try {
              navigator.vibrate(15);
            } catch {
              // Silent fail — some browsers throw if the user hasn't
              // interacted with the page yet (autoplay-style policy).
              // The gesture itself counts as interaction, but defensive.
            }
          }
        }

        // We DON'T call e.preventDefault — React's synthetic touchmove
        // is passive by default, so preventDefault is a no-op + logs a
        // console warning. The vertical scroll might jitter slightly
        // during a horizontal drag, but the visual impact is minimal
        // (the wrapper is being translated, so the user sees the drag
        // feedback even if the scroll also moves a few pixels).
      }
    },
    [edgeWidth, maxWidth, threshold],
  );

  const onTouchEnd = useCallback(() => {
    if (draggingRef.current) {
      // Read the latest dragX from the ref (not the state — the state
      // closure would be stale due to useCallback's empty deps).
      if (dragXRef.current > threshold) {
        onDismiss();
      }
    }
    draggingRef.current = false;
    decidedRef.current = false;
    dragXRef.current = 0;
    setIsDragging(false);
    setDragX(0); // snap back (or Radix's exit animation takes over if onDismiss was called)
  }, [onDismiss, threshold]);

  return { handlers: { onTouchStart, onTouchMove, onTouchEnd }, dragX, isDragging };
}
