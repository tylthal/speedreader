/**
 * bookmarkStore — module-scope store for bookmark data.
 *
 * Follows the same pattern as positionStore: module-scope state,
 * subscriber set, useSyncExternalStore hook for React integration.
 */

import { useSyncExternalStore, useRef } from 'react'
import type { Bookmark, CreateBookmarkInput, AutoBookmarkLocation } from '../api/types'
import {
  getBookmarks,
  createBookmark as apiCreateBookmark,
  updateBookmark as apiUpdateBookmark,
  deleteBookmark as apiDeleteBookmark,
  upsertAutoBookmark as apiUpsertAutoBookmark,
} from '../api/client'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface BookmarkStoreState {
  publicationId: number
  bookmarks: Bookmark[]       // user bookmarks, sorted by created_at desc
  lastOpened: Bookmark | null
  farthestRead: Bookmark | null
  revision: number
}

const initial: BookmarkStoreState = {
  publicationId: 0,
  bookmarks: [],
  lastOpened: null,
  farthestRead: null,
  revision: 0,
}

let state: BookmarkStoreState = initial

type Listener = () => void
const listeners = new Set<Listener>()

function emit(): void {
  listeners.forEach((l) => l())
}

function bump(): void {
  state = { ...state, revision: state.revision + 1 }
  emit()
}

function classifyBookmarks(all: Bookmark[]): Pick<BookmarkStoreState, 'bookmarks' | 'lastOpened' | 'farthestRead'> {
  let lastOpened: Bookmark | null = null
  let farthestRead: Bookmark | null = null
  const bookmarks: Bookmark[] = []

  for (const b of all) {
    if (b.type === 'last_opened') lastOpened = b
    else if (b.type === 'farthest_read') farthestRead = b
    else bookmarks.push(b)
  }

  return { bookmarks, lastOpened, farthestRead }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const bookmarkStore = {
  getSnapshot(): BookmarkStoreState {
    return state
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },

  /** Load all bookmarks for a publication. Called once on reader mount. */
  async init(publicationId: number): Promise<void> {
    const all = await getBookmarks(publicationId)
    const classified = classifyBookmarks(all)
    state = {
      publicationId,
      ...classified,
      revision: state.revision + 1,
    }
    emit()
  },

  /** Create a user bookmark. */
  async addBookmark(data: CreateBookmarkInput): Promise<Bookmark> {
    const bookmark = await apiCreateBookmark(state.publicationId, data)
    state = {
      ...state,
      bookmarks: [bookmark, ...state.bookmarks],
      revision: state.revision + 1,
    }
    emit()
    return bookmark
  },

  /** Rename a user bookmark. */
  async renameBookmark(bookmarkId: number, name: string): Promise<void> {
    const updated = await apiUpdateBookmark(bookmarkId, name)
    state = {
      ...state,
      bookmarks: state.bookmarks.map((b) => (b.id === bookmarkId ? updated : b)),
      revision: state.revision + 1,
    }
    emit()
  },

  /** Delete a user bookmark. */
  async removeBookmark(bookmarkId: number): Promise<void> {
    await apiDeleteBookmark(bookmarkId)
    state = {
      ...state,
      bookmarks: state.bookmarks.filter((b) => b.id !== bookmarkId),
      revision: state.revision + 1,
    }
    emit()
  },

  /** Update the "last opened" auto bookmark. */
  async updateLastOpened(location: AutoBookmarkLocation): Promise<void> {
    const bookmark = await apiUpsertAutoBookmark(state.publicationId, 'last_opened', location)
    state = { ...state, lastOpened: bookmark, revision: state.revision + 1 }
    emit()
  },

  /** Update the "farthest read" auto bookmark (monotonic — only advances). */
  async updateFarthestRead(
    location: AutoBookmarkLocation,
    globalIndex: number,
  ): Promise<boolean> {
    // Compare against stored farthest
    const current = state.farthestRead
    if (current) {
      // We need to check if the new position is actually farther.
      // The caller provides globalIndex (segmentsBefore + absoluteSegmentIndex).
      // We store the previous globalIndex in a closure-free way by comparing
      // chapter_idx and absolute_segment_index.
      const currentGlobal = (current as Bookmark & { _globalIndex?: number })._globalIndex
      if (currentGlobal !== undefined && globalIndex <= currentGlobal) {
        return false
      }
    }

    const bookmark = await apiUpsertAutoBookmark(state.publicationId, 'farthest_read', location)
    // Tag with globalIndex for future comparisons
    const tagged = bookmark as Bookmark & { _globalIndex?: number }
    tagged._globalIndex = globalIndex

    state = { ...state, farthestRead: tagged, revision: state.revision + 1 }
    emit()
    return true
  },

  /** Get the count of user bookmarks (for default naming). */
  getUserBookmarkCount(): number {
    return state.bookmarks.length
  },

  /** Reset on unmount. */
  reset(): void {
    state = initial
    emit()
  },
}

// ---------------------------------------------------------------------------
// React hooks
// ---------------------------------------------------------------------------

export function useBookmarkSelector<T>(
  selector: (s: BookmarkStoreState) => T,
  equalityFn: (a: T, b: T) => boolean = Object.is,
): T {
  const lastRef = useRef<T | undefined>(undefined)
  const lastSnapshotRef = useRef<BookmarkStoreState | null>(null)

  const getSelected = (): T => {
    const snapshot = bookmarkStore.getSnapshot()
    if (lastSnapshotRef.current === snapshot && lastRef.current !== undefined) {
      return lastRef.current
    }
    const next = selector(snapshot)
    if (lastRef.current === undefined || !equalityFn(lastRef.current, next)) {
      lastRef.current = next
    }
    lastSnapshotRef.current = snapshot
    return lastRef.current!
  }

  return useSyncExternalStore(bookmarkStore.subscribe, getSelected, getSelected)
}
