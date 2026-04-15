import { useCallback } from 'react'
import type { RefObject } from 'react'
import type { Chapter } from '../api/client'
import type { FormattedViewHandle } from '../components/FormattedView'
import { positionStore } from '../state/position/positionStore'
import type { TocJumpTarget } from './useTocNavigation'

/**
 * Origins that represent programmatic, deliberate navigation to a specific
 * position (as opposed to 'user-scroll' / 'engine' which track continuous
 * motion). All six used to be independent call-sites that each did some
 * subset of: pause, set pendingTocTargetRef, bump navigationRevision, commit
 * the position, and (sometimes) forget to reset the stale pip block. This
 * hook consolidates them.
 */
export type ProgrammaticOrigin =
  | 'toc'
  | 'chapter-nav'
  | 'bookmark'
  | 'user-seek'
  | 'restore'

export interface NavigateTarget {
  chapterIdx: number
  /** Defaults to 0. */
  absoluteSegmentIndex?: number
  /** Defaults to 0. */
  wordIndex?: number
  /** If present, stashed into pendingTocTargetRef so Effect 2 can resolve
   *  the exact scroll target (sub-chapter anchor) once the DOM is ready. */
  htmlAnchor?: string | null
  origin: ProgrammaticOrigin
  /** Defaults to true. */
  pauseEngine?: boolean
  /** Defaults to true. When we're already in the target chapter and no
   *  htmlAnchor needs resolving, take the fast path through the playback
   *  controller instead of committing a full chapter-change. */
  sameChapterFastPath?: boolean
}

interface PlaybackControllerLike {
  pause: () => void
  seekToAbs: (absoluteSegmentIndex: number, wordIndex?: number) => void
}

interface UseNavigateToPositionArgs {
  chapters: Chapter[]
  controller: PlaybackControllerLike
  formattedViewRef: RefObject<FormattedViewHandle | null>
  pendingTocTargetRef: RefObject<TocJumpTarget | null>
  bumpNavigationRevision: () => void
}

export function useNavigateToPosition({
  chapters,
  controller,
  formattedViewRef,
  pendingTocTargetRef,
  bumpNavigationRevision,
}: UseNavigateToPositionArgs) {
  const navigateToPosition = useCallback(
    (target: NavigateTarget) => {
      const {
        chapterIdx,
        absoluteSegmentIndex = 0,
        wordIndex = 0,
        htmlAnchor = null,
        origin,
        pauseEngine = true,
        sameChapterFastPath = true,
      } = target

      if (chapterIdx < 0 || chapterIdx >= chapters.length) return

      if (pauseEngine) controller.pause()

      const snap = positionStore.getSnapshot()
      const trimmedAnchor = htmlAnchor?.trim() ? htmlAnchor : null

      if (
        sameChapterFastPath &&
        chapterIdx === snap.chapterIdx &&
        !trimmedAnchor
      ) {
        controller.seekToAbs(absoluteSegmentIndex, wordIndex)
        return
      }

      // Stash the pending target for Effect 2 to resolve when the section
      // is ready. Only populate when we actually need it — for a plain
      // chapter jump Effect 2 already knows what to do from the committed
      // position. For 'toc' we always set it so the sub-anchor resolver
      // has a record even if the anchor is null (matches the prior
      // useTocNavigation behavior).
      if (trimmedAnchor || origin === 'toc') {
        pendingTocTargetRef.current = {
          sectionIndex: chapterIdx,
          htmlAnchor: trimmedAnchor,
        }
      } else {
        pendingTocTargetRef.current = null
      }

      // Structural guard against stale pip reads: bump the navigation
      // generation so Effect 3's on-mount rAF can detect that navigation
      // happened between effect mount and the rAF firing, and abort its
      // auto-detect. Also nulls pipBlockRef so detectAtViewportCenter
      // refuses to match until the next real scroll frame.
      formattedViewRef.current?.beginProgrammaticNavigation()

      positionStore.setPosition(
        {
          chapterId: chapters[chapterIdx].id,
          chapterIdx,
          absoluteSegmentIndex,
          wordIndex,
        },
        origin,
      )

      bumpNavigationRevision()
    },
    [chapters, controller, formattedViewRef, pendingTocTargetRef, bumpNavigationRevision],
  )

  return { navigateToPosition }
}
