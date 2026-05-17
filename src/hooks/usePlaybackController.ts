/* ------------------------------------------------------------------ */
/*  usePlaybackController                                              */
/* ------------------------------------------------------------------ */
//
// THE engine. Replaces:
//   - usePlaybackEngine.ts (phrase mode)
//   - useRsvpEngine.ts     (rsvp mode)
//   - useScrollEngine.ts   (scroll mode, focus + formatted)
//   - useTrackEngine.ts    (track mode, focus + formatted)
//   - useCursorAlignedEngine.ts (the entire alignment system)
//
// Architectural rules — these are load-bearing, don't quietly violate them:
//
//   1. There is exactly ONE controller instance per ActiveReader mount.
//      Mode is read from positionStore each frame; the tick body
//      branches on it. There are no parked engines, no pair-instantiation,
//      no isActive flags.
//
//   2. Position lives in positionStore. The controller has NO local
//      currentIndex or currentIndexRef. The tick reads
//      positionStore.getSnapshot().absoluteSegmentIndex at the top and
//      writes back via positionStore.setPosition(...) at boundaries.
//      The cursor cannot drift from the engine because there is only
//      one place position lives.
//
//   3. Intra-segment word state (RSVP only) lives on a private
//      wordIndexRef. It ticks at 4-12 Hz and would burn re-renders if
//      committed to the store every word. The controller flushes the
//      live word into the store on segment boundaries, on pause, on
//      visibility-hidden, and on unmount. The saver reads the store —
//      no getLiveWordIndex callback escape hatch.
//
//   4. The scroll/track sub-pixel accumulator (`scrollPositionRef`) is
//      a private DOM-write buffer, not "position." The DOM rounds
//      scrollTop on assignment and sub-pixel deltas vanish; the float
//      ref preserves them across frames. Position is still derived from
//      scroll center via the cursor mapping (item-rects in plain mode,
//      proportional in formatted mode), which feeds positionStore on
//      integer-index changes.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Segment } from '../types'
import type { GazeDirection } from '../lib/gazeProcessor'
import {
  buildConstantKeyframes,
  buildPlaybackKeyframes,
  createLookupCache,
  getPxPerWeight,
  type PlaybackKeyframes,
  type ProfileLookupCache,
  type VelocityProfile,
} from '../lib/velocityProfile'
import {
  createPlaybackAnimator,
  isWaapiSupported,
  type PlaybackAnimator,
} from '../lib/playbackAnimator'
import { positionStore, usePositionSelector } from '../state/position/positionStore'
import type { SegmentLoaderTranslators } from './useSegmentLoader'
import { REFERENCE_LINE_RATIO, type FormattedViewHandle } from '../components/FormattedView'

/**
 * Feature gate for the WAAPI compositor-animation scroll path.
 *
 * WAAPI sounded great in theory — compositor-driven motion is immune to
 * main-thread jank — but in practice the mobile compositor can't
 * rasterize a chapter-height element as a single layer ahead of
 * movement, which produces 190ms hitches on mobile Safari (no
 * long-task attribution, worse with images, worse with complex
 * layout). Native scroll + tile-based raster is the right approach
 * for tall scrollable containers.
 *
 * Default: OFF. The code is retained behind this flag for device-
 * specific experimentation — flip via `localStorage.waapiPlayback =
 * 'on'` to try the compositor path.
 */
function waapiPlaybackEnabled(): boolean {
  if (!isWaapiSupported()) return false
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage?.getItem('waapiPlayback') === 'on'
  } catch {
    return false
  }
}

/**
 * Force constant-speed keyframes even when a velocity profile is
 * available. A velocity profile produces piecewise-linear keyframes
 * whose slope changes at each block boundary — those slope
 * discontinuities read as "choppy" motion on mobile even when the
 * animation itself is running on the compositor.
 *
 * Default: ON while we validate compositor smoothness on mobile.
 * Flip off via `localStorage.setItem('waapiConstantSpeed', 'off')`
 * to re-enable the profile's per-block dwell-time variation once the
 * keyframe-smoothing pass is in place.
 */
function waapiConstantSpeedForced(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage?.getItem('waapiConstantSpeed') !== 'off'
  } catch {
    return true
  }
}

/** Binary search: largest i where arr[i] <= target. Returns -1 if none. */
function binarySearchLE(arr: Float64Array, target: number): number {
  if (arr.length === 0) return -1
  let lo = 0
  let hi = arr.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] <= target) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MIN_WPM = 50
const MAX_WPM = 1200
const DEFAULT_WPM = 250

// Track-mode speed multiplier bounds (gaze tilt mapping).
const MIN_MULTIPLIER = -0.6
const MAX_MULTIPLIER = 2.5
const HOLD_THRESHOLD = 0.55
const PLAY_GRACE_MS = 800
// Below this raw gaze intensity the target snaps to 1.0 (neutral) so
// residual classifier noise doesn't feed a non-zero target into the
// speed-multiplier lerp. The processor's own deadzone handles direction
// classification; this is a secondary floor on the intensity magnitude.
const INTENSITY_DEADZONE = 0.04
// When the lerp's remaining delta to target falls below this, snap
// the multiplier exactly onto target. Stops float-noise asymptotes.
const MULTIPLIER_SNAP = 0.002
const MAX_EFFECTIVE_WPM = 1500

function clampWpm(value: number): number {
  const snapped = Math.round(value / 25) * 25
  return Math.max(MIN_WPM, Math.min(MAX_WPM, snapped))
}

function computeOrpIndex(word: string): number {
  const len = word.length
  if (len <= 3) return 0
  if (len <= 5) return 1
  if (len <= 9) return 2
  return 3
}

function getWordsFromSegment(segment: Segment): string[] {
  return segment.text.split(/\s+/).filter((w) => w.length > 0)
}

function getWordDuration(word: string, wpm: number): number {
  const baseDuration = (1 / wpm) * 60000
  let duration = baseDuration
  if (word.length > 8) {
    duration *= Math.min(1.5, 1 + (word.length - 8) * 0.05)
  }
  const lastChar = word[word.length - 1]
  if (lastChar === '.' || lastChar === '!' || lastChar === '?') {
    duration += Math.max(30, baseDuration * 0.5)
  } else if (lastChar === ',' || lastChar === ';' || lastChar === ':') {
    duration += Math.max(15, baseDuration * 0.25)
  }
  return duration
}

