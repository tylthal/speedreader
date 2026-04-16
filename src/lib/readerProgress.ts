import type { ReadingMode } from '../types'
import type { AutoBookmarkLocation } from '../db/localClient'
import { safeGetItem, safeSetItem } from './safeStorage'

// ---------------------------------------------------------------------------
// Reader preferences — wpm + reading_mode stored per-publication in localStorage
// ---------------------------------------------------------------------------

interface StoredReaderPrefs {
  wpm: number
  readingMode: ReadingMode
  wpmByMode?: Partial<Record<ReadingMode, number>>
}

const DEFAULT_WPM = 250

export function resolveWpmForMode(
  prefs: StoredReaderPrefs | null,
  mode: ReadingMode,
): number {
  if (!prefs) return DEFAULT_WPM
  return prefs.wpmByMode?.[mode] ?? prefs.wpm ?? DEFAULT_WPM
}

function prefsKey(publicationId: number): string {
  return `speedreader_prefs_${publicationId}`
}

export function readStoredPrefs(publicationId: number): StoredReaderPrefs | null {
  const raw = safeGetItem(prefsKey(publicationId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredReaderPrefs
  } catch {
    return null
  }
}

export function writeStoredPrefs(
  publicationId: number,
  prefs: StoredReaderPrefs,
): void {
  safeSetItem(prefsKey(publicationId), JSON.stringify(prefs))
}

// ---------------------------------------------------------------------------
// Position snapshot — localStorage fallback for instant restore
// ---------------------------------------------------------------------------

interface StoredPositionSnapshot extends AutoBookmarkLocation {
  updated_at: string
  /** Formatted view scrollTop for pixel-perfect restore. */
  scroll_top?: number
}

function positionKey(publicationId: number): string {
  return `speedreader_position_${publicationId}`
}

export function readStoredPosition(publicationId: number): StoredPositionSnapshot | null {
  const raw = safeGetItem(positionKey(publicationId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredPositionSnapshot
  } catch {
    return null
  }
}

export function writeStoredPosition(
  publicationId: number,
  location: AutoBookmarkLocation & { scroll_top?: number },
): void {
  safeSetItem(
    positionKey(publicationId),
    JSON.stringify({ ...location, updated_at: new Date().toISOString() }),
  )
}

/**
 * Pick the freshest position source: the IndexedDB auto-bookmark vs the
 * localStorage snapshot. Returns null if neither exists.
 */
export function pickFreshestPosition(
  bookmark: { chapter_id: number; chapter_idx: number; absolute_segment_index: number; word_index: number; updated_at: string } | null,
  localSnapshot: StoredPositionSnapshot | null,
): StoredPositionSnapshot | AutoBookmarkLocation | null {
  if (!bookmark && !localSnapshot) return null
  if (!bookmark) return localSnapshot
  if (!localSnapshot) return bookmark

  const bmTime = new Date(bookmark.updated_at).getTime()
  const lsTime = new Date(localSnapshot.updated_at).getTime()

  // Prefer localStorage when timestamps are equal or localStorage is newer,
  // because localStorage carries scroll_top for pixel-perfect pip restore.
  // IndexedDB bookmarks don't have scroll_top.
  if (lsTime >= bmTime) return localSnapshot

  // Bookmark is newer. If localStorage covers the same logical position
  // (same chapter + segment + word) and carries a scroll_top that the
  // bookmark lacks, merge: return a synthetic snapshot with the
  // bookmark's updated_at but localStorage's scroll_top. Without this,
  // the bookmark's 2s-debounced API write (which always lands a few ms
  // after the LS write that flushed at visibility-hidden) will shadow
  // the LS entry and the restore loses its pixel-perfect scrollTop.
  if (
    localSnapshot.scroll_top != null &&
    localSnapshot.chapter_id === bookmark.chapter_id &&
    localSnapshot.chapter_idx === bookmark.chapter_idx &&
    localSnapshot.absolute_segment_index === bookmark.absolute_segment_index &&
    localSnapshot.word_index === bookmark.word_index
  ) {
    return { ...bookmark, scroll_top: localSnapshot.scroll_top }
  }

  return bookmark
}
