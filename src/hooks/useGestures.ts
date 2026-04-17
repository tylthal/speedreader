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
  startedInHorizontalEdgeBand: boolean;
}

const TAP_MAX_DISTANCE = 15;
const TAP_MAX_DURATION = 300;
const SWIPE_MIN_DISTANCE = 30;
// Ignore horizontal swipes that originate within this edge band so the
// browser's own back gesture (iOS Safari left edge, Android Chrome
// right edge) can win without also firing onSwipeLeft/onSwipeRight.
// Vertical gestures starting in the band still work (speed control).
const EDGE_DEADZONE_PX = 20;

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
    startedInHorizontalEdgeBand: false,
  });

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const width = typeof window !== 'undefined' ? window.innerWidth : 0;
    const inLeftBand = e.clientX <= EDGE_DEADZONE_PX;
    const inRightBand = width > 0 && e.clientX >= width - EDGE_DEADZONE_PX;
    stateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTime: Date.now(),
      active: true,
      startedInHorizontalEdgeBand: inLeftBand || inRightBand,
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
        // Horizontal swipes that started in the edge band belong to the
        // browser's native back gesture — drop them instead of firing
        // chapter jumps.
        if (state.startedInHorizontalEdgeBand) return;
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
