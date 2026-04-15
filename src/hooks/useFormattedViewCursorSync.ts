import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import {
  REFERENCE_LINE_RATIO,
  type FormattedViewHandle,
  type HighlightSegment,
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
  tocNavigationRevision: number
  chapterIdx: number
  absoluteSegmentIndex: number
  cursorOrigin: PositionOrigin
  layoutVersion: number
  segments: ReadonlyArray<HighlightSegment>
  translators: CursorTranslators
  formattedViewRef: RefObject<FormattedViewHandle | null>
  pendingTocTargetRef: RefObject<TocJumpTarget | null>
  clearPendingTocTarget: () => void
  /** Called when the PIP detects it's in a different section than
   *  chapterIdx. This makes the PIP the source of truth for which
   *  chapter the user is reading, rather than the IntersectionObserver
   *  (which uses the top of the viewport, not the reading position). */
  onPipSectionChange: (sectionIdx: number) => void
  /** Fired when the restore-direct scroll path enters/leaves its
   *  waiting state. Parents can surface this via a data-attribute for
   *  playwright assertions. 'pending' when tryScroll starts on a
   *  restore with a saved scrollTop; 'done' when the restore scroll
   *  has been committed; 'degraded' when the prior-sections-ready
   *  budget is exhausted and the code falls back to segment-center. */
  onRestoreStateChange?: (state: 'pending' | 'done' | 'degraded') => void
}

