import { useCallback, useRef, useState } from 'react'
import type {
  FormattedViewHandle,
  HighlightSegment,
} from '../components/FormattedView'

export interface TocJumpTarget {
  sectionIndex: number
  htmlAnchor?: string | null
}

interface TocTranslator {
  arrayToAbsolute: (arrIdx: number) => number | null
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

/**
 * Owns the small pieces of TOC/navigation state that Effect 2 in
 * useFormattedViewCursorSync consumes: the pending target for sub-chapter
 * anchor resolution, and a revision counter to re-trigger the scroll
 * effect even when the committed position is unchanged (same-chapter TOC
 * re-click).
 *
 * The actual navigate action lives in useNavigateToPosition — this hook
 * used to own it too, which is why the sub-anchor re-commit effect lived
 * here. That effect has moved into Effect 2 (which already resolves
 * pending TOC targets via resolvePendingTocScrollTarget), and the
 * navigation action has moved to useNavigateToPosition so all six
 * programmatic origins share one code path.
 */
export function useTocNavigation() {
  const pendingTocTargetRef = useRef<TocJumpTarget | null>(null)
  const [navigationRevision, setNavigationRevision] = useState(0)

  const clearPendingTocTarget = useCallback(() => {
    pendingTocTargetRef.current = null
  }, [])

  const bumpNavigationRevision = useCallback(() => {
    setNavigationRevision((value) => value + 1)
  }, [])

  return {
    pendingTocTargetRef,
    clearPendingTocTarget,
    navigationRevision,
    bumpNavigationRevision,
  }
}
