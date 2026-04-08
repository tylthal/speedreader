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
   *  back through onCursorTick or we re-enter the loop. */
  alignToCursor: (absoluteIdx: number, wordIdx: number) => void
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
 * one-shot ref. If alignToCursor were ever to publish back through
 * onCursorTick (it must not), the loop would still terminate after one
 * pass because the cursor position wouldn't change — but the assert
 * costs nothing and makes the contract explicit.
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
  // Track the last revision we acted on so an effect re-fire from a
  // dependency churn other than the cursor revision (e.g. alignToCursor
  // identity change) doesn't re-seek the engine for no reason.
  const lastAppliedRev = useRef<number>(-1)

  useEffect(() => {
    if (!isActive) return
    if (!isLive) return
    if (cursorOrigin === 'engine') return
    if (lastAppliedRev.current === cursorRevision) return
    lastAppliedRev.current = cursorRevision
    alignToCursor(cursorAbsoluteIndex, cursorWordIndex)
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
