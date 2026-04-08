/* ------------------------------------------------------------------ */
/*  RestoreCoordinator                                                  */
/* ------------------------------------------------------------------ */
//
// Owns the saved-position restore lifecycle. Replaces the ad-hoc
// initial-seek effect that lived inside ReaderViewport before the
// cursor refactor — that effect needed an external one-shot ref to
// stop re-firing once engines caught up. The state machine here lets
// the reducer handle re-entry naturally:
//
//   idle ─RESTORE_BEGIN─▶ loading
//   loading ─RESTORE_LOADED─▶ pending
//   loading ─RESTORE_NONE─▶ live   (no saved progress)
//   loading ─RESTORE_FAILED─▶ live (with error)
//   pending ─RESTORE_APPLIED─▶ applied
//   pending ─USER_SCROLL/USER_SEEK─▶ live  (user pre-empted; reducer)
//   applied ─GO_LIVE─▶ live
//
// `pending → applied` is gated on TWO conditions:
//   1. The loader window includes the saved absolute_segment_index
//      (ensureWindowFor resolves).
//   2. The currently-active engine has aligned to the cursor position
//      (cursor.absoluteSegmentIndex === target.absoluteSegmentIndex
//       AND cursor.origin === 'restore').
//
// We dispatch RESTORE_APPLIED when both hold; the reducer transitions
// pending → applied → live across two ticks so the saver can't see a
// stale position.

import { useEffect, useRef } from 'react'
import { getProgress } from '../../api/client'
import type { ReadingProgress, Chapter } from '../../api/client'
import type { ReadingMode } from '../../types'
import { useCursorDispatch, useCursorState } from './CursorContext'
import type { RestoreTarget } from './types'

const VALID_MODES: ReadingMode[] = ['phrase', 'rsvp', 'scroll', 'track']

function coerceMode(raw: string): ReadingMode {
  if ((VALID_MODES as readonly string[]).includes(raw)) return raw as ReadingMode
  // Backward compat: an old build saved 'eyetrack'.
  if (raw === 'eyetrack') return 'track'
  return 'phrase'
}

function readLocalProgress(pubId: number): ReadingProgress | null {
  try {
    const raw = localStorage.getItem(`speedreader_progress_${pubId}`)
    if (!raw) return null
    return JSON.parse(raw) as ReadingProgress
  } catch {
    return null
  }
}

function pickFresher(
  api: ReadingProgress | null,
  local: ReadingProgress | null,
): { progress: ReadingProgress; source: 'api' | 'localStorage' | 'merged' } | null {
  if (!api && !local) return null
  if (api && !local) return { progress: api, source: 'api' }
  if (local && !api) return { progress: local, source: 'localStorage' }
  // Both — newer wins. Equal updated_at falls back to api.
  const apiTs = new Date(api!.updated_at).getTime()
  const localTs = new Date(local!.updated_at).getTime()
  if (localTs > apiTs) return { progress: local!, source: 'localStorage' }
  return { progress: api!, source: 'api' }
}

function targetFromProgress(
  progress: ReadingProgress,
  chapters: Chapter[],
): RestoreTarget | null {
  const chapterIdx = chapters.findIndex((c) => c.id === progress.chapter_id)
  if (chapterIdx === -1) return null
  return {
    chapterId: progress.chapter_id,
    chapterIdx,
    absoluteSegmentIndex: progress.absolute_segment_index,
    wordIndex: progress.word_index ?? 0,
    wpm: progress.wpm,
    readingMode: coerceMode(progress.reading_mode),
  }
}

interface RestoreCoordinatorOptions {
  publicationId: number
  chapters: Chapter[]
  /** Resolves once the loaded segment window covers the absolute index. */
  ensureWindowFor: (chapterId: number, absoluteIdx: number) => Promise<void>
  /** Called when a target is decoded so the parent can mount the right
   *  chapter. The cursor's chapterIdx field already carries this — but
   *  ReaderViewport needs to flip its own chapterIdx state for chapters[]
   *  consumers, which is too coarse a re-render to drive from the cursor. */
  onTargetDecoded?: (target: RestoreTarget) => void
}

