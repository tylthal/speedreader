import type { SpeedReaderClient } from './interface'
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
  ReadingProgress,
  ProgressInput,
  TocNode,
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

export function getProgress(pubId: number) {
  return getClient().getProgress(pubId)
}

export function saveProgress(
  pubId: number,
  data: {
    chapter_id: number
    absolute_segment_index: number
    word_index: number
    wpm: number
    reading_mode: string
  },
) {
  return getClient().saveProgress(pubId, data)
}

export function setDisplayModePref(pubId: number, mode: 'plain' | 'formatted' | null) {
  return getClient().setDisplayModePref(pubId, mode)
}
