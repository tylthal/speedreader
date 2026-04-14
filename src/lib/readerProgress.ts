import type { ReadingMode } from '../types'
import type { AutoBookmarkLocation } from '../api/types'
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
  return bookmark
}
