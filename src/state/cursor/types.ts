/* ------------------------------------------------------------------ */
/*  Cursor types                                                       */
/* ------------------------------------------------------------------ */
//
// Single source of truth for "where is the reader." Replaces the four
// independent currentIndex values that each engine used to own. Engines
// publish to the cursor reducer (coalesced — see useRsvpEngine) and read
// back from it via useCursorAlignedEngine.
//
// `absoluteSegmentIndex` is in the chapter's canonical coordinate system
// (i.e. the segment_index column from the segments table), NOT an array
// index into a partial loaded window. Translators in useSegmentLoader
// convert between absolute and array coordinates.

import type { ReadingMode } from '../../types'

export type CursorOrigin =
  /** RestoreCoordinator landed a saved position. */
  | 'restore'
  /** rAF tick from playback / rsvp / scroll / track. */
  | 'engine'
  /** Pause-time manual scroll in formatted view. */
  | 'user-scroll'
  /** Explicit seek (keyboard, gesture, scrubber, prev/next chunk). */
  | 'user-seek'
  /** Reading-mode change (the cursor stays put, revision bumps). */
  | 'mode-switch'
  /** TOC click. */
  | 'toc'
  /** Prev/next chapter button or auto-advance at chapter end. */
  | 'chapter-nav'

export interface Cursor {
  /** db chapter id (0 = no chapter mounted). */
  chapterId: number
  /** index into chapters[] (denormalized for nav). */
  chapterIdx: number
  /** segment_index in the canonical chapter coordinate system. */
  absoluteSegmentIndex: number
  /** RSVP intra-segment word; 0 for non-RSVP modes. */
  wordIndex: number
  /** Most recent producer of this state. Used by useCursorAlignedEngine
   *  to break the engine→cursor→engine feedback loop. */
  origin: CursorOrigin
  /** Monotonic counter; bumps on every commit. Effects depend on this
   *  rather than the whole object so they don't false-positive on shape
   *  changes. */
  revision: number
}

/** Pending restore target — copied from saved progress. */
export interface RestoreTarget {
  chapterId: number
  chapterIdx: number
  absoluteSegmentIndex: number
  wordIndex: number
  wpm: number
  readingMode: ReadingMode
}

export interface RestoreState {
  /**
   * idle    — coordinator hasn't started yet
   * loading — Promise.allSettled([api, localStorage]) inflight
   * pending — target loaded; waiting for loader window + engine align
   * applied — engines reflect target; one tick before going live
   * live    — saver is enabled; ENGINE_TICKs commit normally
   */
  status: 'idle' | 'loading' | 'pending' | 'applied' | 'live'
  target: RestoreTarget | null
  source: 'api' | 'localStorage' | 'merged' | 'none' | null
  error: string | null
}

export interface CursorRootState {
  cursor: Cursor
  restore: RestoreState
}

export const initialCursor: Cursor = {
  chapterId: 0,
  chapterIdx: 0,
  absoluteSegmentIndex: 0,
  wordIndex: 0,
  origin: 'restore',
  revision: 0,
}

export const initialRestoreState: RestoreState = {
  status: 'idle',
  target: null,
  source: null,
  error: null,
}

export const initialCursorRootState: CursorRootState = {
  cursor: initialCursor,
  restore: initialRestoreState,
}
