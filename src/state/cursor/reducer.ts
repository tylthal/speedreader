/* ------------------------------------------------------------------ */
/*  Cursor reducer                                                     */
/* ------------------------------------------------------------------ */
//
// Pure reducer for the cursor + restore state machine. All transitions
// live here so the unit tests can hit every branch without spinning up
// React. Engines, RestoreCoordinator, and ReaderViewport all dispatch
// into this reducer; nobody mutates state directly.

import type {
  Cursor,
  CursorOrigin,
  CursorRootState,
  RestoreState,
  RestoreTarget,
} from './types'
import { initialCursorRootState } from './types'

/* ------------------------------------------------------------------ */
/*  Action types                                                       */
/* ------------------------------------------------------------------ */

export type CursorAction =
  /* ---- restore lifecycle ---- */
  | { type: 'RESTORE_BEGIN' }
  | {
      type: 'RESTORE_LOADED'
      payload: {
        target: RestoreTarget
        source: NonNullable<RestoreState['source']>
      }
    }
  | { type: 'RESTORE_NONE' }
  | { type: 'RESTORE_APPLIED' }
  | { type: 'RESTORE_FAILED'; payload: { error: string } }
  | { type: 'GO_LIVE' }
  /* ---- cursor publishers ---- */
  | {
      type: 'ENGINE_TICK'
      payload: { absoluteSegmentIndex: number; wordIndex?: number }
    }
  | { type: 'USER_SCROLL'; payload: { absoluteSegmentIndex: number } }
  | {
      type: 'USER_SEEK'
      payload: { absoluteSegmentIndex: number; wordIndex?: number }
    }
  | { type: 'MODE_SWITCH' }
  | {
      type: 'TOC_JUMP'
      payload: {
        chapterId: number
        chapterIdx: number
        absoluteSegmentIndex: number
      }
    }
  | {
      type: 'CHAPTER_NAV'
      payload: {
        chapterId: number
        chapterIdx: number
        /** When true (default), reset segment + word to 0. */
        reset?: boolean
        absoluteSegmentIndex?: number
      }
    }

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function commit(
  state: CursorRootState,
  patch: Partial<Cursor>,
  origin: CursorOrigin,
): CursorRootState {
  const next: Cursor = {
    ...state.cursor,
    ...patch,
    origin,
    revision: state.cursor.revision + 1,
  }
  return { ...state, cursor: next }
}

function noopIfSame(
  state: CursorRootState,
  abs: number,
  word: number,
): boolean {
  return (
    state.cursor.absoluteSegmentIndex === abs &&
    state.cursor.wordIndex === word
  )
}

/* ------------------------------------------------------------------ */
/*  Reducer                                                            */
/* ------------------------------------------------------------------ */