export function useFormattedViewCursorSync({
  showFormattedView,
  isPlaying,
  tocNavigationRevision,
  chapterIdx,
  absoluteSegmentIndex,
  cursorOrigin,
  layoutVersion,
  segments,
  translators,
  formattedViewRef,
  pendingTocTargetRef,
  clearPendingTocTarget,
  onPipSectionChange,
  onRestoreStateChange,
}: UseFormattedViewCursorSyncArgs): void {
  const pendingScrollRef = useRef(false)
  const wasFormattedRef = useRef(false)
  const lastAutoScrolledChapterRef = useRef(-1)
  const onPipSectionChangeRef = useRef(onPipSectionChange)
  onPipSectionChangeRef.current = onPipSectionChange
  const onRestoreStateChangeRef = useRef(onRestoreStateChange)
  onRestoreStateChangeRef.current = onRestoreStateChange

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
    // Mode switch doesn't change the position — skip the auto-scroll
    // when the formatted view was already visible. Without this guard,
    // the programmatic scroll re-centers the segment block, shifting the
    // viewport away from the line the pip was pointing at. The next
    // play() then detects a different segment than the pip showed.
    if (cursorOrigin === 'mode-switch' && !transitionedIn) {
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
    // Wider budget for the restore-direct path: priors-ready can take
    // up to several seconds on a large book when the deferred innerHTML
    // writes flush four sections per 16 ms tick, plus image decode time
    // for illustrated books (Alice etc).
    const restoreMaxAttempts = 240
    const isRestoreDirect =
      cursorOrigin === 'restore' && positionStore.getSnapshot().scrollTop > 0
    const effectiveMaxAttempts = isRestoreDirect ? restoreMaxAttempts : maxAttempts
    let restoreFallback = false
    let didAnnouncePending = false
    // For restore-direct: once all prior sections are ready (innerHTML
    // written), we kick off an async settle of every prior's images so
    // their decoded heights land before we read sectionEl.offsetTop.
    // The flag prevents re-kicking on subsequent rAFs.
    let restorePriorsSettling = false
    let restorePriorsSettled = false
    // Guard: sectionEl.offsetTop must be stable for N consecutive frames
    // before we commit the scroll. Images decode over several rAFs and
    // the write-effect's deferred batches touch later sections mid-flight,
    // so a single "ready" frame isn't enough.
    let lastObservedOffsetTop = -1
    let offsetStableFrames = 0
    const OFFSET_STABLE_THRESHOLD = 4

    const tryScroll = () => {
      if (cancelled) return
      attempts += 1
      if (!pendingScrollRef.current) return

      const container = handle.getScrollContainer()
      const sectionEl = handle.getSectionEl(chapterIdx)
      if (!container || !sectionEl) {
        if (attempts < effectiveMaxAttempts) {
          rafHandle = requestAnimationFrame(tryScroll)
        }
        return
      }
      if (!handle.isSectionReady(chapterIdx)) {
        if (attempts < effectiveMaxAttempts) {
          rafHandle = requestAnimationFrame(tryScroll)
        }
        return
      }

      const arrIdx = translators.absoluteToArrayIndex(absoluteSegmentIndex)
      // For restore with saved scrollTop, we can scroll immediately
      // without waiting for segments to load. For all other cases,
      // wait for segments so we can compute the scroll target.
      const snapForCheck = positionStore.getSnapshot()
      const canRestoreDirect = cursorOrigin === 'restore' && snapForCheck.scrollTop > 0
      if (!canRestoreDirect && (segments.length === 0 || arrIdx == null)) {
        if (attempts < effectiveMaxAttempts) {
          rafHandle = requestAnimationFrame(tryScroll)
        }
        return
      }

      // Announce 'pending' once we've cleared the cheap gates. Doing
      // it here (instead of at rAF-0) keeps the data-attribute stable
      // across very-early aborts where nothing useful happened.
      if (canRestoreDirect && !didAnnouncePending) {
        didAnnouncePending = true
        onRestoreStateChangeRef.current?.('pending')
      }

      // Restore-direct requires all prior sections to have been written
      // AND their images to have decoded so `sectionEl.offsetTop`
      // matches its save-time value. Without this, deferred batches
      // leave the target section with a too-small offsetTop and the
      // viewport lands 1500+ pixels short.
      if (canRestoreDirect && !restoreFallback) {
        const priorsReady = handle.areSectionsReadyThrough(chapterIdx - 1)
        if (!priorsReady) {
          if (attempts < effectiveMaxAttempts) {
            rafHandle = requestAnimationFrame(tryScroll)
            return
          }
          restoreFallback = true
          console.warn(
            '[cursorSync] restore-direct priors-ready budget exhausted; falling back to segment-center',
            {
              chapterIdx,
              attempts,
              scrollTop: positionStore.getSnapshot().scrollTop,
            },
          )
          onRestoreStateChangeRef.current?.('degraded')
        } else {
          // Kick off the async image-decode settle for every prior
          // section, exactly once. While it runs we keep polling
          // offsetTop stability — many images will have already been
          // `complete` so this settles fast in practice.
          if (!restorePriorsSettling) {
            restorePriorsSettling = true
            void (async () => {
              for (let i = 0; i <= chapterIdx; i += 1) {
                try {
                  await handle.settleImages(i)
                } catch {
                  /* swallow */
                }
              }
              restorePriorsSettled = true
            })()
          }
          // Require offsetTop to be stable for several consecutive
          // frames — this catches the tail end of image-decode reflow
          // even when areSectionsReadyThrough already returns true.
          const currentOffsetTop = sectionEl.offsetTop
          if (currentOffsetTop === lastObservedOffsetTop) {
            offsetStableFrames += 1
          } else {
            lastObservedOffsetTop = currentOffsetTop
            offsetStableFrames = 0
          }
          const readyToCommit = restorePriorsSettled && offsetStableFrames >= OFFSET_STABLE_THRESHOLD
          if (!readyToCommit) {
            if (attempts < effectiveMaxAttempts) {
              rafHandle = requestAnimationFrame(tryScroll)
              return
            }
            restoreFallback = true
            console.warn(
              '[cursorSync] restore-direct stability budget exhausted; falling back to segment-center',
              {
                chapterIdx,
                attempts,
                offsetTop: currentOffsetTop,
                settled: restorePriorsSettled,
                scrollTop: positionStore.getSnapshot().scrollTop,
              },
            )
            onRestoreStateChangeRef.current?.('degraded')
          }
        }
        // If we just fell through to fallback, ensure the segment-
        // center branch has segments; otherwise keep retrying.
        if (restoreFallback && (segments.length === 0 || arrIdx == null)) {
          if (attempts < effectiveMaxAttempts + 60) {
            rafHandle = requestAnimationFrame(tryScroll)
          }
          return
        }
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
            // Intentionally bypasses the useNavigateToPosition seam:
            // routing this through navigateToPosition would call
            // beginProgrammaticNavigation() again, bumping nav-gen and
            // creating a feedback loop where this effect would re-run,
            // its own tryScroll rAF would see the fresh nav-gen and the
            // scroll about to be issued below would be cancelled. We're
            // already inside the scroll path for this nav — just refine
            // the committed position in place.
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

      // On restore, use the saved scrollTop directly instead of computing
      // from the segment center. This preserves the exact pip position
      // because it's the same scrollTop that was saved when the pip was
      // at the reference line. Segment-center calculation is lossy for
      // multi-line segments and causes pip drift on exit/re-enter.
      const snap = positionStore.getSnapshot()
      let clamped: number

      if (cursorOrigin === 'restore' && snap.scrollTop > 0 && !restoreFallback) {
        // scrollTop is saved as an offset relative to the section's top
        // so it's immune to layout changes in other sections. Convert
        // back to an absolute scrollTop by adding the section's current
        // offsetTop.
        const sectionTop = sectionEl.offsetTop
        const absoluteTarget = sectionTop + snap.scrollTop
        const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
        clamped = Math.max(0, Math.min(absoluteTarget, maxScroll))
      } else {
        const info = arrIdx != null
          ? handle.setHighlightForSegment(chapterIdx, arrIdx, segments)
          : null
        if (!info) {
          if (attempts < effectiveMaxAttempts) {
            rafHandle = requestAnimationFrame(tryScroll)
          }
          return
        }

        const segCenterY = info.topPx + info.heightPx / 2
        const viewportH = container.clientHeight
        const targetScroll = segCenterY - viewportH * REFERENCE_LINE_RATIO
        const maxScroll = Math.max(0, container.scrollHeight - viewportH)
        clamped = Math.max(0, Math.min(targetScroll, maxScroll))
      }

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
      if (cursorOrigin === 'restore') {
        // 'done' covers both the restore-direct path and the segment-
        // center fallback once it actually scrolls. 'degraded' is
        // announced above at the moment the fallback is chosen; the
        // terminal state after a degraded commit is still 'done'
        // (the restore finished, just with reduced fidelity).
        onRestoreStateChangeRef.current?.(restoreFallback ? 'degraded' : 'done')
      }
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
    clearPendingTocTarget,
    segments,
    translators,
    layoutVersion,
    formattedViewRef,
    pendingTocTargetRef,
  ])

  // ---- Effect 3: Scroll-position detection ----------------------------------
  //
  // Paused-mode only. On user scroll, detects the segment at viewport
  // center and updates the position store.
  useEffect(() => {
    if (!showFormattedView || isPlaying) return

    const handle = formattedViewRef.current
    if (!handle) return

    const container = handle.getScrollContainer()
    if (!container) return

    const detectAndUpdate = () => {
      if (handle.isProgrammaticScrollActive()) return

      const result = handle.detectAtViewportCenter(chapterIdx, segments)
      if (!result) return

      // Cross-section scroll: the PIP is in a different section than
      // chapterIdx. Drive the chapter change from here so the header
      // and TOC update to match where the PIP is, rather than waiting
      // for the IntersectionObserver (which uses the viewport top, not
      // the reading position at the 40% reference line).
      if (result.sectionIdx !== chapterIdx) {
        onPipSectionChangeRef.current(result.sectionIdx)
        return
      }

      if (result.arrIdx == null) return
      const abs = translators.arrayToAbsolute(result.arrIdx)
      if (abs == null) return

      // Always include scrollTop so the saved position can restore to
      // the exact pip location, not the segment center.
      const currentScrollTop = container.scrollTop
      const snap = positionStore.getSnapshot()
      if (
        abs === snap.absoluteSegmentIndex &&
        snap.origin === 'user-scroll'
      ) {
        // Same segment but scroll position may have changed (scrolled
        // within a multi-line segment). Update scrollTop silently.
        if (Math.abs(currentScrollTop - snap.scrollTop) > 2) {
          positionStore.setPosition(
            { absoluteSegmentIndex: abs, wordIndex: 0, scrollTop: currentScrollTop },
            'user-scroll',
          )
        }
        return
      }

      positionStore.setPosition(
        { absoluteSegmentIndex: abs, wordIndex: 0, scrollTop: currentScrollTop },
        'user-scroll',
      )
    }

    // Subscribe to the shared ScrollDriver instead of attaching our own
    // scroll listener. The driver owns one passive listener + rAF
    // throttle + FrameRectCache per view, and invokes subscribers with
    // a ScrollSource tag. Skip frames tagged 'engine' / 'programmatic' /
    // 'restore' — those aren't user-initiated and shouldn't overwrite
    // the store cursor.
    const unsubDriver = handle.subscribeToScroll('cursor-sync', (frame) => {
      if (frame.source !== 'user') return
      if (handle.isProgrammaticScrollActive()) return
      detectAndUpdate()
    })

    // After scroll settles, always update scrollTop to the final value.
    // The rAF-throttled subscriber may miss the final position if the
    // last wheel event's rAF captured an intermediate scrollTop.
    const onScrollEnd = () => {
      if (handle.isProgrammaticScrollActive()) return
      const snap = positionStore.getSnapshot()
      if (snap.origin === 'restore') return
      const finalScrollTop = container.scrollTop
      if (Math.abs(finalScrollTop - snap.scrollTop) > 2) {
        positionStore.setPosition(
          { absoluteSegmentIndex: snap.absoluteSegmentIndex, scrollTop: finalScrollTop },
          snap.origin === 'engine' ? 'engine' : 'user-scroll',
        )
      }
    }

    container.addEventListener('scrollend', onScrollEnd, { passive: true })

    // Run detection immediately on mount. Handles the case where the
    // IntersectionObserver updated chapterIdx after a cross-section
    // scroll — by the time this effect re-runs with the new chapterIdx,
    // no further scroll events fire, so we must detect once now.
    //
    // Two guards:
    //   (a) origin === 'restore' — Effect 2 is about to scroll to the
    //       saved position, but the init-effect's updatePipPosition()
    //       already populated pipBlockRef from scrollTop=0 (pointing at
    //       chapter 0). Detecting now would see sectionIdx=0 != the
    //       restored chapterIdx and call onPipSectionChange(0), which
    //       commits chapter 0 via 'user-scroll' and silently reverts the
    //       restore. Nav-gen guard (below) does NOT cover this because
    //       restore never calls beginProgrammaticNavigation().
    //   (b) nav-gen changed between effect mount and rAF firing — covers
    //       deliberate programmatic navigation (TOC, chapter-nav,
    //       bookmark, user-seek, or an out-of-band currentSectionIndex
    //       change) where Effect 2 is authoritative for where we're
    //       going.
    if (positionStore.getSnapshot().origin !== 'restore') {
      const navGenAtMount = formattedViewRef.current?.getNavigationGeneration() ?? 0
      requestAnimationFrame(() => {
        if (formattedViewRef.current?.getNavigationGeneration() !== navGenAtMount) return
        if (handle.isProgrammaticScrollActive()) return
        detectAndUpdate()
      })
    }

    return () => {
      unsubDriver()
      container.removeEventListener('scrollend', onScrollEnd)
    }
  }, [
    showFormattedView,
    isPlaying,
    chapterIdx,
    segments,
    translators,
    formattedViewRef,
  ])
}
