import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Chapter } from '../api/client'
import type {
  FormattedViewHandle,
  HighlightSegment,
} from '../components/FormattedView'
import { positionStore } from '../state/position/positionStore'

export interface TocJumpTarget {
  sectionIndex: number
  htmlAnchor?: string | null
}

interface TocTranslator {
  arrayToAbsolute: (arrIdx: number) => number | null
}

interface PlaybackControllerLike {
  pause: () => void
}

interface UseTocNavigationArgs {
  chapters: Chapter[]
  controller: PlaybackControllerLike
  chapterIdx: number
  absoluteSegmentIndex: number
  layoutVersion: number
  segments: ReadonlyArray<HighlightSegment>
  translators: TocTranslator
  formattedViewRef: RefObject<FormattedViewHandle | null>
}

export interface ResolvedTocScrollTarget {
  container: HTMLDivElement
  scrollTop: number
  absoluteSegmentIndex: number | null
}

export function resolvePendingTocScrollTarget(args: {
  handle: FormattedViewHandle
  pendingTarget: TocJumpTarget
  sectionIdx: number
  currentAbsoluteSegmentIndex: number
  segments: ReadonlyArray<HighlightSegment>
  translators: TocTranslator
}): ResolvedTocScrollTarget | null {
  const { handle, pendingTarget, sectionIdx, currentAbsoluteSegmentIndex, segments, translators } = args
  const container = handle.getScrollContainer()
  if (!container) return null

  const resolved = handle.resolveTocTarget(
    sectionIdx,
    pendingTarget.htmlAnchor,
    segments,
  )
  if (!resolved) return null

  const viewportH = container.clientHeight
  const targetScroll = resolved.topPx - viewportH * 0.2
  const maxScroll = Math.max(0, container.scrollHeight - viewportH)
  const scrollTop = Math.max(0, Math.min(targetScroll, maxScroll))
  const absoluteSegmentIndex =
    resolved.arrIdx == null ? null : translators.arrayToAbsolute(resolved.arrIdx)

  return {
    container,
    scrollTop,
    absoluteSegmentIndex:
      absoluteSegmentIndex == null || absoluteSegmentIndex === currentAbsoluteSegmentIndex
        ? null
        : absoluteSegmentIndex,
  }
}

export function useTocNavigation({
  chapters,
  controller,
  chapterIdx,
  absoluteSegmentIndex,
  layoutVersion,
  segments,
  translators,
  formattedViewRef,
}: UseTocNavigationArgs) {
  const pendingTocTargetRef = useRef<TocJumpTarget | null>(null)
  const [navigationRevision, setNavigationRevision] = useState(0)

  const clearPendingTocTarget = useCallback(() => {
    pendingTocTargetRef.current = null
  }, [])

  const navigateToSection = useCallback((idx: number, htmlAnchor?: string | null) => {
    if (idx < 0 || idx >= chapters.length) return
    controller.pause()
    pendingTocTargetRef.current = {
      sectionIndex: idx,
      htmlAnchor: htmlAnchor?.trim() ? htmlAnchor : null,
    }
    setNavigationRevision((value) => value + 1)
    positionStore.setPosition(
      {
        chapterId: chapters[idx].id,
        chapterIdx: idx,
        absoluteSegmentIndex: 0,
        wordIndex: 0,
      },
      'toc',
    )
  }, [chapters, controller])

  useEffect(() => {
    const pending = pendingTocTargetRef.current
    if (!pending) return
    if (pending.sectionIndex !== chapterIdx) return
    if (!pending.htmlAnchor) return

    const handle = formattedViewRef.current
    if (!handle?.isSectionReady(chapterIdx)) return
    if (segments.length === 0) return

    const target = handle.resolveTocTarget(
      chapterIdx,
      pending.htmlAnchor,
      segments,
    )
    if (!target) return

    if (target.arrIdx == null) return

    const absolute = translators.arrayToAbsolute(target.arrIdx)
    if (absolute == null || absolute === absoluteSegmentIndex) return

    positionStore.setPosition(
      {
        chapterId: chapters[chapterIdx].id,
        chapterIdx,
        absoluteSegmentIndex: absolute,
        wordIndex: 0,
      },
      'toc',
    )
  }, [
    absoluteSegmentIndex,
    chapterIdx,
    chapters,
    formattedViewRef,
    layoutVersion,
    segments,
    translators,
  ])

  return {
    navigateToSection,
    pendingTocTargetRef,
    clearPendingTocTarget,
    navigationRevision,
  }
}
