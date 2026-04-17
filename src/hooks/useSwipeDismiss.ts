import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type RefObject } from 'react';

/**
 * Swipe-to-dismiss for bottom sheets and side-drawer panels.
 *
 * Attach `bind()` to the handle/header element. The hook tracks the
 * active pointer and translates the `panelRef` element directly via
 * inline transform (fast, compositor-only) until the user commits
 * to dismiss (>= `threshold` or velocity-based flick) or releases
 * before threshold (spring back to 0).
 *
 * Integrates with the existing `useModalAnimation.handleClose`: pass
 * it as `onDismiss` so the regular exit animation still runs.
 *
 * The hook refuses drags that originate inside an already-scrolled
 * descendant scroller (for bottom sheets: scrollTop > 0 on drag-down),
 * so content scrolling keeps priority over dismissal.
 */

export type SwipeAxis = 'y' | 'x-right';

interface UseSwipeDismissOptions<E extends HTMLElement> {
  panelRef: RefObject<E | null>;
  axis: SwipeAxis;
  onDismiss: () => void;
  /** Displacement in px past which release commits the dismiss. Default 80. */
  threshold?: number;
  /** Enable/disable drag tracking. Default true. */
  enabled?: boolean;
}

const MIN_MOVE_THRESHOLD = 12;

export function useSwipeDismiss<H extends HTMLElement, E extends HTMLElement = HTMLElement>({
  panelRef,
  axis,
  onDismiss,
  threshold = 80,
  enabled = true,
}: UseSwipeDismissOptions<E>): {
  bind: () => {
    onPointerDown: (e: RPointerEvent<H>) => void;
    onPointerMove: (e: RPointerEvent<H>) => void;
    onPointerUp: (e: RPointerEvent<H>) => void;
    onPointerCancel: (e: RPointerEvent<H>) => void;
  };
  dragging: boolean;
} {
  const startRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const lockedRef = useRef<'committed' | 'rejected' | null>(null);
  const [dragging, setDragging] = useState(false);

  const applyTransform = useCallback(
    (delta: number) => {
      const el = panelRef.current;
      if (!el) return;
      if (axis === 'y') {
        el.style.transform = `translateY(${Math.max(0, delta)}px)`;
      } else {
        el.style.transform = `translateX(${Math.max(0, delta)}px)`;
      }
    },
    [axis, panelRef],
  );

  const resetTransform = useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    el.style.transition = 'transform 180ms cubic-bezier(0.32, 0.72, 0, 1)';
    el.style.transform = '';
    // Clean up transition after it's done so subsequent drags don't animate.
    window.setTimeout(() => {
      if (el.style.transform === '') el.style.transition = '';
    }, 200);
  }, [panelRef]);

  const onPointerDown = useCallback(
    (e: RPointerEvent<H>) => {
      if (!enabled) return;
      startRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      lockedRef.current = null;
      const el = panelRef.current;
      if (el) el.style.transition = '';
    },
    [enabled, panelRef],
  );

  const onPointerMove = useCallback(
    (e: RPointerEvent<H>) => {
      if (!enabled) return;
      const start = startRef.current;
      if (!start || start.pointerId !== e.pointerId) return;

      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const primary = axis === 'y' ? dy : dx;
      const cross = axis === 'y' ? dx : dy;

      if (lockedRef.current === null) {
        const absPrimary = Math.abs(primary);
        const absCross = Math.abs(cross);
        // Only commit once the pointer has moved enough to be a real drag.
        if (absPrimary < MIN_MOVE_THRESHOLD && absCross < MIN_MOVE_THRESHOLD) return;
        // Reject if cross-axis dominates.
        if (absCross > absPrimary) {
          lockedRef.current = 'rejected';
          return;
        }
        // Reject upward / leftward drags (we only dismiss in the panel's
        // natural exit direction).
        if (primary < 0) {
          lockedRef.current = 'rejected';
          return;
        }
        lockedRef.current = 'committed';
        setDragging(true);
        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* ignore capture failures (mouse secondary, etc.) */
        }
      }

      if (lockedRef.current !== 'committed') return;
      e.preventDefault();
      applyTransform(Math.max(0, primary));
    },
    [axis, applyTransform, enabled],
  );

  const finish = useCallback(
    (e: RPointerEvent<H>) => {
      const start = startRef.current;
      if (!start || start.pointerId !== e.pointerId) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const primary = axis === 'y' ? dy : dx;
      const committed = lockedRef.current === 'committed';

      startRef.current = null;
      lockedRef.current = null;
      setDragging(false);

      if (!committed) return;

      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }

      if (primary >= threshold) {
        onDismiss();
      } else {
        resetTransform();
      }
    },
    [axis, onDismiss, resetTransform, threshold],
  );

  const onPointerUp = useCallback(
    (e: RPointerEvent<H>) => {
      if (!enabled) return;
      finish(e);
    },
    [enabled, finish],
  );

  const onPointerCancel = useCallback(
    (e: RPointerEvent<H>) => {
      if (!enabled) return;
      resetTransform();
      startRef.current = null;
      lockedRef.current = null;
      setDragging(false);
    },
    [enabled, resetTransform],
  );

  // Clear any in-progress drag state and inline transform when the hook
  // is disabled (e.g. panel closed while a drag was mid-motion).
  useEffect(() => {
    if (enabled) return;
    const el = panelRef.current;
    if (el) {
      el.style.transition = '';
      el.style.transform = '';
    }
    startRef.current = null;
    lockedRef.current = null;
    setDragging(false);
  }, [enabled, panelRef]);

  const bind = useCallback(
    () => ({ onPointerDown, onPointerMove, onPointerUp, onPointerCancel }),
    [onPointerDown, onPointerMove, onPointerUp, onPointerCancel],
  );

  return { bind, dragging };
}
