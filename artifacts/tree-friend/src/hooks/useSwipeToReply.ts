import { useRef, useState, useCallback, useEffect } from "react";

/**
 * useSwipeToReply — industry-standard swipe-to-reply gesture for chat bubbles.
 *
 * Mirrors the behavior in WhatsApp / Telegram / iMessage:
 *   - Incoming (other party's) messages swipe RIGHT (left → right).
 *   - Outgoing (own) messages swipe LEFT (right → left).
 *   - The bubble translates horizontally following the finger, capped at
 *     `maxDistance`. A reply icon fades in behind the bubble as it moves.
 *   - If the user releases past `threshold`, `onReply` fires.
 *   - If they release before `threshold`, the bubble snaps back with a
 *     spring-like CSS transition.
 *   - Haptic feedback fires ONCE when the user first crosses the threshold
 *     (so they know "release now = reply").
 *   - Vertical movement is ignored (treated as scroll). Only engages when
 *     the horizontal component dominates.
 *
 * Coordination with useLongPress:
 *   Both hooks can be attached to the same element. useLongPress cancels
 *   itself on >10px movement, so a swipe automatically suppresses the
 *   long-press menu, and a stationary hold still fires the menu. This is
 *   the standard pattern.
 *
 * Desktop:
 *   Touch events don't fire on desktop, so the hook is a no-op there.
 *   Desktop users get reply via the long-press/right-click action menu
 *   (which has a "Reply" entry added separately).
 */

interface SwipeToReplyOptions {
  /** Direction the bubble should move to trigger a reply. */
  direction: "left" | "right";
  /** Horizontal distance in px the user must drag before release triggers
      `onReply`. Industry default is ~50-60px. Default 50. */
  threshold?: number;
  /** Maximum translation in px — bubble won't drag past this. Default 80. */
  maxDistance?: number;
  /** Haptic vibration duration in ms when crossing threshold. 0 disables. Default 15. */
  hapticMs?: number;
}

interface SwipeToReplyReturn {
  /** Spread these onto the element you want to be swipeable. */
  handlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
    onTouchCancel: (e: React.TouchEvent) => void;
  };
  /** Current horizontal translation in px. Positive = rightward, negative = leftward.
      When idle, this is 0. Apply as `transform: translateX(dragX)`. */
  dragX: number;
  /** 0..1 progress toward `maxDistance`. Useful for fading in the reply icon. */
  progress: number;
  /** True when `dragX` has crossed `threshold` — use to highlight the icon. */
  isReplyActive: boolean;
  /** True while a finger is down and actively swiping. Use to disable the
      snap-back CSS transition during the drag (so the bubble follows the
      finger 1:1) and re-enable it for the snap-back animation on release. */
  isSwiping: boolean;
}

export function useSwipeToReply(
  onReply: () => void,
  options: SwipeToReplyOptions,
): SwipeToReplyReturn {
  const {
    direction,
    threshold = 50,
    maxDistance = 80,
    hapticMs = 15,
  } = options;

  const [dragX, setDragX] = useState(0);
  const [isSwiping, setSwiping] = useState(false);

  // Refs for gesture state — mutated in touchmove/touchend without
  // triggering re-renders on every frame. We sync to state only for the
  // visual properties (dragX, isSwiping) that the component needs to render.
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const isSwipingRef = useRef(false);
  // Track whether we've already fired haptic for THIS swipe (so we don't
  // buzz on every touchmove event past threshold — just once per swipe).
  const hapticFiredRef = useRef(false);

  const sign = direction === "right" ? 1 : -1;

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      // Only respond to single-finger touches.
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      startPosRef.current = { x: touch.clientX, y: touch.clientY };
      isSwipingRef.current = false;
      hapticFiredRef.current = false;
      // Don't set isSwiping=true yet — wait until we know it's a horizontal
      // gesture (decided in onTouchMove). This prevents disabling the
      // snap-back transition prematurely on a tap.
    },
    [],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (startPosRef.current === null) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startPosRef.current.x;
      const dy = touch.clientY - startPosRef.current.y;

      // ─── Direction gate ────────────────────────────────────────────────
      // Only engage if the movement is in the allowed direction (sign(dx)
      // matches our sign) AND horizontal-dominant (|dx| > |dy|).
      //
      // Why horizontal-dominant: if we engaged on vertical movement, we'd
      // hijack the user's scroll gesture. WhatsApp requires a clear
      // horizontal intent before the swipe "locks in".
      const movingInDirection = sign * dx > 0; // dx has same sign as `sign`

      if (!isSwipingRef.current) {
        // Not yet locked in — check if this looks like a swipe.
        if (!movingInDirection) return;
        if (Math.abs(dx) < Math.abs(dy)) return;
        if (Math.abs(dx) < 8) return; // dead zone to avoid jitter on tap
        // Lock in.
        isSwipingRef.current = true;
        setSwiping(true);
      }

      // ─── Cap translation ───────────────────────────────────────────────
      // Translate by dx, but clamp to [0, maxDistance] in the allowed
      // direction. Moving against the direction just returns to 0 (we
      // don't allow negative progress).
      const signedDx = sign * dx;
      const clamped = Math.max(0, Math.min(maxDistance, signedDx));
      setDragX(sign * clamped);

      // ─── Haptic on threshold cross ─────────────────────────────────────
      if (clamped >= threshold && !hapticFiredRef.current) {
        hapticFiredRef.current = true;
        if (hapticMs > 0 && typeof navigator !== "undefined" && navigator.vibrate) {
          navigator.vibrate(hapticMs);
        }
      }
    },
    [sign, maxDistance, threshold, hapticMs],
  );

  const finishSwipe = useCallback(
    (e: React.TouchEvent) => {
      void e; // unused but kept for API symmetry with onTouchEnd
      const wasActive = isSwipingRef.current;
      const currentDragX = dragX;
      // Reset gesture state immediately so subsequent gestures start clean.
      isSwipingRef.current = false;
      hapticFiredRef.current = false;
      startPosRef.current = null;
      setSwiping(false);
      setDragX(0);

      // Fire onReply if we crossed threshold. We compare against the last
      // rendered dragX (which is in the allowed direction, so its absolute
      // value is the progress).
      if (wasActive && Math.abs(currentDragX) >= threshold) {
        onReply();
      }
    },
    [dragX, threshold, onReply],
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => finishSwipe(e),
    [finishSwipe],
  );
  const onTouchCancel = useCallback(
    (e: React.TouchEvent) => finishSwipe(e),
    [finishSwipe],
  );

  // ─── Cleanup on unmount ────────────────────────────────────────────────
  // If the component unmounts mid-swipe (e.g. list virtualization), reset
  // state to avoid a stuck-translated bubble on next mount.
  useEffect(() => {
    return () => {
      isSwipingRef.current = false;
      hapticFiredRef.current = false;
      startPosRef.current = null;
    };
  }, []);

  const progress = Math.min(1, Math.abs(dragX) / maxDistance);
  const isReplyActive = Math.abs(dragX) >= threshold;

  return {
    handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel },
    dragX,
    progress,
    isReplyActive,
    isSwiping,
  };
}