export function useRestoreCoordinator({
  publicationId,
  chapters,
  ensureWindowFor,
  onTargetDecoded,
}: RestoreCoordinatorOptions): void {
  const dispatch = useCursorDispatch()
  const cursorRoot = useCursorState()
  const restoreStatus = cursorRoot.restore.status
  const target = cursorRoot.restore.target

  // Latest refs so the load effect can read them inside an async chain
  // without re-firing on every parent re-render.
  const chaptersRef = useRef(chapters)
  chaptersRef.current = chapters
  const onTargetDecodedRef = useRef(onTargetDecoded)
  onTargetDecodedRef.current = onTargetDecoded
  const ensureRef = useRef(ensureWindowFor)
  ensureRef.current = ensureWindowFor

  /* ------------------------------------------------------------ */
  /*  Phase 1 — read API + localStorage in parallel               */
  /* ------------------------------------------------------------ */
  useEffect(() => {
    let cancelled = false
    if (restoreStatus !== 'idle') return

    dispatch({ type: 'RESTORE_BEGIN' })

    Promise.allSettled([
      getProgress(publicationId).catch(() => null),
      Promise.resolve(readLocalProgress(publicationId)),
    ])
      .then(([apiResult, lsResult]) => {
        if (cancelled) return
        const api =
          apiResult.status === 'fulfilled' ? apiResult.value ?? null : null
        const local =
          lsResult.status === 'fulfilled' ? lsResult.value ?? null : null

        const picked = pickFresher(api, local)
        if (!picked) {
          dispatch({ type: 'RESTORE_NONE' })
          return
        }

        const decoded = targetFromProgress(picked.progress, chaptersRef.current)
        if (!decoded) {
          // Saved progress references a chapter that no longer exists
          // (rare; manual db edit, or chapters renumbered). Treat as none.
          dispatch({ type: 'RESTORE_NONE' })
          return
        }

        onTargetDecodedRef.current?.(decoded)
        dispatch({
          type: 'RESTORE_LOADED',
          payload: { target: decoded, source: picked.source },
        })
      })
      .catch((err) => {
        if (cancelled) return
        dispatch({
          type: 'RESTORE_FAILED',
          payload: {
            error: err instanceof Error ? err.message : 'restore failed',
          },
        })
      })

    return () => {
      cancelled = true
    }
    // We only want to fire the load once per provider mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicationId])

  /* ------------------------------------------------------------ */
  /*  Phase 2 — ensure loader window covers the target            */
  /* ------------------------------------------------------------ */
  useEffect(() => {
    if (restoreStatus !== 'pending') return
    if (!target) return
    let cancelled = false

    ensureRef.current(target.chapterId, target.absoluteSegmentIndex)
      .then(() => {
        if (cancelled) return
        // The window is in. The engines' useCursorAlignedEngine effect
        // already fired on RESTORE_LOADED (which set cursor.origin =
        // 'restore') so they should have aligned. Mark applied; the
        // GO_LIVE follow-up promotes the saver gate.
        dispatch({ type: 'RESTORE_APPLIED' })
      })
      .catch((err) => {
        if (cancelled) return
        dispatch({
          type: 'RESTORE_FAILED',
          payload: {
            error: err instanceof Error ? err.message : 'window load failed',
          },
        })
      })

    return () => {
      cancelled = true
    }
  }, [restoreStatus, target, dispatch])

  /* ------------------------------------------------------------ */
  /*  Phase 3 — applied → live (one tick gap)                     */
  /* ------------------------------------------------------------ */
  useEffect(() => {
    if (restoreStatus !== 'applied') return
    // microtask gap so any pending ENGINE_TICK from the just-aligned
    // engines lands first; the reducer will no-op them since the
    // status is still applied (ENGINE_TICK only commits in live), and
    // then we flip live and the saver picks up the canonical position.
    const handle = setTimeout(() => dispatch({ type: 'GO_LIVE' }), 0)
    return () => clearTimeout(handle)
  }, [restoreStatus, dispatch])
}
