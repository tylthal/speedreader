import type { ReadingProgress } from '../api/client'
import type { ReadingMode } from '../types'

interface StoredProgressSnapshot {
  chapterId: number
  absoluteSegmentIndex: number
  wordIndex: number
  wpm: number
  readingMode: ReadingMode
}

export function progressStorageKey(publicationId: number): string {
  return `speedreader_progress_${publicationId}`
}

export function buildStoredProgress(
  publicationId: number,
  snapshot: StoredProgressSnapshot,
): ReadingProgress {
  return {
    publication_id: publicationId,
    chapter_id: snapshot.chapterId,
    absolute_segment_index: snapshot.absoluteSegmentIndex,
    word_index: snapshot.wordIndex,
    wpm: snapshot.wpm,
    reading_mode: snapshot.readingMode,
    updated_at: new Date().toISOString(),
    // Recomputed from IndexedDB on the next persisted save.
    segments_read: 0,
  }
}

export function readStoredProgress(publicationId: number): ReadingProgress | null {
  try {
    const raw = localStorage.getItem(progressStorageKey(publicationId))
    if (!raw) return null
    return JSON.parse(raw) as ReadingProgress
  } catch {
    return null
  }
}

export function writeStoredProgress(
  publicationId: number,
  snapshot: StoredProgressSnapshot,
): void {
  try {
    localStorage.setItem(
      progressStorageKey(publicationId),
      JSON.stringify(buildStoredProgress(publicationId, snapshot)),
    )
  } catch {
    /* storage full or unavailable */
  }
}

export function pickFreshestProgress(
  ...candidates: Array<ReadingProgress | null>
): ReadingProgress | null {
  return candidates.reduce<ReadingProgress | null>((freshest, candidate) => {
    if (!candidate) return freshest
    if (!freshest) return candidate
    return new Date(candidate.updated_at) > new Date(freshest.updated_at)
      ? candidate
      : freshest
  }, null)
}
