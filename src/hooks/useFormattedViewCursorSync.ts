import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type {
  FormattedViewHandle,
  HighlightSegment,
} from '../components/FormattedView'
import { positionStore } from '../state/position/positionStore'
import type { PositionOrigin } from '../state/position/types'
import type { TocJumpTarget } from './useTocNavigation'
import { resolvePendingTocScrollTarget } from './useTocNavigation'

interface CursorTranslators {
  absoluteToArrayIndex: (absoluteSegmentIndex: number) => number | null
  arrayToAbsolute: (arrayIdx: number) => number | null
}

interface UseFormattedViewCursorSyncArgs {
  showFormattedView: boolean
  isPlaying: boolean
  readingMode: 'phrase' | 'rsvp' | 'scroll' | 'track'
  tocNavigationRevision: number
  chapterIdx: number
  absoluteSegmentIndex: number
  cursorOrigin: PositionOrigin
  cursorRevision: number
  layoutVersion: number
  segments: ReadonlyArray<HighlightSegment>
  translators: CursorTranslators
  formattedViewRef: RefObject<FormattedViewHandle | null>
  pendingTocTargetRef: RefObject<TocJumpTarget | null>
  clearPendingTocTarget: () => void
}

export function useFormattedViewCursorSync({
  showFormattedView,
  isPlaying,
  readingMode,
  tocNavigationRevision,
  chapterIdx,
  absoluteSegmentIndex,
  cursorOrigin,
  cursorRevision,
  layoutVersion,
  segments,
  translators,
  formattedViewRef,
  pendingTocTargetRef,
  clearPendingTocTarget,
}: UseFormattedViewCursorSyncArgs): void {
  const pendingScrollRef = useRef(false)
  const wasFormattedRef = useRef(false)
  const lastAutoScrolledChapterRef = useRef(-1)
  const suppressVisualHighlight =
    isPlaying && (readingMode === 'scroll' || readingMode === 'track')

  // ---- Effect 1: Highlight update -------------------------------------------
  //
  // Renders the highlight band for the current segment position. Skips
  // when origin is 'user-scroll' — during user scrolling the settle
  // callback in Effect 3 owns the highlight to avoid fighting.
  useEffect(() => {
    const handle = formattedViewRef.current
    if (!handle) return

    if (!showFormattedView) {
      handle.setHighlightForSegment(chapterIdx, -1, [])
      return
    }

    // The scroll handler (Effect 3) owns the highlight during user
    // scrolling and renders it on settle. Skip here to avoid overwriting
    // with a stale/wrong position.
    if (cursorOrigin === 'user-scroll') return

    const arrIdx = translators.absoluteToArrayIndex(absoluteSegmentIndex)
    if (segments.length === 0 || arrIdx == null) {
      handle.setHighlightForSegment(chapterIdx, -1, [])
      return
    }

    let cancelled = false
    const raf = requestAnimationFrame(() => {
      if (!cancelled) {
        handle.setHighlightForSegment(chapterIdx, arrIdx, segments, {
          suppressVisual: suppressVisualHighlight,
        })
      }
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [
    showFormattedView,
    chapterIdx,
    absoluteSegmentIndex,
    cursorRevision,
    suppressVisualHighlight,
    segments,
    translators,
    layoutVersion,
    formattedViewRef,
  ])

  // ---- Effect 2: Auto-scroll to segment ------------------------------------
  //
  // Scrolls the viewport to center the current segment when transitioning
  // into formatted view, on engine ticks, TOC clicks, chapter nav, etc.
  useEffect(() => {
    if (!showFormattedView) {
      wasFormattedRef.current = false
      pendingScrollRef.current = false
      return
    }

    const handle = formattedViewRef.current
    if (!handle) return

    const transitionedIn = !wasFormattedRef.current
    wasFormattedRef.current = true

    if (transitionedIn) pendingScrollRef.current = true
    if (cursorOrigin === 'user-scroll') {
      pendingScrollRef.current = false
      return
    }
    if (cursorOrigin !== 'engine') {
      pendingScrollRef.current = true
    }
    if (chapterIdx !== lastAutoScrolledChapterRef.current) {
      pendingScrollRef.current = true
    }
    if (!pendingScrollRef.current) return

    let cancelled = false
    let rafHandle = 0
    let attempts = 0
    const maxAttempts = 120

    const tryScroll = () => {
      if (cancelled) return
      attempts += 1
      if (!pendingScrollRef.current) return

      const arrIdx = translators.absoluteToArrayIndex(absoluteSegmentIndex)
      if (segments.length === 0 || arrIdx == null) {
        if (attempts < maxAttempts) {
          rafHandle = requestAnimationFrame(tryScroll)
        }
        return
      }

      const container = handle.getScrollContainer()
      const sectionEl = handle.getSectionEl(chapterIdx)
      if (!container || !sectionEl) {
        if (attempts < maxAttempts) {
          rafHandle = requestAnimationFrame(tryScroll)
        }
        return
      }
      if (!handle.isSectionReady(chapterIdx)) {
        if (attempts < maxAttempts) {
          rafHandle = requestAnimationFrame(tryScroll)
        }
        return
      }

      const pendingTocTarget = pendingTocTargetRef.current
      if (
        cursorOrigin === 'toc' &&
        pendingTocTarget?.sectionIndex === chapterIdx
      ) {
        const resolvedTocTarget = resolvePendingTocScrollTarget({
          handle,
          pendingTarget: pendingTocTarget,
          sectionIdx: chapterIdx,
          currentAbsoluteSegmentIndex: absoluteSegmentIndex,
          segments,
          translators,
        })

        if (resolvedTocTarget) {
          if (resolvedTocTarget.absoluteSegmentIndex != null) {
            positionStore.setPosition(
              {
                absoluteSegmentIndex: resolvedTocTarget.absoluteSegmentIndex,
                wordIndex: 0,
              },
              'toc',
            )
          }

          handle.beginProgrammaticScroll()
          const cleanupProgrammatic = () => {
            handle.endProgrammaticScroll()
            resolvedTocTarget.container.removeEventListener(
              'scrollend',
              cleanupProgrammatic as EventListener,
            )
          }

          resolvedTocTarget.container.addEventListener(
            'scrollend',
            cleanupProgrammatic as EventListener,
            { once: true },
          )
          setTimeout(cleanupProgrammatic, 600)
          resolvedTocTarget.container.scrollTo({
            top: resolvedTocTarget.scrollTop,
            behavior: 'auto',
          })
          clearPendingTocTarget()
          pendingScrollRef.current = false
          lastAutoScrolledChapterRef.current = chapterIdx
          return
        }
      }

      const info = handle.setHighlightForSegment(chapterIdx, arrIdx, segments, {
        suppressVisual: suppressVisualHighlight,
      })
      if (!info) {
        if (attempts < maxAttempts) {
          rafHandle = requestAnimationFrame(tryScroll)
        }
        return
      }

      const segCenterY = info.topPx + info.heightPx / 2
      const viewportH = container.clientHeight
      const targetScroll = segCenterY - viewportH * 0.4
      const maxScroll = Math.max(0, container.scrollHeight - viewportH)
      const clamped = Math.max(0, Math.min(targetScroll, maxScroll))

      const behavior: ScrollBehavior =
        transitionedIn ||
        cursorOrigin === 'restore' ||
        cursorOrigin === 'display-mode' ||
        cursorOrigin === 'mode-switch' ||
        cursorOrigin === 'toc' ||
        cursorOrigin === 'chapter-nav'
          ? 'auto'
          : 'smooth'

      handle.beginProgrammaticScroll()
      const cleanupProgrammatic = () => {
        handle.endProgrammaticScroll()
        container.removeEventListener(
          'scrollend',
          cleanupProgrammatic as EventListener,
        )
      }

      container.addEventListener(
        'scrollend',
        cleanupProgrammatic as EventListener,
        { once: true },
      )
      setTimeout(cleanupProgrammatic, 600)
      container.scrollTo({ top: clamped, behavior })
      pendingScrollRef.current = false
      lastAutoScrolledChapterRef.current = chapterIdx
    }

    rafHandle = requestAnimationFrame(tryScroll)
    return () => {
      cancelled = true
      if (rafHandle) cancelAnimationFrame(rafHandle)
    }
  }, [
    showFormattedView,
    tocNavigationRevision,
    chapterIdx,
    absoluteSegmentIndex,
    cursorOrigin,
    cursorRevision,
    clearPendingTocTarget,
    suppressVisualHighlight,
    segments,
    translators,
    layoutVersion,
    formattedViewRef,
    pendingTocTargetRef,
  ])

  // ---- Effect 3: Scroll-position detection ----------------------------------
  //
  // Paused-mode only. On user scroll, calls the unified
  // detectAtViewportCenter to determine both the visible section and
  // the segment at the center in one pass. After scrolling settles
  // (180ms debounce), renders the highlight band directly.
  //
  // No isActivelyScrollingRef — Effect 1 simply skips user-scroll
  // origins, so there's no ref-based coupling between effects.
  useEffect(() => {
    if (!showFormattedView || isPlaying) return

    const handle = formattedViewRef.current
    if (!handle) return

    const container = handle.getScrollContainer()
    if (!container) return

    let rafScheduled = false
    let settleTimer: ReturnType<typeof setTimeout> | null = null

    const detectAndUpdate = () => {
      if (handle.isProgrammaticScrollActive()) return

      const result = handle.detectAtViewportCenter(chapterIdx, segments)
      if (!result) return

      // Cross-section scroll: skip segment update — the IO will
      // handle the chapter change, segments will reload, and this
      // effect will re-run with the new chapterIdx.
      if (result.sectionIdx !== chapterIdx) return

      if (result.arrIdx == null) return
      const abs = translators.arrayToAbsolute(result.arrIdx)
      if (
        abs == null ||
        abs === positionStore.getSnapshot().absoluteSegmentIndex
      ) {
        return
      }

      positionStore.setPosition(
        { absoluteSegmentIndex: abs, wordIndex: 0 },
        'user-scroll',
      )
    }

    const onScroll = () => {
      if (handle.isProgrammaticScrollActive() || rafScheduled) return

      // Debounce: schedule highlight render after scrolling settles.
      if (settleTimer != null) clearTimeout(settleTimer)
      settleTimer = setTimeout(() => {
        settleTimer = null
        const arrIdx = translators.absoluteToArrayIndex(
          positionStore.getSnapshot().absoluteSegmentIndex,
        )
        if (arrIdx != null && segments.length > 0) {
          handle.setHighlightForSegment(chapterIdx, arrIdx, segments, {
            suppressVisual: suppressVisualHighlight,
          })
        }
      }, 180)

      rafScheduled = true
      requestAnimationFrame(() => {
        rafScheduled = false
        detectAndUpdate()
      })
    }

    container.addEventListener('scroll', onScroll, { passive: true })

    // Run detection immediately on mount. Handles the case where the
    // IntersectionObserver updated chapterIdx after a cross-section
    // scroll — by the time this effect re-runs with the new chapterIdx,
    // no further scroll events fire, so we must detect once now.
    requestAnimationFrame(detectAndUpdate)

    return () => {
      container.removeEventListener('scroll', onScroll)
      if (settleTimer != null) clearTimeout(settleTimer)
    }
  }, [
    showFormattedView,
    isPlaying,
    chapterIdx,
    segments,
    translators,
    suppressVisualHighlight,
    formattedViewRef,
  ])
}