export function cursorReducer(
  state: CursorRootState,
  action: CursorAction,
): CursorRootState {
  switch (action.type) {
    /* ---- restore ---- */
    case 'RESTORE_BEGIN': {
      // Idempotent — re-entering loading from anywhere is allowed only
      // if we are not already live. Coordinator only fires this once.
      if (state.restore.status !== 'idle') return state
      return {
        ...state,
        restore: {
          status: 'loading',
          target: null,
          source: null,
          error: null,
        },
      }
    }
    case 'RESTORE_LOADED': {
      if (state.restore.status !== 'loading') return state
      const { target, source } = action.payload
      return {
        ...state,
        cursor: {
          ...state.cursor,
          chapterId: target.chapterId,
          chapterIdx: target.chapterIdx,
          absoluteSegmentIndex: target.absoluteSegmentIndex,
          wordIndex: target.wordIndex,
          origin: 'restore',
          revision: state.cursor.revision + 1,
        },
        restore: {
          status: 'pending',
          target,
          source,
          error: null,
        },
      }
    }
    case 'RESTORE_NONE': {
      // No saved progress — go straight to live so saver can flip on.
      if (state.restore.status !== 'loading') return state
      return {
        ...state,
        restore: {
          status: 'live',
          target: null,
          source: 'none',
          error: null,
        },
      }
    }
    case 'RESTORE_APPLIED': {
      if (state.restore.status !== 'pending') return state
      return {
        ...state,
        restore: { ...state.restore, status: 'applied' },
      }
    }
    case 'RESTORE_FAILED': {
      // Treat failure as "start at zero, go live" rather than blocking
      // the user. Saver flips on, error is surfaced for diagnostics.
      return {
        ...state,
        restore: {
          status: 'live',
          target: null,
          source: state.restore.source,
          error: action.payload.error,
        },
      }
    }
    case 'GO_LIVE': {
      if (state.restore.status === 'live') return state
      return {
        ...state,
        restore: { ...state.restore, status: 'live' },
      }
    }

    /* ---- engine ticks ---- */
    case 'ENGINE_TICK': {
      // Suppress until live so the saver can't see pre-restore positions.
      if (state.restore.status !== 'live') return state
      const word = action.payload.wordIndex ?? 0
      if (noopIfSame(state, action.payload.absoluteSegmentIndex, word)) {
        return state
      }
      return commit(
        state,
        {
          absoluteSegmentIndex: action.payload.absoluteSegmentIndex,
          wordIndex: word,
        },
        'engine',
      )
    }

    /* ---- user inputs ---- */
    case 'USER_SCROLL': {
      // Loading is the only state that ignores user scroll — the IDB
      // read is in flight and we don't want to overwrite it from a
      // layout-shift IO bounce.
      if (state.restore.status === 'loading') return state
      // If we were pending a restore and the user scrolled, they win:
      // promote to live and abandon the saved target.
      const wasPending =
        state.restore.status === 'pending' ||
        state.restore.status === 'applied'
      const next = commit(
        state,
        {
          absoluteSegmentIndex: action.payload.absoluteSegmentIndex,
          wordIndex: 0,
        },
        'user-scroll',
      )
      if (wasPending) {
        next.restore = { ...next.restore, status: 'live', target: null }
      }
      return next
    }
    case 'USER_SEEK': {
      if (state.restore.status === 'loading') return state
      const word = action.payload.wordIndex ?? 0
      const wasPending =
        state.restore.status === 'pending' ||
        state.restore.status === 'applied'
      const next = commit(
        state,
        {
          absoluteSegmentIndex: action.payload.absoluteSegmentIndex,
          wordIndex: word,
        },
        'user-seek',
      )
      if (wasPending) {
        next.restore = { ...next.restore, status: 'live', target: null }
      }
      return next
    }

    case 'MODE_SWITCH': {
      // Cursor stays put. Bumping revision lets each engine's
      // useCursorAlignedEngine effect re-fire so the newly-active
      // engine's local index syncs to the canonical position.
      return commit(state, {}, 'mode-switch')
    }

    case 'TOC_JUMP': {
      const { chapterId, chapterIdx, absoluteSegmentIndex } = action.payload
      // TOC click while loading is rare but allowed — promote to live.
      const wasLoading = state.restore.status === 'loading'
      const next = commit(
        state,
        {
          chapterId,
          chapterIdx,
          absoluteSegmentIndex,
          wordIndex: 0,
        },
        'toc',
      )
      if (state.restore.status !== 'live') {
        next.restore = {
          ...next.restore,
          status: 'live',
          target: null,
          error: wasLoading ? 'cancelled by user TOC jump' : next.restore.error,
        }
      }
      return next
    }

    case 'CHAPTER_NAV': {
      const {
        chapterId,
        chapterIdx,
        reset = true,
        absoluteSegmentIndex,
      } = action.payload
      const next = commit(
        state,
        {
          chapterId,
          chapterIdx,
          absoluteSegmentIndex: reset ? 0 : absoluteSegmentIndex ?? 0,
          wordIndex: 0,
        },
        'chapter-nav',
      )
      // Chapter navigation while loading also abandons the saved target.
      if (state.restore.status !== 'live') {
        next.restore = { ...next.restore, status: 'live', target: null }
      }
      return next
    }

    default:
      return state
  }
}

export { initialCursorRootState }
