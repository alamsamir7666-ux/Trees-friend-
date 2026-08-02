import { useRef, useCallback } from "react";

/**
 * useLongPress — industry-standard long-press detection for mobile chat bubbles.
 *
 * WhatsApp / Telegram / iMessage all use long-press (≈500ms hold without
 * moving) on a message bubble to bring up the action menu (Reply / Edit /
 * Delete / Forward / etc.). This hook implements the same behavior:
 *
 *   - `onTouchStart` starts a 500ms timer.
 *   - If the user lifts their finger or scrolls before the timer fires,
 *     the timer is cleared (no menu opens — the tap/scroll proceeds
 *     normally).
 *   - If the timer fires, we trigger haptic feedback (where supported)
 *     and call `onLongPress` with the original event so the caller can
 *     open the menu.
 *
 * The hook ALSO returns an `onContextMenu` handler so the SAME callback
 * fires on right-click (desktop). This gives us free desktop parity:
 * right-click a message → menu opens.
 *
 * IMPORTANT — click suppression:
 * After a long-press fires, the browser still synthesizes a `click` event
 * when the user lifts their finger. If the bubble contains an interactive
 * child (e.g. an image that opens a lightbox on click), that click would
 * fire and open the lightbox INSTEAD of (or in addition to) the action
 * menu. To prevent this, the hook exposes `justFiredRef` — a ref that's
 * `true` for one tick after a long-press fires. Consumers should check
 * `justFiredRef.current` in their click handlers and bail out if it's
 * true, then reset it to false.
 */
interface LongPressOptions {
  /** Hold duration in ms before firing. Default 500. */
  threshold?: number;
  /** Max pixel movement before the press is treated as a scroll/tap. Default 10. */
  moveTolerance?: number;
  /** Whether to vibrate the device when the long-press fires. Default true. */
  haptic?: boolean;
}

interface UseLongPressReturn {
  /** Spread these onto the element you want to be long-pressable. */
  handlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
    onContextMenu: (e: React.MouseEvent) => void;
  };
  /**
   * Ref that's `true` briefly after a long-press fires. Check this in
   * click handlers on interactive children (images, links, etc.) and
   * bail out + reset if true, to prevent the synthetic click from
   * firing after a long-press.
   */
  justFiredRef: React.MutableRefObject<boolean>;
}

export function useLongPress(
  onLongPress: () => void,
  options: LongPressOptions = {},
): UseLongPressReturn {
  const { threshold = 500, moveTolerance = 10, haptic = true } = options;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const justFiredRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPosRef.current = null;
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      // Only respond to single-finger touches — multi-finger gestures
      // (pinch-to-zoom, etc.) shouldn't trigger long-press.
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      startPosRef.current = { x: touch.clientX, y: touch.clientY };
      justFiredRef.current = false;

      timerRef.current = setTimeout(() => {
        // Verify the finger is still down (touchend may have fired
        // asynchronously between the timer being set and now — defensive).
        if (startPosRef.current === null) return;
        justFiredRef.current = true;
        if (haptic && typeof navigator !== "undefined" && navigator.vibrate) {
          navigator.vibrate(15);
        }
        onLongPress();
      }, threshold);
    },
    [threshold, haptic, onLongPress],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (startPosRef.current === null) return;
      const touch = e.touches[0];
      const dx = Math.abs(touch.clientX - startPosRef.current.x);
      const dy = Math.abs(touch.clientY - startPosRef.current.y);
      if (dx > moveTolerance || dy > moveTolerance) {
        clearTimer();
      }
    },
    [moveTolerance, clearTimer],
  );

  const onTouchEnd = useCallback(() => {
    clearTimer();
  }, [clearTimer]);

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Right-click on desktop → open the same menu.
      // We preventDefault so the browser's native context menu doesn't
      // also pop up (which would be confusing).
      e.preventDefault();
      onLongPress();
    },
    [onLongPress],
  );

  return {
    handlers: { onTouchStart, onTouchMove, onTouchEnd, onContextMenu },
    justFiredRef,
  };
}
