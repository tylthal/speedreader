/**
 * bookmarkStore — module-scope store for bookmark data.
 *
 * Follows the same pattern as positionStore: module-scope state,
 * subscriber set, useSyncExternalStore hook for React integration.
 */

import { createSelector } from './createSelector'
import type { Bookmark, CreateBookmarkInput, AutoBookmarkLocation } from '../db/localClient'
import {
  getBookmarks,
  createBookmark as apiCreateBookmark,
  updateBookmark as apiUpdateBookmark,
  deleteBookmark as apiDeleteBookmark,
  upsertAutoBookmark as apiUpsertAutoBookmark,
} from '../db/localClient'

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

// Per-bookmark metadata kept out-of-band so we never mutate the bookmark
// object itself. Used to track the monotonic "globalIndex" of the
// farthest_read bookmark so updateFarthestRead() can skip regressions
// without re-scanning segment counts.
const farthestGlobalIndexByBookmark = new WeakMap<Bookmark, number>()

// Diagnostic: expose the store on window so headless tests can read state.
/* eslint-disable @typescript-eslint/no-explicit-any */
if (typeof window !== 'undefined') {
  ;(window as any).__bookmarkStore = { snapshot: () => state }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type Listener = () => void
const listeners = new Set<Listener>()

function emit(): void {
  listeners.forEach((l) => l())
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
    if (state.publicationId === 0) return
    const bookmark = await apiUpsertAutoBookmark(state.publicationId, 'last_opened', location)
    state = { ...state, lastOpened: bookmark, revision: state.revision + 1 }
    emit()
  },

  /** Update the "farthest read" auto bookmark (monotonic — only advances). */
  async updateFarthestRead(
    location: AutoBookmarkLocation,
    globalIndex: number,
  ): Promise<boolean> {
    if (state.publicationId === 0) return false
    // Compare against stored farthest
    const current = state.farthestRead
    if (current) {
      // We need to check if the new position is actually farther.
      // The caller provides globalIndex (segmentsBefore + absoluteSegmentIndex).
      // The previous globalIndex is stored in a WeakMap keyed by the
      // previous farthestRead bookmark instance so we never mutate the
      // bookmark object itself.
      const currentGlobal = farthestGlobalIndexByBookmark.get(current)
      if (currentGlobal !== undefined && globalIndex <= currentGlobal) {
        return false
      }
    }

    const bookmark = await apiUpsertAutoBookmark(state.publicationId, 'farthest_read', location)
    // Record globalIndex against the new bookmark instance for future comparisons.
    farthestGlobalIndexByBookmark.set(bookmark, globalIndex)

    state = { ...state, farthestRead: bookmark, revision: state.revision + 1 }
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

export const useBookmarkSelector = createSelector(bookmarkStore)
