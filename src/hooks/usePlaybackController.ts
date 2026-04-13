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
import type { VelocityProfile } from '../lib/velocityProfile'
import { positionStore, usePositionSelector } from '../state/position/positionStore'
import type { SegmentLoaderTranslators } from './useSegmentLoader'
import { REFERENCE_LINE_RATIO, type FormattedViewHandle } from '../components/FormattedView'

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MIN_WPM = 60
const MAX_WPM = 1200
const DEFAULT_WPM = 250

// Track-mode speed multiplier bounds (gaze tilt mapping).
const MIN_MULTIPLIER = -0.6
const MAX_MULTIPLIER = 2.5
const HOLD_THRESHOLD = 0.55
const PLAY_GRACE_MS = 800
const MAX_EFFECTIVE_WPM = 1500

function clampWpm(value: number): number {
  return Math.max(MIN_WPM, Math.min(MAX_WPM, value))
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
  /** Called when the engine reaches the end of the chapter. */
  onComplete?: () => void
}

export interface PlaybackControllerHandle {
  play: () => void
  pause: () => void
  togglePlayPause: () => void
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
  /** Scroll/track average speed cache (focus mode without velocity profile). */
  const pxPerSecPerWpmRef = useRef(0)
  /** Latch flipped true when tick discovers we ran out of loaded segments
   *  mid-play; cleared on pause(), seekToAbs(), or by the prefetch-arrival
   *  effect. While true, the prefetch-arrival effect is allowed to auto-resume. */
  const waitingForSegmentsRef = useRef(false)

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
  }, [])

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
        positionStore.setPlaying(false)
        onCompleteRef.current?.()
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
          positionStore.setPlaying(false)
          onCompleteRef.current?.()
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
        positionStore.setPlaying(false)
        onCompleteRef.current?.()
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
            positionStore.setPlaying(false)
            onCompleteRef.current?.()
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
      totalWords += segs[i].word_count || segs[i].text.split(/\s+/).length
    }
    if (totalWords === 0) return

    // Use the active scroll container's scrollable height for the ratio.
    // Works for both plain (focus) and formatted display modes.
    const container = getActiveScrollContainer()
    if (container && container.scrollHeight > container.clientHeight) {
      const scrollableHeight = container.scrollHeight - container.clientHeight
      pxPerSecPerWpmRef.current = scrollableHeight / (totalWords * 60)
    } else {
      // Fallback: sum individual element heights (plain mode only)
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
  }, [focusItemOffsetsRef, getActiveScrollContainer])

  /** In focus mode: walk item rects, find the one closest to viewport
   *  center, return its array index. In formatted mode: bisect the
   *  velocity profile or fall back to the proportional mapping in
   *  FormattedView's section. */
  const detectArrayIdxFromScroll = useCallback(
    (container: HTMLDivElement, displayMode: 'plain' | 'formatted'): number | null => {
      if (displayMode === 'plain') {
        const items = focusItemOffsetsRef.current
        if (!items || items.size === 0) return null
        const containerRect = container.getBoundingClientRect()
        const centerY = containerRect.top + containerRect.height * REFERENCE_LINE_RATIO
        let closestIdx: number | null = null
        let closestDist = Infinity
        items.forEach((el, idx) => {
          const rect = el.getBoundingClientRect()
          const itemCenter = rect.top + rect.height / 2
          const dist = Math.abs(itemCenter - centerY)
          if (dist < closestDist) {
            closestDist = dist
            closestIdx = idx
          }
        })
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

      // Always use constant-speed scrolling. Recompute the average
      // speed ratio on first tick or after a chapter/play reset.
      if (pxPerSecPerWpmRef.current === 0) {
        computeAverageSpeed()
        scrollPositionRef.current = container.scrollTop
      }

      const haveModel = pxPerSecPerWpmRef.current > 0
      const wpm = positionStore.getSnapshot().wpm

      if (lastTimestampRef.current > 0 && haveModel) {
        const dt = (timestamp - lastTimestampRef.current) / 1000

        // Track mode: gaze multiplier on top of base speed.
        let multiplier = 1.0
        if (isTrack) {
          const gaze = gazeRef.current
          const elapsedSincePlay = Date.now() - playStartTimeRef.current
          const inGracePeriod = elapsedSincePlay < PLAY_GRACE_MS
          let target = 1.0
          if (inGracePeriod) {
            target = 1.0
          } else if (gaze.direction === 'down') {
            target = 1.0 + 1.5 * gaze.intensity
          } else if (gaze.direction === 'up') {
            if (gaze.intensity <= HOLD_THRESHOLD) {
              const holdProgress = gaze.intensity / HOLD_THRESHOLD
              target = 1.0 - holdProgress
            } else {
              const reverseProgress =
                (gaze.intensity - HOLD_THRESHOLD) / (1 - HOLD_THRESHOLD)
              target = MIN_MULTIPLIER * reverseProgress
            }
          }
          target = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, target))
          const isDecelerating = target < speedMultiplierRef.current
          const tau = isDecelerating ? 0.45 : 0.30
          const lerpRate = 1 - Math.exp(-dt / tau)
          speedMultiplierRef.current +=
            (target - speedMultiplierRef.current) * lerpRate
          multiplier = speedMultiplierRef.current
        }

        const basePxPerSec = pxPerSecPerWpmRef.current * wpm

        if (basePxPerSec > 0) {
          let effectivePxPerSec = basePxPerSec * multiplier
          if (isTrack && effectivePxPerSec > 0) {
            const pxPerSecAtOneWpm = basePxPerSec / wpm
            effectivePxPerSec = Math.min(effectivePxPerSec, pxPerSecAtOneWpm * MAX_EFFECTIVE_WPM)
          }
          scrollPositionRef.current += effectivePxPerSec * dt
          if (scrollPositionRef.current < 0) scrollPositionRef.current = 0
          container.scrollTop = Math.floor(scrollPositionRef.current * dpr) / dpr

          const maxScroll = container.scrollHeight - container.clientHeight
          const endTolerance = Math.max(2, Math.ceil(dpr))
          if (container.scrollTop >= maxScroll - endTolerance) {
            positionStore.setPlaying(false)
            onCompleteRef.current?.()
            return false
          }
        }
      }
      lastTimestampRef.current = timestamp

      // Segment detection. Track mode throttles to ~6 Hz; scroll runs
      // every frame because the focus item-rect walk is cheap.
      let shouldDetect = !isTrack
      if (isTrack) {
        if (++segCheckCounterRef.current >= 10) {
          segCheckCounterRef.current = 0
          shouldDetect = true
        }
      }
      if (shouldDetect) {
        const displayMode = positionStore.getSnapshot().displayMode
        const newIdx = detectArrayIdxFromScroll(container, displayMode)
        if (newIdx != null) {
          const currentArr = getArrayIdx()
          if (newIdx !== currentArr) {
            commitArrayIdx(newIdx)
          }
        }
      }

      return true
    },
    [
      computeAverageSpeed,
      detectArrayIdxFromScroll,
      gazeRef,
      getActiveScrollContainer,
      commitArrayIdx,
      getArrayIdx,
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
      playStartTimeRef.current = Date.now()
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
        handle
          .settleImages(chapterIdx)
          .then(() => {
            handle.rebuildProfile()
            const container = handle.getScrollContainer()
            if (container) scrollPositionRef.current = container.scrollTop
            positionStore.setPlaying(true)
            rafRef.current = requestAnimationFrame(tick)
          })
          .catch(() => {
            handle.rebuildProfile()
            const container = handle.getScrollContainer()
            if (container) scrollPositionRef.current = container.scrollTop
            positionStore.setPlaying(true)
            rafRef.current = requestAnimationFrame(tick)
          })
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
  }, [formattedViewRef, getActiveScrollContainer, tick])

  const pause = useCallback(() => {
    stopRaf()
    flushLocalState()
    waitingForSegmentsRef.current = false
    positionStore.setPlaying(false)
  }, [flushLocalState, stopRaf])

  const togglePlayPause = useCallback(() => {
    if (positionStore.getSnapshot().isPlaying) pause()
    else play()
  }, [pause, play])

  const setWpm = useCallback((value: number) => {
    positionStore.setWpm(clampWpm(value))
  }, [])

  const adjustWpm = useCallback((direction: number) => {
    const current = positionStore.getSnapshot().wpm
    const step = Math.max(10, Math.round(current * 0.1))
    positionStore.setWpm(clampWpm(current + (direction > 0 ? step : -step)))
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
    }
  }, [flushLocalState, stopRaf])

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
