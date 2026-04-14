import { useEffect, useRef, useCallback } from 'react'

/**
 * Shared modal behavior: Escape key to close, rAF animate-in, animated close.
 *
 * @param onClose    Callback when the modal should close
 * @param visibleClass  CSS class toggled for enter/exit animation
 * @param animateOutMs  Duration of the exit animation before calling onClose
 * @returns { ref, handleClose } — attach ref to the animated container
 */
export function useModalAnimation<T extends HTMLElement = HTMLDivElement>(
  onClose: () => void,
  visibleClass: string,
  animateOutMs = 200,
): {
  ref: React.RefObject<T | null>
  handleClose: () => void
} {
  const ref = useRef<T>(null)

  // Animate in on mount
  useEffect(() => {
    requestAnimationFrame(() => {
      ref.current?.classList.add(visibleClass)
    })
  }, [visibleClass])

  // Escape key to close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  // Animated close: remove class then call onClose after transition
  const handleClose = useCallback(() => {
    ref.current?.classList.remove(visibleClass)
    setTimeout(onClose, animateOutMs)
  }, [onClose, visibleClass, animateOutMs])

  return { ref, handleClose }
}