function getSegmentDuration(segment: Segment, currentWpm: number): number {
  // duration_ms baked at 250 WPM at upload time. Scale proportionally.
  return segment.duration_ms * (DEFAULT_WPM / currentWpm)
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export interface UsePlaybackControllerOptions {
  segments: Segment[]
  totalSegments: number
  translators: SegmentLoaderTranslators
  /** Plain-mode scroll container (focus chunk overlay). */
  focusContainerRef: React.RefObject<HTMLDivElement | null>
  /** Plain-mode per-segment item refs. */
  focusItemOffsetsRef: React.RefObject<Map<number, HTMLDivElement>>
  /** Formatted-mode imperative handle. */
  formattedViewRef: React.RefObject<FormattedViewHandle | null>
  /** Velocity profile populated by FormattedView. */
  velocityProfileRef: React.RefObject<VelocityProfile | null>
  /** Gaze input for track mode. */
  gazeRef: React.RefObject<{ direction: GazeDirection; intensity: number }>
  /** Called when prefetch is needed (passes the array index). */
  onPrefetchHint?: (arrayIdx: number) => void
  /** Called when the engine reaches the end of the chapter.
   *  Return `true` to keep the store in `isPlaying=true` state (the rAF
   *  loop will stop, but the UI stays in playing mode). The caller is
   *  then responsible for calling `resumeLoop()` when new segments are
   *  ready. Return `false` (or void) to fully stop. */
  onComplete?: () => boolean | void
}

export interface PlaybackControllerHandle {
  play: () => void
  pause: () => void
  togglePlayPause: () => void
  /** Restart the rAF loop without toggling isPlaying. Use after
   *  onComplete returned `true` and new segments are ready. */
  resumeLoop: () => void
  setWpm: (wpm: number) => void
  adjustWpm: (direction: number) => void
  /** Seek to an absolute segment index. Sets origin to 'user-seek'. */
  seekToAbs: (absoluteSegmentIndex: number, wordIndex?: number) => void
  /** Live RSVP word for display (ticks at 4-12 Hz, isolated re-render). */
  rsvpWord: string
  rsvpOrpIndex: number
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function usePlaybackController(
  options: UsePlaybackControllerOptions,
): PlaybackControllerHandle {
  const {
    segments,
    totalSegments,
    translators,
    focusContainerRef,
    focusItemOffsetsRef,
    formattedViewRef,
    velocityProfileRef,
    gazeRef,
    onPrefetchHint,
    onComplete,
  } = options

  // Latest values in refs so the rAF loop reads fresh data without
  // re-creating the tick callback each render.
  const segmentsRef = useRef(segments)
  segmentsRef.current = segments
  const totalSegmentsRef = useRef(totalSegments)
  totalSegmentsRef.current = totalSegments
  const translatorsRef = useRef(translators)
  translatorsRef.current = translators
  const onPrefetchHintRef = useRef(onPrefetchHint)
  onPrefetchHintRef.current = onPrefetchHint
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  /* ---- rAF loop state ---- */
  const rafRef = useRef<number>(0)
  const lastTimestampRef = useRef(0)
  /** Phrase/RSVP elapsed time within the current segment/word. */
  const elapsedRef = useRef(0)
  /** RSVP intra-segment word index. Local because committing on every
   *  word would burn re-renders. Flushed to the store on segment
   *  boundary, pause, visibility-hidden, and unmount. */
  const wordIndexRef = useRef(0)
  /** Sub-pixel scroll accumulator for scroll/track modes. */
  const scrollPositionRef = useRef(0)
  /** Track mode gaze multiplier (smoothed). */
  const speedMultiplierRef = useRef(1.0)
  /** Track mode play timestamp for grace period. */
  const playStartTimeRef = useRef(0)
  /** Track mode segment-detection throttle (every 10 frames). */
  const segCheckCounterRef = useRef(0)
  /** Deferred segment commit for scroll/track modes. Storing in a ref
   *  lets us push the React re-render cascade out of the rAF tick. */
  const pendingScrollCommitRef = useRef<number | null>(null)
  const scrollCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastScrollCommitTimeRef = useRef(0)
  /** Scroll/track average speed cache (focus mode without velocity profile). */
  const pxPerSecPerWpmRef = useRef(0)
  /** Adjacency cache for velocity-profile O(1) lookups across ticks. One
   *  per controller; reset-by-construction on hook mount. */
  const profileLookupCacheRef = useRef<ProfileLookupCache>(createLookupCache())
  /** Latch flipped true when tick discovers we ran out of loaded segments
   *  mid-play; cleared on pause(), seekToAbs(), or by the prefetch-arrival
   *  effect. While true, the prefetch-arrival effect is allowed to auto-resume. */
  const waitingForSegmentsRef = useRef(false)

  /* ---- WAAPI compositor-scroll state ---- */
  /** The live WAAPI animation driving the column's translate3d during
   *  formatted scroll/track playback. Null when paused or when the
   *  legacy rAF+scrollTop path is active (flag off, plain mode,
   *  or WAAPI unsupported). */
  const animatorRef = useRef<PlaybackAnimator | null>(null)
  /** Keyframes backing `animatorRef`. Retained so virtualOffset() can
   *  sample without re-reading the animator's effect. */
  const keyframesRef = useRef<PlaybackKeyframes | null>(null)
  /** Container-relative Y-coordinates of each segment's center for the
   *  current chapter. Built once at play-start. Segment detection during
   *  playback is O(log n) against this array — no per-frame getClientRects. */
  const segmentCenterPxRef = useRef<Float64Array | null>(null)
  /** The `container.scrollTop` value at play-start. During WAAPI playback
   *  scrollTop stays pinned at this value; all visible motion comes from
   *  the column's animated transform. On pause we reconcile. */
  const baselineScrollTopRef = useRef(0)
  /** Last playbackRate written to the animator. Deduplicates per-frame writes. */
  const lastAppliedPlaybackRateRef = useRef(1)
  /** Current segment index, tracked locally during playback and flushed
   *  to positionStore only on pause/chapter-end. Both legacy and WAAPI
   *  paths use this. Avoiding per-segment store commits during play
   *  eliminates the React re-render cascade + the progress saver's
   *  synchronous `localStorage.setItem`, both of which land on the main
   *  thread and produce visible hitches on mobile. */
  const liveArrIdxRef = useRef<number | null>(null)

  // RSVP live word (used for display only). Re-renders this hook
  // (and only this hook) when the word changes.
  const rsvpWord = useRsvpLiveWord(segments)

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  const stopRaf = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
    // Drop any sub-pixel transform offset now that the engine is no
    // longer writing scrollTop. Leaving it applied would offset every
    // getBoundingClientRect read inside the column by a fractional
    // pixel — harmless visually, but makes segment detection and
    // highlight math slightly off.
    formattedViewRef.current?.resetSubpixelScroll?.()
  }, [formattedViewRef])

  /** Translate the store's absolute segment index into a loaded array
   *  index. Returns null if the cursor points outside the loaded window. */
  const getArrayIdx = useCallback((): number | null => {
    const abs = positionStore.getSnapshot().absoluteSegmentIndex
    return translatorsRef.current.absoluteToArrayIndex(abs)
  }, [])

  /** Commit a new array index to the store. Looks up the absolute via
   *  the translator and dispatches with origin='engine'. */
  const commitArrayIdx = useCallback(
    (arrayIdx: number, wordIndex = 0): void => {
      const abs = translatorsRef.current.arrayToAbsolute(arrayIdx)
      if (abs == null) return
      positionStore.setPosition(
        { absoluteSegmentIndex: abs, wordIndex },
        'engine',
      )
      onPrefetchHintRef.current?.(arrayIdx)
    },
    [],
  )

  /* ---------------------------------------------------------------- */
  /*  Phrase mode tick                                                 */
  /* ---------------------------------------------------------------- */

  const tickPhrase = useCallback(
    (timestamp: number): boolean => {
      const segs = segmentsRef.current
      const total = totalSegmentsRef.current
      const idx = getArrayIdx()
      if (idx == null || idx >= segs.length) {
        // Cursor outside loaded window. If more segments are coming,
        // wait for them; otherwise complete.
        if (total > 0 && segs.length < total) {
          waitingForSegmentsRef.current = true
          positionStore.setPlaying(false)
          return false
        }
        if (!onCompleteRef.current?.()) positionStore.setPlaying(false)
        return false
      }

      if (lastTimestampRef.current > 0) {
        elapsedRef.current += timestamp - lastTimestampRef.current
      }
      lastTimestampRef.current = timestamp

      const segment = segs[idx]
      const wpm = positionStore.getSnapshot().wpm
      const duration = getSegmentDuration(segment, wpm)

      if (elapsedRef.current >= duration) {
        const nextIdx = idx + 1
        elapsedRef.current = 0

        if (nextIdx >= segs.length) {
          if (total > 0 && segs.length < total) {
            waitingForSegmentsRef.current = true
            positionStore.setPlaying(false)
            onPrefetchHintRef.current?.(nextIdx)
            return false
          }
          if (!onCompleteRef.current?.()) positionStore.setPlaying(false)
          return false
        }

        commitArrayIdx(nextIdx)
      }

      return true
    },
    [commitArrayIdx, getArrayIdx],
  )

  /* ---------------------------------------------------------------- */
  /*  RSVP mode tick                                                   */
  /* ---------------------------------------------------------------- */

  const tickRsvp = useCallback(
    (timestamp: number): boolean => {
      const segs = segmentsRef.current
      const total = totalSegmentsRef.current
      const segIdx = getArrayIdx()
      if (segIdx == null || segIdx >= segs.length) {
        if (total > 0 && segs.length < total) {
          waitingForSegmentsRef.current = true
          positionStore.setPlaying(false)
          return false
        }
        if (!onCompleteRef.current?.()) positionStore.setPlaying(false)
        return false
      }

      if (lastTimestampRef.current > 0) {
        elapsedRef.current += timestamp - lastTimestampRef.current
      }
      lastTimestampRef.current = timestamp

      const words = getWordsFromSegment(segs[segIdx])
      const wordIdx = wordIndexRef.current
      const currentWord = words[wordIdx] ?? ''
      const wpm = positionStore.getSnapshot().wpm
      const duration = getWordDuration(currentWord, wpm)

      if (elapsedRef.current >= duration) {
        elapsedRef.current = 0
        const nextWordIdx = wordIdx + 1

        if (nextWordIdx >= words.length) {
          // Segment boundary — flush to store, advance segment.
          const nextSegIdx = segIdx + 1
          if (nextSegIdx >= segs.length) {
            if (total > 0 && segs.length < total) {
              waitingForSegmentsRef.current = true
              positionStore.setPlaying(false)
              onPrefetchHintRef.current?.(nextSegIdx)
              return false
            }
            if (!onCompleteRef.current?.()) positionStore.setPlaying(false)
            return false
          }
          wordIndexRef.current = 0
          commitArrayIdx(nextSegIdx, 0)
          // Show the first word of the next segment immediately to
          // avoid a flash of empty content between segments.
          const nextWords = getWordsFromSegment(segs[nextSegIdx])
          rsvpWord.notify(nextWords[0] ?? '')
        } else {
          wordIndexRef.current = nextWordIdx
          rsvpWord.notify(words[nextWordIdx] ?? '')
        }
      }

      return true
    },
    [commitArrayIdx, getArrayIdx, rsvpWord],
  )

  /* ---------------------------------------------------------------- */
  /*  Scroll mode tick (focus + formatted)                             */
  /* ---------------------------------------------------------------- */

  /** Resolve the live scroll container for the current display mode. */
  const getActiveScrollContainer = useCallback((): HTMLDivElement | null => {
    const displayMode = positionStore.getSnapshot().displayMode
    if (displayMode === 'formatted') {
      return formattedViewRef.current?.getScrollContainer() ?? null
    }
    return focusContainerRef.current
  }, [focusContainerRef, formattedViewRef])

  const computeAverageSpeed = useCallback(() => {
    const segs = segmentsRef.current
    if (segs.length === 0) return

    let totalWords = 0
    for (let i = 0; i < segs.length; i++) {
      const wc = segs[i].word_count || segs[i].text.trim().split(/\s+/).filter(Boolean).length
      totalWords += Math.max(wc, 0)
    }
    if (totalWords === 0) return

    const container = getActiveScrollContainer()
    if (!container) return

    const displayMode = positionStore.getSnapshot().displayMode

    if (displayMode === 'formatted') {
      // In formatted mode the scroll container holds ALL chapters but
      // segments only covers the CURRENT chapter. Use the current
      // chapter's section element height instead of the full scrollable
      // height to avoid a massive speed mismatch.
      const chapterIdx = positionStore.getSnapshot().chapterIdx
      const handle = formattedViewRef.current
      const sectionEl = handle?.getSectionEl(chapterIdx)
      const sectionHeight = sectionEl
        ? sectionEl.getBoundingClientRect().height
        : container.scrollHeight - container.clientHeight
      if (sectionHeight > 0) {
        pxPerSecPerWpmRef.current = sectionHeight / (totalWords * 60)
      }
    } else {
      // Plain / focus mode: use the focus container's scrollable height
      // (all segments are rendered in this container).
      if (container.scrollHeight > container.clientHeight) {
        const scrollableHeight = container.scrollHeight - container.clientHeight
        pxPerSecPerWpmRef.current = scrollableHeight / (totalWords * 60)
      } else {
        // Fallback: sum individual element heights
        const items = focusItemOffsetsRef.current
        if (!items || items.size === 0) return
        let totalHeight = 0
        for (let i = 0; i < segs.length; i++) {
          const el = items.get(i)
          if (el) totalHeight += el.getBoundingClientRect().height
        }
        if (totalHeight > 0) {
          pxPerSecPerWpmRef.current = totalHeight / (totalWords * 60)
        }
      }
    }
  }, [focusItemOffsetsRef, formattedViewRef, getActiveScrollContainer])

  /** In focus mode: walk item rects, find the one closest to viewport
   *  center, return its array index. In formatted mode: bisect the
   *  velocity profile or fall back to the proportional mapping in
   *  FormattedView's section. */
  const lastDetectedPlainIdxRef = useRef<number>(0)

  const detectArrayIdxFromScroll = useCallback(
    (container: HTMLDivElement, displayMode: 'plain' | 'formatted'): number | null => {
      if (displayMode === 'plain') {
        const items = focusItemOffsetsRef.current
        if (!items || items.size === 0) return null
        const containerRect = container.getBoundingClientRect()
        const centerY = containerRect.top + containerRect.height * REFERENCE_LINE_RATIO

        // Only check items near the last detected index instead of
        // walking all items. During forward scroll we typically advance
        // by 0-1 items between checks, so a ±5 window is generous.
        const SEARCH_RADIUS = 5
        const lastIdx = lastDetectedPlainIdxRef.current
        const keys = Array.from(items.keys())
        const lo = Math.max(0, keys.indexOf(lastIdx) - SEARCH_RADIUS)
        const hi = Math.min(keys.length, keys.indexOf(lastIdx) + SEARCH_RADIUS + 1)
        // Fallback to full scan if lastIdx isn't in the map (chapter change)
        const searchKeys = lo < hi && keys.indexOf(lastIdx) >= 0
          ? keys.slice(lo, hi)
          : keys

        let closestIdx: number | null = null
        let closestDist = Infinity
        for (const idx of searchKeys) {
          const el = items.get(idx)
          if (!el) continue
          const rect = el.getBoundingClientRect()
          const itemCenter = rect.top + rect.height / 2
          const dist = Math.abs(itemCenter - centerY)
          if (dist < closestDist) {
            closestDist = dist
            closestIdx = idx
          }
        }
        if (closestIdx != null) lastDetectedPlainIdxRef.current = closestIdx
        return closestIdx
      }

      // Formatted mode: use the same block-walk + segment-range algorithm
      // as the pip and pause-mode scroll detection. This ensures playback
      // position always matches what the user sees.
      const handle = formattedViewRef.current
      if (!handle) return null
      const chapterIdx = positionStore.getSnapshot().chapterIdx
      const segs = segmentsRef.current
      const result = handle.detectAtViewportCenter(chapterIdx, segs)
      return result?.arrIdx ?? null
    },
    [focusItemOffsetsRef, formattedViewRef],
  )

  const tickScroll = useCallback(
    (timestamp: number, isTrack: boolean): boolean => {
      const container = getActiveScrollContainer()
      if (!container) return true // try again next frame

      /* -------------------------------------------------------------- */
      /*  WAAPI compositor-scroll fast path                              */
      /* -------------------------------------------------------------- */
      // When a live animator is driving the column's transform, the
      // rAF loop does NOT write scrollTop. Its only job is to:
      //   (1) sample gaze, lerp the speed multiplier, push the new
      //       playbackRate to the compositor
      //   (2) throttled segment detection via virtualOffset + a
      //       precomputed segmentCenterPx[] binary search
      // The animation's `finished` promise handles end-of-chapter —
      // the tick body never observes it directly.
      const animator = animatorRef.current
      const keyframes = keyframesRef.current
      if (animator && animator.isActive() && keyframes) {
        const dt = lastTimestampRef.current > 0
          ? Math.min((timestamp - lastTimestampRef.current) / 1000, 0.25)
          : 0
        lastTimestampRef.current = timestamp

        // (1) Gaze-driven speed multiplier (track mode only).
        let multiplier = 1.0
        if (isTrack) {
          const gaze = gazeRef.current
          const elapsedSincePlay = performance.now() - playStartTimeRef.current
          const inGracePeriod = elapsedSincePlay < PLAY_GRACE_MS
          const intensity =
            gaze.intensity < INTENSITY_DEADZONE ? 0 : gaze.intensity
          let target = 1.0
          if (inGracePeriod) {
            target = 1.0
          } else if (gaze.direction === 'down' && intensity > 0) {
            target = 1.0 + 1.5 * intensity
          } else if (gaze.direction === 'up' && intensity > 0) {
            if (intensity <= HOLD_THRESHOLD) {
              target = 1.0 - intensity / HOLD_THRESHOLD
            } else {
              target =
                MIN_MULTIPLIER *
                ((intensity - HOLD_THRESHOLD) / (1 - HOLD_THRESHOLD))
            }
          }
          target = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, target))
          const delta = target - speedMultiplierRef.current
          if (Math.abs(delta) < MULTIPLIER_SNAP) {
            speedMultiplierRef.current = target
          } else {
            const isDecelerating = delta < 0
            const tau = isDecelerating ? 0.45 : 0.30
            const lerpRate = 1 - Math.exp(-dt / tau)
            speedMultiplierRef.current += delta * lerpRate
          }
          multiplier = speedMultiplierRef.current
        } else {
          speedMultiplierRef.current = 1.0
        }

        // Compose the compositor rate: WPM scaling × gaze multiplier.
        const wpm = positionStore.getSnapshot().wpm
        const baselineWpm = keyframes.baselineWpm || DEFAULT_WPM
        let targetRate = (wpm / baselineWpm) * multiplier
        if (isTrack && targetRate > 0) {
          // Clamp the absolute upper bound to MAX_EFFECTIVE_WPM so a
          // gaze blip can't overshoot the compositor into motion-sick
          // speeds.
          const maxRate = MAX_EFFECTIVE_WPM / baselineWpm
          targetRate = Math.min(targetRate, maxRate)
        }
        if (targetRate !== lastAppliedPlaybackRateRef.current) {
          animator.setPlaybackRate(targetRate)
          lastAppliedPlaybackRateRef.current = targetRate
        }

        // (2) Throttled segment tracking. Every 10 frames (~167 ms at
        // 60 Hz), find the segment at the reference line via binary
        // search on the precomputed midpoint table. No DOM reads.
        //
        // IMPORTANT: we do NOT commit to positionStore during WAAPI
        // playback. A store commit cascades into React re-renders
        // plus a synchronous `localStorage.setItem` via the progress
        // saver — both land on the main thread and, on mobile, take
        // long enough to drop frames. Since the WAAPI motion runs on
        // the compositor, any such main-thread stall shows up as a
        // visible "hitch" ~1×/sec. Instead we track the idx locally
        // and flush once on pause / chapter-end.
        if (++segCheckCounterRef.current >= 10) {
          segCheckCounterRef.current = 0
          const centers = segmentCenterPxRef.current
          if (centers && centers.length > 0) {
            const virtualPx = animator.virtualOffset()
            const referencePx =
              baselineScrollTopRef.current +
              virtualPx +
              container.clientHeight * REFERENCE_LINE_RATIO
            const newIdx = binarySearchLE(centers, referencePx)
            if (newIdx >= 0) liveArrIdxRef.current = newIdx
          }
        }

        return true
      }

      /* -------------------------------------------------------------- */
      /*  Legacy rAF + scrollTop path                                    */
      /* -------------------------------------------------------------- */

      // Always use constant-speed scrolling. Recompute the average
      // speed ratio on first tick or after a chapter/play reset.
      if (pxPerSecPerWpmRef.current === 0) {
        computeAverageSpeed()
        scrollPositionRef.current = container.scrollTop
      }

      const haveModel = pxPerSecPerWpmRef.current > 0
      const wpm = positionStore.getSnapshot().wpm

      if (lastTimestampRef.current > 0 && haveModel) {
        const rawDt = (timestamp - lastTimestampRef.current) / 1000
        // Clamp dt to avoid massive scroll jumps after frame gaps
        // (tab switch, heavy re-render, GC pause). 0.25 s ≈ 4 fps floor.
        const dt = Math.min(rawDt, 0.25)

        // Track mode: gaze multiplier on top of base speed.
        let multiplier = 1.0
        if (isTrack) {
          const gaze = gazeRef.current
          const elapsedSincePlay = performance.now() - playStartTimeRef.current
          const inGracePeriod = elapsedSincePlay < PLAY_GRACE_MS
          // Intensity deadzone: gaze.intensity already comes from the
          // processor with its own classifier-level deadzone, but tiny
          // residual jitter just above that floor still feeds a non-zero
          // target which the lerp then chases forever. Treat intensity
          // below INTENSITY_DEADZONE as neutral to keep the target at 1.0.
          const intensity = gaze.intensity < INTENSITY_DEADZONE ? 0 : gaze.intensity
          let target = 1.0
          if (inGracePeriod) {
            target = 1.0
          } else if (gaze.direction === 'down' && intensity > 0) {
            target = 1.0 + 1.5 * intensity
          } else if (gaze.direction === 'up' && intensity > 0) {
            if (intensity <= HOLD_THRESHOLD) {
              const holdProgress = intensity / HOLD_THRESHOLD
              target = 1.0 - holdProgress
            } else {
              const reverseProgress =
                (intensity - HOLD_THRESHOLD) / (1 - HOLD_THRESHOLD)
              target = MIN_MULTIPLIER * reverseProgress
            }
          }
          target = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, target))
          const delta = target - speedMultiplierRef.current
          // Hysteresis snap: once within MULTIPLIER_SNAP of target, set
          // exactly — prevents the exponential lerp from asymptotically
          // oscillating on float noise (the residual drift is far below
          // perceptible but pulls on the px/sec integration every frame).
          if (Math.abs(delta) < MULTIPLIER_SNAP) {
            speedMultiplierRef.current = target
          } else {
            const isDecelerating = delta < 0
            const tau = isDecelerating ? 0.45 : 0.30
            const lerpRate = 1 - Math.exp(-dt / tau)
            speedMultiplierRef.current += delta * lerpRate
          }
          multiplier = speedMultiplierRef.current
        }

        // Per-tick px/sec. In formatted mode with a velocity profile,
        // sample `pxPerWeight` at the reference line and derive px/sec
        // from it — this slows the engine through code blocks, tables,
        // images, and headings where readers actually need more dwell
        // time. Outside those weighted blocks `pxPerWeight` equals the
        // local paragraph's height-per-word, which matches the old
        // constant-average model to within the blend window. Plain mode
        // and any formatted path without a profile fall back to the
        // chapter-average constant.
        //
        // pxPerWeight * (wpm / 60) follows from the derivation in
        // velocityProfile.ts: an element of weight `w` and height `h`
        // should occupy w / (wpm/60) seconds of scroll.
        const displayMode = positionStore.getSnapshot().displayMode
        const profile = velocityProfileRef.current
        let basePxPerSec = 0
        if (
          displayMode === 'formatted' &&
          profile &&
          profile.entries.length > 0
        ) {
          const centerY =
            container.scrollTop + container.clientHeight * REFERENCE_LINE_RATIO
          const ppw = getPxPerWeight(profile, centerY, profileLookupCacheRef.current)
          if (ppw > 0) basePxPerSec = ppw * (wpm / 60)
        }
        // Fallback / plain mode: chapter-average constant.
        if (basePxPerSec === 0) {
          basePxPerSec = pxPerSecPerWpmRef.current * wpm
        }

        if (basePxPerSec > 0) {
          let effectivePxPerSec = basePxPerSec * multiplier
          if (isTrack && effectivePxPerSec > 0) {
            const pxPerSecAtOneWpm = basePxPerSec / wpm
            effectivePxPerSec = Math.min(effectivePxPerSec, pxPerSecAtOneWpm * MAX_EFFECTIVE_WPM)
          }
          scrollPositionRef.current += effectivePxPerSec * dt
          if (scrollPositionRef.current < 0) scrollPositionRef.current = 0

          // Integer `scrollTop` only. The previous sub-pixel translate3d
          // smoother (applied as a transform on the column to fill the
          // gap left by integer snapping) caused two problems on mobile:
          //   1. Any transform with non-integer Y value promoted the
          //      text to a compositor layer and switched anti-aliasing
          //      from subpixel → grayscale. Per-frame value changes
          //      then re-rasterized glyphs at sub-pixel positions,
          //      producing the "bold shimmer" symptom.
          //   2. The resulting compositor layer was chapter-height and
          //      exceeded mobile Safari's raster budget, so it stalled
          //      on tile raster — hitches.
          // Integer scrollTop uses the browser's native scrollable-
          // container pipeline: tiles are rasterized only for the
          // visible region, text stays in subpixel AA, and motion
          // looks native. The trade-off is 1 px stair-step at very
          // slow (< 1 px/frame) track-mode speeds; invisible at
          // normal reading velocity.
          container.scrollTop = Math.floor(scrollPositionRef.current)

          const maxScroll = container.scrollHeight - container.clientHeight
          const endTolerance = Math.max(2, Math.ceil(dpr))
          if (container.scrollTop >= maxScroll - endTolerance) {
            if (!onCompleteRef.current?.()) positionStore.setPlaying(false)
            return false
          }
        }
      }
      lastTimestampRef.current = timestamp

      // Segment tracking. Update `liveArrIdxRef` every 10 frames via a
      // precomputed midpoint-table binary search when available, else
      // fall back to the DOM-reading detector (section not ready, plain
      // mode without midpoint table, etc.). We do NOT commit to the
      // position store during playback — that cascade (React re-render
      // + progress saver's synchronous localStorage.setItem) is the
      // second-worst source of mobile hitches. pause() flushes the
      // final idx on the way out.
      if (++segCheckCounterRef.current >= 10) {
        segCheckCounterRef.current = 0
        const displayMode = positionStore.getSnapshot().displayMode
        const centers = segmentCenterPxRef.current
        let newIdx: number | null = null
        if (
          displayMode === 'formatted' &&
          centers != null &&
          centers.length > 0
        ) {
          const referencePx =
            container.scrollTop +
            container.clientHeight * REFERENCE_LINE_RATIO
          const found = binarySearchLE(centers, referencePx)
          if (found >= 0) newIdx = found
        } else {
          newIdx = detectArrayIdxFromScroll(container, displayMode)
        }
        if (newIdx != null) liveArrIdxRef.current = newIdx
      }

      return true
    },
    [
      computeAverageSpeed,
      detectArrayIdxFromScroll,
      gazeRef,
      getActiveScrollContainer,
      dpr,
    ],
  )

  /* ---------------------------------------------------------------- */
  /*  Master tick — branch on mode                                     */
  /* ---------------------------------------------------------------- */

  const tick = useCallback(
    (timestamp: number) => {
      const mode = positionStore.getSnapshot().mode
      let keepGoing = false
      switch (mode) {
        case 'phrase':
          keepGoing = tickPhrase(timestamp)
          break
        case 'rsvp':
          keepGoing = tickRsvp(timestamp)
          break
        case 'scroll':
          keepGoing = tickScroll(timestamp, false)
          break
        case 'track':
          keepGoing = tickScroll(timestamp, true)
          break
      }
      if (keepGoing) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        stopRaf()
      }
    },
    [stopRaf, tickPhrase, tickRsvp, tickScroll],
  )

  /* ---------------------------------------------------------------- */
  /*  Pause / play / seek — public actions                             */
  /* ---------------------------------------------------------------- */

  /** Flush controller-local state into the store. Called by pause(),
   *  visibility-hidden, and unmount so the saver always sees the live
   *  intra-segment word index. */
  const flushLocalState = useCallback(() => {
    if (positionStore.getSnapshot().mode === 'rsvp' && wordIndexRef.current > 0) {
      const arr = getArrayIdx()
      if (arr != null) commitArrayIdx(arr, wordIndexRef.current)
    }
  }, [commitArrayIdx, getArrayIdx])

  /** Dispose any live WAAPI animator and clear its cached state. Does not
   *  touch scrollTop or transforms — callers are expected to have
   *  already done the visual reconciliation if they need it. */
  const disposeAnimator = useCallback(() => {
    animatorRef.current?.cancel()
    animatorRef.current = null
    keyframesRef.current = null
    segmentCenterPxRef.current = null
    lastAppliedPlaybackRateRef.current = 1
  }, [])

  /** Build and install the WAAPI compositor animator for formatted
   *  scroll/track playback. Called from play() once the profile has
   *  been rebuilt. Silently no-ops if prerequisites are missing so the
   *  legacy tick path remains the fallback. */
  const tryBuildFormattedAnimator = useCallback(
    (
      handle: FormattedViewHandle,
      container: HTMLDivElement,
      chapterIdx: number,
      mode: 'scroll' | 'track',
    ) => {
      disposeAnimator()

      const column = handle.getAnimatedColumn()
      if (!column) return

      // Resolve the end-of-chapter scroll position. Prefer the section's
      // bottom so we don't attempt to animate past the current chapter's
      // content; fall back to the container's scrollable extent.
      const sectionEl = handle.getSectionEl(chapterIdx)
      const clientHeight = container.clientHeight
      const baselineScrollTop = container.scrollTop
      let endPx: number
      if (sectionEl) {
        const sectionRect = sectionEl.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        const sectionBottomInContainer =
          sectionRect.bottom - containerRect.top + container.scrollTop
        // We stop the animation when the reference line reaches the
        // bottom of the section — past that, the next chapter should
        // take over. That translates to:
        //   maxScrollTop = sectionBottomInContainer - clientHeight * REFERENCE_LINE_RATIO
        endPx =
          sectionBottomInContainer - clientHeight * REFERENCE_LINE_RATIO
      } else {
        endPx = container.scrollHeight - clientHeight
      }
      // Clamp to usable range.
      endPx = Math.max(endPx, baselineScrollTop + 1)

      // Prefer the velocity profile; fall back to a constant-speed
      // chapter-average model if the profile isn't ready, or if the
      // user forced constant speed via the `waapiConstantSpeed` flag
      // to A/B test whether profile-boundary slope discontinuities
      // are the source of perceived choppiness.
      const profile = velocityProfileRef.current
      const forceConstant = waapiConstantSpeedForced()
      let kf: PlaybackKeyframes | null = null
      if (!forceConstant && profile && profile.entries.length > 0) {
        kf = buildPlaybackKeyframes(
          profile,
          baselineScrollTop,
          endPx,
          DEFAULT_WPM,
        )
      }
      if (!kf || kf.totalDistancePx <= 0 || kf.totalDurationMs <= 0) {
        let totalWords = 0
        for (const s of segmentsRef.current) {
          const wc =
            s.word_count ||
            s.text.trim().split(/\s+/).filter(Boolean).length
          totalWords += Math.max(wc, 0)
        }
        const distance = Math.max(0, endPx - baselineScrollTop)
        if (distance <= 0 || totalWords <= 0) return
        kf = buildConstantKeyframes(distance, totalWords, DEFAULT_WPM)
      }
      if (kf.totalDurationMs <= 0 || kf.totalDistancePx <= 0) return

      // Precompute segment midpoints for the compositor tick's
      // boundary-detection binary search.
      const segmentCenterYs = handle.buildSegmentCenterYs(
        chapterIdx,
        segmentsRef.current,
      )
      if (!segmentCenterYs) {
        // Section not ready — skip the WAAPI path this time; legacy
        // tick will handle detection via DOM reads.
        return
      }

      keyframesRef.current = kf
      segmentCenterPxRef.current = segmentCenterYs
      baselineScrollTopRef.current = baselineScrollTop
      liveArrIdxRef.current = null

      // Initial rate respects WPM scaling. Track-mode gaze multiplier
      // starts at 1 (PLAY_GRACE_MS window suppresses any initial tilt).
      const wpm = positionStore.getSnapshot().wpm
      const initialRate = wpm / DEFAULT_WPM
      lastAppliedPlaybackRateRef.current = initialRate

      // Ensure any previous inline transform is cleared so the animation
      // starts from identity (otherwise the new keyframe origin would
      // composite on top of stale CSS).
      column.style.transform = ''

      try {
        animatorRef.current = createPlaybackAnimator({
          column,
          keyframes: kf,
          initialPlaybackRate: initialRate,
          onFinished: () => {
            // Animation hit its natural end. Reconcile scrollTop so
            // the container reflects the final virtual position — the
            // animation's `fill: 'forwards'` held the compositor at
            // the end keyframe, but scrollTop is still pinned at the
            // baseline. Without this, clearing the transform (or any
            // later scroll event) would visually snap the reader back
            // to the chapter's start.
            const totalDistance = kf.totalDistancePx
            const h = formattedViewRef.current
            const cont = h?.getScrollContainer()
            const col = h?.getAnimatedColumn()
            if (cont && col) {
              cont.scrollTop = Math.round(
                baselineScrollTopRef.current + totalDistance,
              )
              col.style.transform = ''
            }
            // Flush the final segment index one last time so the
            // end-of-chapter position persists. After this we clear
            // all WAAPI refs.
            const flushIdx = liveArrIdxRef.current
            liveArrIdxRef.current = null
            if (flushIdx != null && flushIdx !== getArrayIdx()) {
              commitArrayIdx(flushIdx)
            }
            animatorRef.current?.cancel()
            animatorRef.current = null
            keyframesRef.current = null
            segmentCenterPxRef.current = null
            if (!onCompleteRef.current?.()) positionStore.setPlaying(false)
          },
        })
      } catch {
        // Animate() threw — give up on WAAPI for this play session.
        animatorRef.current = null
        keyframesRef.current = null
        segmentCenterPxRef.current = null
      }

      void mode // reserved for future mode-specific tuning
    },
    [
      commitArrayIdx,
      disposeAnimator,
      formattedViewRef,
      getArrayIdx,
      velocityProfileRef,
    ],
  )

  const play = useCallback(() => {
    if (segmentsRef.current.length === 0) return
    if (positionStore.getSnapshot().isPlaying) return

    const mode = positionStore.getSnapshot().mode
    const displayMode = positionStore.getSnapshot().displayMode

    // Reset tick-local state. We DO NOT reset elapsedRef here — that
    // would lose the intra-segment timing position across pause/play.
    // External commits (chapter nav, user seek) reset elapsedRef via
    // the cursor-revision effect below; manual pause/play preserves it.
    lastTimestampRef.current = 0
    waitingForSegmentsRef.current = false
    if (mode === 'scroll' || mode === 'track') {
      speedMultiplierRef.current = 1.0
      segCheckCounterRef.current = 0
      playStartTimeRef.current = performance.now()
      pxPerSecPerWpmRef.current = 0 // re-cache on next tick
    }

    // Snap the position store to the segment at the pip's current
    // location. During pause-mode scrolling, Effect 3 updates the store
    // via a rAF callback — but that callback may still be pending when
    // the user taps play. Refresh the pip first so its coordinates
    // reflect any layout changes since the last scroll event, then
    // detect the segment synchronously.
    if (displayMode === 'formatted') {
      const handle = formattedViewRef.current
      if (handle) {
        handle.refreshPipPosition()
        const chapterIdx = positionStore.getSnapshot().chapterIdx
        const segs = segmentsRef.current
        const detected = handle.detectAtViewportCenter(chapterIdx, segs)
        if (detected?.arrIdx != null) {
          const abs = translatorsRef.current.arrayToAbsolute(detected.arrIdx)
          if (abs != null && abs !== positionStore.getSnapshot().absoluteSegmentIndex) {
            positionStore.setPosition(
              { absoluteSegmentIndex: abs, wordIndex: 0 },
              'user-scroll',
            )
          }
        }
      }
    }

    // Formatted-mode play: settle images, rebuild profile. The cursor
    // position is unchanged so the existing scroll position is preserved.
    if ((mode === 'scroll' || mode === 'track') && displayMode === 'formatted') {
      const handle = formattedViewRef.current
      if (handle) {
        const chapterIdx = positionStore.getSnapshot().chapterIdx
        const startFormattedPlayback = () => {
          handle.rebuildProfile()
          const container = handle.getScrollContainer()
          if (container) {
            scrollPositionRef.current = container.scrollTop
            baselineScrollTopRef.current = container.scrollTop
          }
          // Precompute the segment-midpoint table regardless of playback
          // path. Both the native-scroll tick and the WAAPI tick look up
          // the current segment via binary search on this array, avoiding
          // per-frame getClientRects. Null result (section not ready)
          // falls back to the DOM-reading detectArrayIdxFromScroll.
          segmentCenterPxRef.current =
            handle.buildSegmentCenterYs(chapterIdx, segmentsRef.current)
          liveArrIdxRef.current = null

          // Try the WAAPI compositor path. On failure (unsupported,
          // profile unusable, column missing) we fall through to the
          // legacy rAF+scrollTop tick; no harm done.
          if (container && waapiPlaybackEnabled()) {
            tryBuildFormattedAnimator(handle, container, chapterIdx, mode)
          }
          positionStore.setPlaying(true)
          rafRef.current = requestAnimationFrame(tick)
        }
        handle
          .settleImages(chapterIdx)
          .then(startFormattedPlayback)
          .catch(startFormattedPlayback)
        return
      }
    }

    // Plain-mode scroll/track: sync scrollPositionRef to the live DOM.
    if (mode === 'scroll' || mode === 'track') {
      const container = getActiveScrollContainer()
      if (container) scrollPositionRef.current = container.scrollTop
    }

    positionStore.setPlaying(true)
    rafRef.current = requestAnimationFrame(tick)
  }, [formattedViewRef, getActiveScrollContainer, tick, tryBuildFormattedAnimator])

  /** Restart the rAF loop without touching isPlaying. Used after
   *  onComplete returned true and new segments are ready. Resets only
   *  the timing accumulators so the next tick starts fresh. */
  const resumeLoop = useCallback(() => {
    if (!positionStore.getSnapshot().isPlaying) return
    if (rafRef.current) return // already running
    lastTimestampRef.current = 0
    elapsedRef.current = 0

    const mode = positionStore.getSnapshot().mode
    const displayMode = positionStore.getSnapshot().displayMode
    if (mode === 'scroll' || mode === 'track') {
      speedMultiplierRef.current = 1.0
      segCheckCounterRef.current = 0
      playStartTimeRef.current = performance.now()
      pxPerSecPerWpmRef.current = 0
      const container = getActiveScrollContainer()
      if (container) scrollPositionRef.current = container.scrollTop

      // If we were driving the old chapter's animator, it was already
      // torn down by onFinished. Rebuild for the new chapter if the
      // WAAPI path is available; otherwise the legacy tick takes over.
      if (
        displayMode === 'formatted' &&
        waapiPlaybackEnabled() &&
        container
      ) {
        const handle = formattedViewRef.current
        if (handle) {
          const chapterIdx = positionStore.getSnapshot().chapterIdx
          tryBuildFormattedAnimator(handle, container, chapterIdx, mode)
        }
      }
    }

    rafRef.current = requestAnimationFrame(tick)
  }, [formattedViewRef, getActiveScrollContainer, tick, tryBuildFormattedAnimator])

  const pause = useCallback(() => {
    // WAAPI reconciliation first: freeze the animation as an inline
    // transform, cancel it, then synchronously swap scrollTop to the
    // virtual position and clear the transform. All three DOM writes
    // happen in the same JS tick so the browser paints them together
    // and the user sees no intermediate state. (Earlier we deferred
    // to rAF; that caused a 1-frame flash because `stopRaf` below
    // calls resetSubpixelScroll which clears the transform before the
    // rAF fires.)
    const animator = animatorRef.current
    if (animator && animator.isActive()) {
      // WAAPI path visual reconcile — freeze the animation as an inline
      // transform, swap scrollTop to the virtual position, clear the
      // transform. All three writes in one JS tick so the browser
      // paints them atomically.
      const formattedHandle = formattedViewRef.current
      const container = formattedHandle?.getScrollContainer() ?? null
      const column = formattedHandle?.getAnimatedColumn() ?? null
      const result = animator.pause()
      animatorRef.current = null
      keyframesRef.current = null
      if (container && column) {
        const target = baselineScrollTopRef.current + result.virtualOffsetPx
        container.scrollTop = Math.round(target)
        column.style.transform = ''
      }
      // Pip refresh runs on next frame so the scroll-source transition
      // from 'engine' to 'user' (flipped by setPlaying(false) below)
      // has time to land before the pip scroll-listener re-engages.
      requestAnimationFrame(() => {
        formattedViewRef.current?.refreshPipPosition()
      })
    }

    // Flush the locally-tracked segment idx once, regardless of which
    // playback path was active. Playback never commits to positionStore
    // during motion — this pause flush is the single persistence point.
    const flushIdx = liveArrIdxRef.current
    liveArrIdxRef.current = null
    segmentCenterPxRef.current = null
    if (flushIdx != null && flushIdx !== getArrayIdx()) {
      commitArrayIdx(flushIdx)
    }

    stopRaf()
    // Legacy-path deferred-commit cleanup. The native-scroll tick no
    // longer schedules these, but the refs are kept around in case the
    // WAAPI path is re-enabled mid-session via the feature flag.
    if (scrollCommitTimerRef.current) {
      clearTimeout(scrollCommitTimerRef.current)
      scrollCommitTimerRef.current = null
    }
    const pendingIdx = pendingScrollCommitRef.current
    if (pendingIdx != null) {
      pendingScrollCommitRef.current = null
      commitArrayIdx(pendingIdx)
    }
    flushLocalState()
    waitingForSegmentsRef.current = false
    positionStore.setPlaying(false)
  }, [commitArrayIdx, flushLocalState, formattedViewRef, getArrayIdx, stopRaf])

  const togglePlayPause = useCallback(() => {
    if (positionStore.getSnapshot().isPlaying) pause()
    else play()
  }, [pause, play])

  const setWpm = useCallback((value: number) => {
    positionStore.setWpm(clampWpm(value))
  }, [])

  const adjustWpm = useCallback((direction: number) => {
    const current = positionStore.getSnapshot().wpm
    positionStore.setWpm(clampWpm(current + (direction > 0 ? 25 : -25)))
  }, [])

  /** Seek to an absolute segment index. Resets all tick-local state.
   *  Origin is 'user-seek' so the formatted scroll-into-view effect
   *  fires when appropriate. */
  const seekToAbs = useCallback(
    (absoluteSegmentIndex: number, wordIndex = 0) => {
      // Reset tick-local accumulators so the next tick starts fresh.
      elapsedRef.current = 0
      lastTimestampRef.current = 0
      waitingForSegmentsRef.current = false
      wordIndexRef.current = wordIndex

      positionStore.setPosition(
        { absoluteSegmentIndex, wordIndex },
        'user-seek',
      )

      // For scroll/track in plain display, scroll the focus item to
      // center. The seekToAbs path is rare in scroll/track playing —
      // it comes from keyboard prev/next chunk and from the controls
      // scrubber. The DOM scrollIntoView is the right primitive.
      const mode = positionStore.getSnapshot().mode
      if (mode === 'scroll' || mode === 'track') {
        const arr = translatorsRef.current.absoluteToArrayIndex(absoluteSegmentIndex)
        if (arr != null) {
          const items = focusItemOffsetsRef.current
          const el = items?.get(arr)
          if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' })
          // Sync the float accumulator to the new scroll position.
          const container = getActiveScrollContainer()
          if (container) scrollPositionRef.current = container.scrollTop
        }
      }
    },
    [focusItemOffsetsRef, getActiveScrollContainer],
  )

  /* ---------------------------------------------------------------- */
  /*  Auto-resume after prefetch                                       */
  /* ---------------------------------------------------------------- */
  // Tick-only state: latches inside tick when we ran out of segments
  // mid-play. Cleared by pause() and seekToAbs().
  useEffect(() => {
    if (
      waitingForSegmentsRef.current &&
      segments.length > (getArrayIdx() ?? 0) &&
      !positionStore.getSnapshot().isPlaying
    ) {
      waitingForSegmentsRef.current = false
      play()
    }
  }, [segments, getArrayIdx, play])

  /* ---------------------------------------------------------------- */
  /*  Visibility-pause: auto-pause on tab hide, auto-resume on return  */
  /* ---------------------------------------------------------------- */
  const wasPlayingOnHideRef = useRef(false)
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && positionStore.getSnapshot().isPlaying) {
        wasPlayingOnHideRef.current = true
        flushLocalState()
        pause()
      } else if (!document.hidden && wasPlayingOnHideRef.current) {
        wasPlayingOnHideRef.current = false
        play()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [flushLocalState, pause, play])

  /* ---------------------------------------------------------------- */
  /*  Reset wordIndexRef on store-driven seg change                    */
  /* ---------------------------------------------------------------- */
  // When position moves via something other than the engine (USER_SEEK,
  // mode/chapter/toc), the controller's local wordIndexRef must reset
  // to the new position's wordIndex (or 0). Subscribing to the store's
  // revision lets us catch every move.
  const cursorRevision = usePositionSelector((s) => s.revision)
  const cursorAbs = usePositionSelector((s) => s.absoluteSegmentIndex)
  const cursorWord = usePositionSelector((s) => s.wordIndex)
  const cursorOrigin = usePositionSelector((s) => s.origin)
  useEffect(() => {
    if (cursorOrigin === 'engine') return
    // External commit — reset elapsed and word index.
    elapsedRef.current = 0
    wordIndexRef.current = cursorWord
    // If a WAAPI animator is live when an external seek lands (toc
    // click, user scrub, chapter nav) the animator is now animating
    // from a stale baseline. Rather than fight to rebuild it in place,
    // we dispose it and let the legacy tick path take over from the
    // new scrollTop. The user can pause/play to re-engage the
    // compositor path at the new position.
    if (animatorRef.current?.isActive()) {
      disposeAnimator()
    }
    // Don't touch lastTimestampRef — let the next tick set it fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorRevision])
  // Suppress unused warning by referencing the slices.
  void cursorAbs

  /* ---------------------------------------------------------------- */
  /*  Cleanup on unmount                                               */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    return () => {
      flushLocalState()
      stopRaf()
      disposeAnimator()
      if (scrollCommitTimerRef.current) {
        clearTimeout(scrollCommitTimerRef.current)
        scrollCommitTimerRef.current = null
      }
    }
  }, [disposeAnimator, flushLocalState, stopRaf])

  /* ---------------------------------------------------------------- */
  /*  Reset accumulators on chapter change                             */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    pxPerSecPerWpmRef.current = 0
  }, [segments])

  /* ---------------------------------------------------------------- */
  /*  Recompute plain-mode average speed on layout changes             */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const items = focusItemOffsetsRef.current
    if (!items || items.size === 0) return

    const lastHeights = new Map<Element, number>()
    let pendingRaf = 0

    const observer = new ResizeObserver((entries) => {
      if (pxPerSecPerWpmRef.current === 0) return
      // Don't recalculate speed mid-playback — changing the constant
      // causes a visible speed jump / jitter. Defer to next play().
      if (positionStore.getSnapshot().isPlaying) return
      let significant = false
      for (const entry of entries) {
        const el = entry.target
        const newH = entry.contentRect.height
        const prev = lastHeights.get(el) ?? 0
        if (prev === 0 || Math.abs(newH - prev) / Math.max(prev, 1) > 0.02) {
          lastHeights.set(el, newH)
          significant = true
        }
      }
      if (significant && !pendingRaf) {
        pendingRaf = requestAnimationFrame(() => {
          pendingRaf = 0
          computeAverageSpeed()
        })
      }
    })

    for (const el of items.values()) observer.observe(el)

    return () => {
      if (pendingRaf) cancelAnimationFrame(pendingRaf)
      observer.disconnect()
    }
  }, [segments, computeAverageSpeed])

  /* ---------------------------------------------------------------- */
  /*  Public handle                                                    */
  /* ---------------------------------------------------------------- */
  return {
    play,
    pause,
    togglePlayPause,
    resumeLoop,
    setWpm,
    adjustWpm,
    seekToAbs,
    rsvpWord: rsvpWord.value,
    rsvpOrpIndex: computeOrpIndex(rsvpWord.value),
  }
}

/* ------------------------------------------------------------------ */
/*  RSVP live word — isolated re-render                                */
/* ------------------------------------------------------------------ */
//
// The current RSVP word ticks at 4-12 Hz. We don't want to commit it
// to positionStore (would re-render every store subscriber that often)
// nor do we want a global ref the parent can't subscribe to. The
// solution is a tiny per-controller subscription: a useState updated
// from inside tick, returned to the parent for display.
//
// On segment boundary the controller calls notify('') and the next
// frame the new word lands. On pause / mode-switch / display-mode
// toggle the parent re-renders and reads the empty string.

function useRsvpLiveWord(segments: Segment[]): {
  value: string
  notify: (next: string) => void
} {
  const [value, setValue] = useState('')
  const notify = useCallback((next: string) => setValue(next), [])
  // Reset on chapter change.
  useEffect(() => {
    setValue('')
  }, [segments])
  return { value, notify }
}
