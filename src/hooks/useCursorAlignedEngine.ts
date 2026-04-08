import { useEffect, useRef } from 'react'
import type { CursorOrigin } from '../state/cursor/types'

interface UseCursorAlignedEngineOpts {
  /** Bumps on every cursor commit. Effect deps key off this so we don't
   *  false-positive on shape changes. */
  cursorRevision: number
  /** Most recent producer of the cursor commit. We skip alignment when
   *  this engine itself produced the commit, otherwise the engine's own
   *  ENGINE_TICK would loop right back into a redundant seek. */
  cursorOrigin: CursorOrigin
  /** Canonical position to align to. */
  cursorAbsoluteIndex: number
  /** Optional intra-segment word index (RSVP). */
  cursorWordIndex?: number
  /** Engine-supplied alignment hook. Translates the absolute index to
   *  the engine's local array coordinate and seeks. Must NOT publish
   *  back through onCursorTick or we re-enter the loop.
   *
   *  Returns true if the seek actually applied; false if the translation
   *  could not be performed (e.g. segments are not yet loaded). The
   *  hook uses the return value to know whether to latch this revision
   *  as "done" — a false return leaves lastAppliedRev unchanged so the
   *  effect re-fires when alignToCursor's identity next changes (which
   *  happens when the loader's translators update on segment arrival).
   */
  alignToCursor: (absoluteIdx: number, wordIdx: number) => boolean
  /** Restore gate. Skipping alignment until live keeps the saver on the
   *  saved position rather than letting an early ENGINE_TICK overwrite it. */
  isLive: boolean
  /** When false the engine is parked (e.g. focus-mode engines while in
   *  formatted view) and we suppress alignment to save work. */
  isActive?: boolean
}

/**
 * Reactive bridge from CursorContext into a single playback engine.
 *
 * Fires `alignToCursor` whenever the cursor commits with a non-engine
 * origin. Restore landings, mode switches, TOC jumps, chapter navs and
 * pause-time scrolls all flow through here — there is no need for
 * ReaderViewport to call seekTo on every engine by hand.
 *
 * The `cursorOrigin === 'engine'` short-circuit is load-bearing: it
 * breaks the engine→cursor→engine feedback loop without needing a
 * one-shot ref.
 *
 * The `lastAppliedRev` ref tracks the last revision we successfully
 * applied — NOT the last revision we attempted. This matters during
 * cold open: when restore-status flips to live before the loader has
 * delivered segments, the first alignment attempt translates to null
 * and returns false. We leave lastAppliedRev unchanged so that when the
 * loader's translators update (alignToCursor identity changes), the
 * effect re-runs and the alignment lands.
 */
export function useCursorAlignedEngine({
  cursorRevision,
  cursorOrigin,
  cursorAbsoluteIndex,
  cursorWordIndex = 0,
  alignToCursor,
  isLive,
  isActive = true,
}: UseCursorAlignedEngineOpts): void {
  const lastAppliedRev = useRef<number>(-1)

  useEffect(() => {
    if (!isActive) return
    if (!isLive) return
    if (cursorOrigin === 'engine') return
    if (lastAppliedRev.current === cursorRevision) return
    const ok = alignToCursor(cursorAbsoluteIndex, cursorWordIndex)
    // Latch only on a successful seek. A failure (translator returned
    // null) is left pending so the next dep change re-fires the effect.
    if (ok) lastAppliedRev.current = cursorRevision
  }, [
    isActive,
    isLive,
    cursorOrigin,
    cursorRevision,
    cursorAbsoluteIndex,
    cursorWordIndex,
    alignToCursor,
  ])
}
