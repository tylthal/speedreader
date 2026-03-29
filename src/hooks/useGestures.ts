import { useRef, useCallback } from 'react';
import type React from 'react';

interface GestureHandlers {
  onTap?: () => void;
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
}

interface PointerState {
  startX: number;
  startY: number;
  startTime: number;
  active: boolean;
}

const TAP_MAX_DISTANCE = 15;
const TAP_MAX_DURATION = 300;
const SWIPE_MIN_DISTANCE = 30;

export function useGestures(handlers: GestureHandlers): {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
} {
  const stateRef = useRef<PointerState>({
    startX: 0,
    startY: 0,
    startTime: 0,
    active: false,
  });

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    stateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTime: Date.now(),
      active: true,
    };
  }, []);

  const onPointerMove = useCallback((_e: React.PointerEvent) => {
    // Tracking is handled via start/end positions; no action needed during move.
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const state = stateRef.current;
    if (!state.active) return;
    state.active = false;

    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;
    const elapsed = Date.now() - state.startTime;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const totalMovement = Math.sqrt(dx * dx + dy * dy);

    const h = handlersRef.current;

    // Tap detection
    if (totalMovement < TAP_MAX_DISTANCE && elapsed < TAP_MAX_DURATION) {
      h.onTap?.();
      return;
    }

    // Swipe detection
    if (totalMovement >= SWIPE_MIN_DISTANCE) {
      if (absDx > absDy) {
        // Horizontal swipe
        if (dx < 0) {
          h.onSwipeLeft?.();
        } else {
          h.onSwipeRight?.();
        }
      } else {
        // Vertical swipe
        if (dy < 0) {
          h.onSwipeUp?.();
        } else {
          h.onSwipeDown?.();
        }
      }
    }
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp };
}
