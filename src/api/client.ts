import type { SpeedReaderClient } from './interface'
import type { DisplayMode } from './types'
import { LocalClient } from '../db/localClient'
import { ensureSchemaWipe } from '../db/database'
import { getImageUrl as resolveImageUrl } from '../lib/fileStorage'

// Re-export all types so consumers don't need to change imports
export type {
  ContentType,
  DisplayMode,
  Publication,
  PublicationDetail,
  Chapter,
  Segment,
  SegmentBatch,
  SegmentInlineImage,
  SegmentKind,
  ImagePage,
  ImagePageBatch,
  TocNode,
  Bookmark,
  BookmarkType,
  CreateBookmarkInput,
  AutoBookmarkLocation,
} from './types'

export type { SpeedReaderClient } from './interface'

// --- Client ---

let _client: SpeedReaderClient | null = null

export async function initClient(): Promise<void> {
  await ensureSchemaWipe()
  _client = new LocalClient()
}

function getClient(): SpeedReaderClient {
  if (!_client) {
    _client = new LocalClient()
  }
  return _client
}

// --- Public API (unchanged signatures for all consumers) ---

export type { UploadProgressCallback } from '../db/localClient'

export function uploadBook(
  file: File,
  onProgress?: (phase: string, percent: number) => void,
) {
  const client = getClient() as LocalClient
  if (onProgress) client.onUploadProgress = onProgress
  const result = client.uploadBook(file)
  result.finally(() => { client.onUploadProgress = undefined })
  return result
}

export function getPublications() {
  return getClient().getPublications()
}

export function getArchivedPublications() {
  return getClient().getArchivedPublications()
}

export function archivePublication(id: number) {
  return getClient().archivePublication(id)
}

export function unarchivePublication(id: number) {
  return getClient().unarchivePublication(id)
}

export function deletePublication(id: number) {
  return getClient().deletePublication(id)
}

export function getPublication(id: number) {
  return getClient().getPublication(id)
}

export function getSegments(pubId: number, chapterId: number, start: number, end: number) {
  return getClient().getSegments(pubId, chapterId, start, end)
}

export function getImagePages(pubId: number, chapterId: number, start: number, end: number) {
  return getClient().getImagePages(pubId, chapterId, start, end)
}

export function getImageUrl(pubId: number, imagePath: string) {
  return resolveImageUrl(pubId, imagePath)
}

export function setDisplayModePref(pubId: number, mode: DisplayMode | null) {
  return getClient().setDisplayModePref(pubId, mode)
}

// --- Bookmarks ---

import type { CreateBookmarkInput, AutoBookmarkLocation } from './types'

export function getBookmarks(pubId: number) {
  return getClient().getBookmarks(pubId)
}

export function getAutoBookmark(pubId: number, type: 'last_opened' | 'farthest_read') {
  return getClient().getAutoBookmark(pubId, type)
}

export function getAutoBookmarksForPubs(pubIds: number[], type: 'last_opened' | 'farthest_read') {
  return getClient().getAutoBookmarksForPubs(pubIds, type)
}

export function createBookmark(pubId: number, data: CreateBookmarkInput) {
  return getClient().createBookmark(pubId, data)
}

export function updateBookmark(bookmarkId: number, name: string) {
  return getClient().updateBookmark(bookmarkId, name)
}

export function deleteBookmark(bookmarkId: number) {
  return getClient().deleteBookmark(bookmarkId)
}

export function upsertAutoBookmark(
  pubId: number,
  type: 'last_opened' | 'farthest_read',
  location: AutoBookmarkLocation,
) {
  return getClient().upsertAutoBookmark(pubId, type, location)
}
