/**
 * Compositor-driven playback animator.
 *
 * Drives the formatted view's (or focus scroll's) column via a Web
 * Animations API transform animation so that the motion runs on the
 * compositor thread, not the main thread. Replaces the old pattern of
 * writing `container.scrollTop` every rAF tick + applying a per-frame
 * sub-pixel `translate3d` to smooth over integer snapping.
 *
 * Design:
 *   - One animation per play session. Keyframes encode the full chapter
 *     scroll path derived from the velocity profile (variable per-block
 *     speed); playbackRate scales the whole thing for WPM and gaze
 *     multiplier.
 *   - `virtualOffset()` is computed from `animation.currentTime` using
 *     the cached keyframe arrays — never by reading computed styles, so
 *     it costs ~O(log n) with no layout flush.
 *   - `pause()` atomically freezes the animated transform as an inline
 *     style via `commitStyles()` (with a manual fallback), cancels the
 *     animation, and returns the virtual offset so the caller can
 *     reconcile `scrollTop`.
 *
 * Browser support:
 *   - `Element.prototype.animate`: Chrome 36+, Safari 13.1+, Firefox 75+.
 *   - `Animation.commitStyles`: Chrome 95+, Safari 16+, Firefox 106+.
 *     Fallback: sample the current keyframe value and write the transform
 *     inline before cancel. Functionally identical.
 */

import {
  sampleVirtualPxAt,
  sampleTimeAtVirtualPx,
  toWebAnimationsKeyframes,
  type PlaybackKeyframes,
} from './velocityProfile'

export interface PlaybackAnimator {
  /** Virtual distance (px) the column has scrolled past the baseline. */
  virtualOffset(): number
  /** Animation `currentTime` in ms, null-safe (returns 0 if unset). */
  currentTimeMs(): number
  /** Set the compositor-side playback rate. 1.0 = baseline WPM; gaze
   *  and WPM changes multiplex through this. Values outside the practical
   *  range are clamped by the caller, not here. */
  setPlaybackRate(rate: number): void
  /** Freeze the animation at its current visual position, write the
   *  frozen transform as an inline style, cancel the animation, and
   *  return the virtual offset (so the caller can reconcile scrollTop).
   *  After this call the animator is inert; create a fresh one to play
   *  again. */
  pause(): { virtualOffsetPx: number; inlineTransformApplied: boolean }
  /** Cancel without any commit. Used for seek/chapter-change where the
   *  caller is rebuilding a fresh animator. */
  cancel(): void
  /** Jump to the time at which the virtual offset equals `virtualPx`.
   *  Keeps current playbackRate. */
  seekToVirtual(virtualPx: number): void
  /** Resolves when the animation finishes at its natural end. Rejects
   *  on cancel — the caller should treat rejection as a no-op. */
  finished: Promise<void>
  /** Whether the animator is still live (has not been paused/cancelled). */
  isActive(): boolean
}

export interface CreatePlaybackAnimatorOptions {
  /** The element whose `transform` the animation drives. Should be a
   *  direct child of the scroll container, ideally with `will-change:
   *  transform` in CSS so it's always on its own compositor layer. */
  column: HTMLElement
  keyframes: PlaybackKeyframes
  /** Initial `animation.playbackRate`. Typically `currentWpm / baselineWpm`. */
  initialPlaybackRate: number
  /** Fired when the animation reaches its natural end (currentTime ==
   *  duration). Not fired on pause/cancel. */
  onFinished?: () => void
}

/**
 * Feature detection. Returns true iff WAAPI is usable for our purposes.
 * Callers should fall back to the legacy rAF-driven scroll path when
 * this returns false.
 */
export function isWaapiSupported(): boolean {
  if (typeof Element === 'undefined') return false
  const proto = Element.prototype as { animate?: unknown }
  return typeof proto.animate === 'function'
}

export function createPlaybackAnimator(
  opts: CreatePlaybackAnimatorOptions,
): PlaybackAnimator {
  const { column, keyframes, initialPlaybackRate, onFinished } = opts

  const waapiKf = toWebAnimationsKeyframes(keyframes)
  const duration = Math.max(keyframes.totalDurationMs, 1)

  // `fill: 'forwards'` so the final keyframe value persists after
  // currentTime hits duration (prevents a snap-back to identity between
  // `finished` firing and us taking over).
  const animation = column.animate(waapiKf, {
    duration,
    easing: 'linear',
    fill: 'forwards',
  })
  animation.playbackRate = initialPlaybackRate

  let active = true

  const finished = animation.finished.then(
    () => {
      if (active) {
        active = false
        onFinished?.()
      }
    },
    () => {
      // Rejected — cancelled or interrupted. No-op.
    },
  )

  const currentTimeMs = (): number => {
    if (!active) return 0
    const t = animation.currentTime
    if (t == null) return 0
    // Modern browsers return CSSNumericValue in some contexts; normalize.
    return typeof t === 'number' ? t : Number((t as unknown as { value: number }).value ?? 0)
  }

  const virtualOffset = (): number => {
    return sampleVirtualPxAt(keyframes, currentTimeMs())
  }

  const setPlaybackRate = (rate: number): void => {
    if (!active) return
    // Writing the same value back still dispatches a compositor IPC on
    // some browsers. Dedup at the caller if it matters; here we stay
    // honest to semantics.
    animation.playbackRate = rate
  }

  const seekToVirtual = (virtualPx: number): void => {
    if (!active) return
    animation.currentTime = sampleTimeAtVirtualPx(keyframes, virtualPx)
  }

  const pause = (): { virtualOffsetPx: number; inlineTransformApplied: boolean } => {
    if (!active) {
      return { virtualOffsetPx: 0, inlineTransformApplied: false }
    }
    const virtualPx = virtualOffset()

    // Preferred: commitStyles writes the computed animated value as an
    // inline style, atomically swapping animation→static. Chrome 95+,
    // Safari 16+, Firefox 106+.
    let inlineApplied = false
    const anim = animation as Animation & { commitStyles?: () => void }
    if (typeof anim.commitStyles === 'function') {
      try {
        anim.commitStyles()
        inlineApplied = true
      } catch {
        // Thrown if the animation has no effect or element was detached;
        // fall through to the manual path.
      }
    }
    if (!inlineApplied) {
      // Manual fallback: write the same transform the animation was
      // producing, then cancel.
      column.style.transform = `translate3d(0, ${-virtualPx}px, 0)`
      inlineApplied = true
    }

    active = false
    animation.cancel()
    return { virtualOffsetPx: virtualPx, inlineTransformApplied: inlineApplied }
  }

  const cancel = (): void => {
    if (!active) return
    active = false
    animation.cancel()
  }

  return {
    virtualOffset,
    currentTimeMs,
    setPlaybackRate,
    pause,
    cancel,
    seekToVirtual,
    finished,
    isActive: () => active,
  }
}
