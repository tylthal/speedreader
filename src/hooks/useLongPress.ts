import { useRef, useCallback, useEffect } from 'react'

const LONG_PRESS_DELAY = 500
const MOVE_THRESHOLD = 15

interface UseLongPressOptions {
  onLongPress: () => void
  enabled?: boolean
}

/**
 * Long-press gesture detection via pointer events.
 *
 * Fires after 500ms if the pointer hasn't moved >15px or been released.
 * Suppresses native context menu when the long-press fires.
 * Returns pointer event handlers to spread onto the target element.
 */
export function useLongPress({ onLongPress, enabled = true }: UseLongPressOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startXRef = useRef(0)
  const startYRef = useRef(0)
  const firedRef = useRef(false)
  const onLongPressRef = useRef(onLongPress)
  onLongPressRef.current = onLongPress

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Clean up on unmount
  useEffect(() => cancel, [cancel])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return
      firedRef.current = false
      startXRef.current = e.clientX
      startYRef.current = e.clientY
      cancel()
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        firedRef.current = true
        onLongPressRef.current()
      }, LONG_PRESS_DELAY)
    },
    [enabled, cancel],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!timerRef.current) return
      const dx = e.clientX - startXRef.current
      const dy = e.clientY - startYRef.current
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD) {
        cancel()
      }
    },
    [cancel],
  )

  const onPointerUp = useCallback(() => {
    cancel()
  }, [cancel])

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Suppress native context menu when long-press fired or is pending
      if (firedRef.current || timerRef.current) {
        e.preventDefault()
      }
    },
    [],
  )

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onContextMenu }
}
