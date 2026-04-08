/* ------------------------------------------------------------------ */
/*  Position store types                                               */
/* ------------------------------------------------------------------ */
//
// The single mutable record describing where the reader is. Lives in
// /workspace/src/state/position/positionStore.ts as a module-scope
// store. There is no reducer, no action union, no provider — every
// position change is a direct call to one of the store's setters.
//
// Replaces the entire src/state/cursor/* module.

import type { ReadingMode } from '../../types'

export type DisplayMode = 'plain' | 'formatted'

export type PositionOrigin =
  /** RestoreCoordinator landed a saved position. */
  | 'restore'
  /** rAF tick from the playback controller. */
  | 'engine'
  /** Pause-time manual scroll in the formatted view. */
  | 'user-scroll'
  /** Explicit seek (keyboard, gesture, scrubber, prev/next chunk). */
  | 'user-seek'
  /** Reading-mode toggle. */
  | 'mode-switch'
  /** Display-mode toggle (plain ↔ formatted). */
  | 'display-mode'
  /** TOC click. */
  | 'toc'
  /** Prev/next chapter button or auto-advance at chapter end. */
  | 'chapter-nav'

export interface PositionState {
  /** db chapter id (0 = no chapter mounted). */
  chapterId: number
  /** Index into chapters[]. Denormalized so the loader can use it as a key. */
  chapterIdx: number
  /** segment_index in the canonical chapter coordinate system. */
  absoluteSegmentIndex: number
  /** RSVP intra-segment word index. Stays at 0 between RSVP segment
   *  boundaries; the controller flushes the live word here on pause /
   *  visibility-hidden / unmount. */
  wordIndex: number
  /** Reading mode (phrase / rsvp / scroll / track). */
  mode: ReadingMode
  /** Display mode (plain / formatted). */
  displayMode: DisplayMode
  /** Words per minute. */
  wpm: number
  /** True iff playback is currently active. Single writer: the controller. */
  isPlaying: boolean
  /** Most recent producer of a position commit. Used by the saver gate
   *  ("don't write while restoring") and by the formatted-view scroll
   *  effect ("don't scroll back during a user scroll"). */
  origin: PositionOrigin
  /** Monotonic counter; bumps on every commit. Subscribers depend on
   *  this rather than object identity so equality checks are cheap. */
  revision: number
}

export const initialPositionState: PositionState = {
  chapterId: 0,
  chapterIdx: 0,
  absoluteSegmentIndex: 0,
  wordIndex: 0,
  mode: 'phrase',
  displayMode: 'plain',
  wpm: 250,
  isPlaying: false,
  origin: 'restore',
  revision: 0,
}
