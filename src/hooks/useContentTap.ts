import { useRef, useCallback } from 'react'
import type React from 'react'

/**
 * Tap detection for the formatted-view containers.
 *
 * Mirrors the tap thresholds used by `useGestures` (15px / 300ms) but, unlike
 * GestureLayer, does NOT take over the container's `touch-action` or
 * `overflow`. That means native scrolling and text selection in the formatted
 * page keep working — only true taps fire `onTap`. Taps that land on an
 * interactive element (anchor, button, form control, etc.) are ignored so
 * in-content links still work.
 */

const TAP_MAX_DISTANCE = 15
const TAP_MAX_DURATION = 300

const INTERACTIVE_SELECTOR = 'a,button,input,select,textarea,label,[role="button"],[role="link"]'

interface TapState {
  startX: number
  startY: number
  startTime: number
  active: boolean
}

export function useContentTap(onTap?: () => void): {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  onPointerCancel: (e: React.PointerEvent) => void
} {
  const stateRef = useRef<TapState>({
    startX: 0,
    startY: 0,
    startTime: 0,
    active: false,
  })

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    stateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTime: Date.now(),
      active: true,
    }
  }, [])

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const state = stateRef.current
      if (!state.active) return
      state.active = false
      if (!onTap) return

      const dx = e.clientX - state.startX
      const dy = e.clientY - state.startY
      const elapsed = Date.now() - state.startTime
      const totalMovement = Math.sqrt(dx * dx + dy * dy)
      if (totalMovement >= TAP_MAX_DISTANCE) return
      if (elapsed >= TAP_MAX_DURATION) return

      // Don't hijack taps on links / buttons / form controls.
      const target = e.target as HTMLElement | null
      if (target && target.closest && target.closest(INTERACTIVE_SELECTOR)) return

      onTap()
    },
    [onTap],
  )

  const onPointerCancel = useCallback((_e: React.PointerEvent) => {
    stateRef.current.active = false
  }, [])

  return { onPointerDown, onPointerUp, onPointerCancel }
}
