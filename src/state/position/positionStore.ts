/* ------------------------------------------------------------------ */
/*  positionStore — module-scope, no React                             */
/* ------------------------------------------------------------------ */
//
// THE single source of truth for "where the reader is" and "what
// playback is doing". Replaces:
//   - src/state/cursor/reducer.ts (CursorRootState + cursorReducer)
//   - src/state/cursor/CursorContext.tsx (Provider + 3 contexts)
//   - src/state/cursor/RestoreCoordinator.ts (4-phase state machine)
//
// Design rules (enforced structurally, not by convention):
//
//   1. Position lives in EXACTLY ONE place — this module's `state`
//      variable. Engines do not own currentIndex/currentIndexRef.
//   2. Position never changes except through the setters below.
//      ENGINE_TICK / USER_SCROLL / USER_SEEK / MODE_SWITCH / TOC_JUMP /
//      CHAPTER_NAV all collapse to direct method calls.
//   3. The controller reads/writes through `getSnapshot()` and
//      `setPosition()`. Subscribers (React components) read via the
//      `usePositionSelector` hook in this file, which is a thin
//      `useSyncExternalStore` wrapper.
//   4. RSVP word index lives on the store too. The controller keeps
//      a private wordIndexRef for the rAF hot path (12 Hz) and flushes
//      to the store on segment-boundary, on pause, on visibility-hidden,
//      and on unmount. This is the ONE intra-segment value that
//      legitimately churns; the saver doesn't subscribe to wordIndex
//      changes (uses a key-equality check inside the saver).
//
// Origin field is used for: (a) the saver's restore gate, (b) the
// formatted-view scroll-into-view effect's "skip during user scroll"
// guard. It is NOT used for breaking feedback loops — there are no
// feedback loops because there is no second copy of position.

import { useSyncExternalStore } from 'react'
import { createSelector } from '../createSelector'
import {
  initialPositionState,
  type PositionOrigin,
  type PositionState,
  type DisplayMode,
} from './types'
import type { ReadingMode } from '../../types'

type Listener = () => void

let state: PositionState = initialPositionState
const listeners = new Set<Listener>()

function emit(): void {
  listeners.forEach((l) => l())
}

function commit(patch: Partial<PositionState>, origin: PositionOrigin): void {
  state = {
    ...state,
    ...patch,
    origin,
    revision: state.revision + 1,
  }
  emit()
}

/** Bump revision + emit without changing origin. Used by setters (wpm,
 *  isPlaying) that shouldn't trigger origin-dependent effects. */
function commitSilent(patch: Partial<PositionState>): void {
  state = { ...state, ...patch, revision: state.revision + 1 }
  emit()
}

/* ------------------------------------------------------------------ */
/*  Public store API                                                   */
/* ------------------------------------------------------------------ */

/* eslint-disable @typescript-eslint/no-explicit-any */
// Diagnostic hook: expose the store on window in dev so headless tests
// can read cursor state without subscribing to React. Stripped by Vite
// in production builds via tree-shaking on `import.meta.env.DEV`.
if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) {
  ;(window as any).__positionStore = {
    snapshot: () => state,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const positionStore = {
  /** Stable getter for useSyncExternalStore. */
  getSnapshot(): PositionState {
    return state
  },

  /** Subscribe to commits. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  /** One-shot initializer called from ReaderViewport's loader before
   *  the active reader mounts. Bypasses the revision counter so the
   *  saver gate (revision > 0) does not fire on the very first render. */
  init(seed: Partial<PositionState>): void {
    state = {
      ...initialPositionState,
      ...seed,
      origin: 'restore',
      revision: 0,
    }
    emit()
  },

  /**
   * Single position writer. Every position change goes through here.
   * Skips the commit + emit if the patch matches state — this lets
   * the controller call setPosition unconditionally on every tick that
   * reaches a segment boundary without thrashing subscribers when the
   * value didn't actually change.
   */
  setPosition(
    patch: Pick<PositionState, 'absoluteSegmentIndex'> &
      Partial<Pick<PositionState, 'wordIndex' | 'chapterId' | 'chapterIdx' | 'scrollTop'>>,
    origin: PositionOrigin,
  ): void {
    const nextWord = patch.wordIndex ?? state.wordIndex
    const nextChapId = patch.chapterId ?? state.chapterId
    const nextChapIdx = patch.chapterIdx ?? state.chapterIdx
    const nextScrollTop = patch.scrollTop ?? state.scrollTop
    if (
      state.absoluteSegmentIndex === patch.absoluteSegmentIndex &&
      state.wordIndex === nextWord &&
      state.chapterId === nextChapId &&
      state.chapterIdx === nextChapIdx &&
      state.origin === origin
    ) {
      return
    }
    commit(
      {
        absoluteSegmentIndex: patch.absoluteSegmentIndex,
        wordIndex: nextWord,
        chapterId: nextChapId,
        chapterIdx: nextChapIdx,
        scrollTop: nextScrollTop,
      },
      origin,
    )
  },

  setMode(mode: ReadingMode): void {
    if (state.mode === mode) return
    commit({ mode }, 'mode-switch')
  },

  setDisplayMode(displayMode: DisplayMode): void {
    if (state.displayMode === displayMode) return
    commit({ displayMode }, 'display-mode')
  },

  setWpm(wpm: number): void {
    if (state.wpm === wpm) return
    commitSilent({ wpm })
  },

  setPlaying(isPlaying: boolean): void {
    if (state.isPlaying === isPlaying) return
    commitSilent({ isPlaying })
  },
}

/* ------------------------------------------------------------------ */
/*  React subscription hook                                            */
/* ------------------------------------------------------------------ */

/** Subscribe to a slice of the store with equality short-circuiting.
 *  Returns the same reference across renders when the selected slice
 *  is shallowly equal, so consumers can put it directly in effect deps. */
export const usePositionSelector = createSelector(positionStore)

/** Convenience hook for the full state. Re-renders on every commit. */
export function usePositionState(): PositionState {
  return useSyncExternalStore(
    positionStore.subscribe,
    positionStore.getSnapshot,
    positionStore.getSnapshot,
  )
}
