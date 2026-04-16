import { db, ensureSchemaWipe } from './database'
import type { DBPublication, DBBookmark } from './database'
import type { DisplayMode, SegmentKind, BookmarkType } from './database'
import {
  storeBookFile,
  deleteBookFiles,
  storeCover,
  storeImage,
  isFileStorageAvailable,
  getCoverUrl as resolveCoverUrl,
  getImageUrl as resolveImageUrl,
} from '../lib/fileStorage'
import type { InternalTocNode } from '../lib/tocTree'
import { mapTocTree, parseTocTreeJson } from '../lib/tocTree'
import type { WorkerResult } from '../workers/parserProtocol'
import { buildWorkerResult } from '../workers/buildWorkerResult'
import { parseWithWorker, canUseParserWorker } from '../lib/parserWorkerClient'
import { getExtForMime } from '../parsers/types'

// ---------------------------------------------------------------------------
// Domain types (previously in src/api/types.ts)
// ---------------------------------------------------------------------------

export type ContentType = 'text' | 'image'

// Re-export the primitive shape types so consumers can import them from
// the single client module instead of reaching into ./database.
export type { DisplayMode, SegmentKind, BookmarkType }

export interface Publication {
  id: number
  title: string
  author: string
  filename: string
  status: string
  total_segments: number
  content_type: ContentType
  total_pages: number
  created_at: string
  /** OPFS-resolvable cover URL (when present). */
  cover_url?: string | null
  /** Per-book display mode preference. */
  display_mode_pref?: DisplayMode | null
}

/** A node in the hierarchical TOC tree (PRD §6.4). */
export interface TocNode {
  title: string
  /** Index into PublicationDetail.chapters; -1 for display-only parents. */
  section_index: number
  /** Optional intra-section fragment target from EPUB NCX/nav data. */
  html_anchor?: string | null
  children?: TocNode[]
}

export interface ImagePage {
  id: number
  chapter_id: number
  page_index: number
  image_path: string
  width: number | null
  height: number | null
  mime_type: string
}

export interface ImagePageBatch {
  chapter_id: number
  start_index: number
  end_index: number
  pages: ImagePage[]
  total_pages: number
}

export interface Chapter {
  id: number
  publication_id: number
  chapter_index: number
  title: string
  /** Number of segments/pages in this chapter — used to compute book-wide
   *  progress offsets. Matches DBChapter.segment_count. */
  segment_count: number
  /** Sanitized HTML for the formatted view (PRD §4.3). Empty for PDF/CBZ. */
  html?: string | null
  /** Format-specific metadata (e.g. PDF page range). */
  meta?: Record<string, unknown> | null
}

export interface PublicationDetail extends Publication {
  chapters: Chapter[]
  /** Hierarchical TOC tree, if the source has one. Optional. */
  toc_tree?: TocNode[] | null
}

export interface SegmentInlineImage {
  image_url: string
  alt: string
  width: number
  height: number
}

export interface Segment {
  id: number
  chapter_id: number
  segment_index: number
  text: string
  word_count: number
  duration_ms: number
  inline_images?: SegmentInlineImage[] | null
  /** Anchor inside the section's html string for Plain↔Formatted mapping. */
  html_anchor?: string | null
  /** 'section_title' for synthetic title segments at section boundaries. */
  kind?: SegmentKind | null
}

export interface SegmentBatch {
  chapter_id: number
  start_index: number
  end_index: number
  segments: Segment[]
  total_segments: number
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

export interface Bookmark {
  id: number
  publication_id: number
  type: BookmarkType
  chapter_id: number
  chapter_idx: number
  absolute_segment_index: number
  word_index: number
  snippet: string
  name: string | null
  created_at: string
  updated_at: string
}

export interface CreateBookmarkInput {
  chapter_id: number
  chapter_idx: number
  absolute_segment_index: number
  word_index: number
  snippet: string
  name: string
}

export interface AutoBookmarkLocation {
  chapter_id: number
  chapter_idx: number
  absolute_segment_index: number
  word_index: number
}

// Local alias so later generic param names don't shadow the exported TocNode.
type ApiTocNode = TocNode

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString()
}

async function pubRowToPublication(r: DBPublication): Promise<Publication> {
  let coverUrl: string | null = null
  if (r.cover_path) {
    try {
      coverUrl = await resolveCoverUrl(r.cover_path)
      if (!coverUrl) {
        console.warn('[lib] cover_path set but blob missing', { pubId: r.id, cover_path: r.cover_path })
      }
    } catch (err) {
      console.error('[lib] resolveCoverUrl failed', { pubId: r.id, cover_path: r.cover_path, err })
      coverUrl = null
    }
  }
  return {
    id: r.id!,
    title: r.title,
    author: r.author,
    filename: r.filename,
    status: r.status,
    total_segments: r.total_segments,
    content_type: r.content_type,
    total_pages: r.total_pages,
    created_at: r.created_at,
    cover_url: coverUrl,
    display_mode_pref: r.display_mode_pref ?? null,
  }
}

function toBookmark(row: DBBookmark): Bookmark {
  return {
    id: row.id!,
    publication_id: row.publication_id,
    type: row.type,
    chapter_id: row.chapter_id,
    chapter_idx: row.chapter_idx,
    absolute_segment_index: row.absolute_segment_index,
    word_index: row.word_index,
    snippet: row.snippet,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}


interface UploadDiag {
  parsedCount: number
  fileStorageAvailable: boolean
  attempted: number
  opfsCount: number
  dexieCount: number
  nativeCount: number
  failedCount: number
  firstError: string | null
}

function recordStoredImageBackend(
  uploadDiag: UploadDiag,
  backend: 'opfs' | 'dexie' | 'native',
): void {
  if (backend === 'opfs') uploadDiag.opfsCount++
  else if (backend === 'dexie') uploadDiag.dexieCount++
  else uploadDiag.nativeCount++
}

async function persistImageAsset(
  pubId: number,
  name: string,
  data: ArrayBuffer,
  mimeType: string,
): Promise<'opfs' | 'dexie' | 'native'> {
  const blob = new Blob([data], { type: mimeType })
  return storeImage(pubId, name, blob)
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
//
// Prefer a Web Worker when the browser exposes DOMParser inside workers
// (Chrome/Android/desktop Firefox). Safari/WebKit has historically not,
// so detection naturally steers iOS to the main-thread path. PDFs always
// parse on the main thread because pdfParser renders the cover via
// `document.createElement('canvas')` — worker-unsafe. Any worker failure
// silently falls back to main-thread parsing.

async function runParseMainThread(
  data: ArrayBuffer,
  filename: string,
  onProgress?: (phase: string, percent: number) => void,
): Promise<WorkerResult> {
  const { parseFile } = await import('../parsers')
  type LocalParsedBook = import('../parsers/types').ParsedBook

  onProgress?.('parsing', 0)
  const book: LocalParsedBook = await parseFile(data, filename)
  onProgress?.('parsing', 100)

  onProgress?.('chunking', 0)
  const { result } = await buildWorkerResult(book)
  onProgress?.('chunking', 100)
  return result
}

async function runParse(
  data: ArrayBuffer,
  filename: string,
  onProgress?: (phase: string, percent: number) => void,
): Promise<WorkerResult> {
  if (canUseParserWorker(filename)) {
    const workerResult = await parseWithWorker(data, filename, onProgress)
    if (workerResult) {
      console.log('[parse] ran in worker:', filename)
      return workerResult
    }
  }
  console.log('[parse] running on main thread:', filename)
  return runParseMainThread(data, filename, onProgress)
}

// ---------------------------------------------------------------------------
// LocalClient
// ---------------------------------------------------------------------------

/** Progress callback for upload/import operations */
export type UploadProgressCallback = (phase: string, percent: number) => void

export class LocalClient {
  /** Set by the caller before uploadBook() to receive progress updates */
  onUploadProgress?: UploadProgressCallback

  async uploadBook(file: File): Promise<Publication> {
    const data = await file.arrayBuffer()

    const result = await runParse(data, file.name, this.onUploadProgress)
    const { book, chunkedSections } = result

    // Insert publication first (outside the rw transaction) so we have a
    // pubId for OPFS cover storage. Cover bytes go to OPFS, not Dexie.
    const initialPubId = await db.publications.add({
      title: book.title,
      author: book.author,
      filename: file.name,
      status: 'ready',
      total_segments: 0,
      content_type: book.contentType,
      total_pages: 0,
      created_at: nowIso(),
      cover_path: null,
      display_mode_pref: null,
      toc_json: book.tocTree ? JSON.stringify(book.tocTree) : null,
    })
    const pubId = initialPubId as number

    // Persist cover to storage (best-effort).
    let coverPath: string | null = null
    if (book.cover) {
      try {
        const blob = new Blob([book.cover.imageData], { type: book.cover.mimeType })
        const ext = getExtForMime(book.cover.mimeType)
        coverPath = await storeCover(pubId, blob, ext)
        console.log('[upload] cover stored', { pubId, coverPath, mime: book.cover.mimeType, bytes: book.cover.imageData.byteLength })
      } catch (err) {
        console.error('[upload] storeCover failed', err)
        coverPath = null
      }
    } else {
      console.warn('[upload] no cover extracted from', file.name)
    }
    if (coverPath) {
      await db.publications.update(pubId, { cover_path: coverPath })
    }

    // Persist inline images (EPUB) to OPFS so the formatted view can resolve
    // them across page reloads. Section HTML uses `<img src="opfs:{name}">`
    // markers; FormattedView resolves them to fresh blob URLs at render time.
    //
    // Per-image outcomes (which backend served the write, or which error
    // we caught) are recorded into a localStorage diagnostic blob keyed by
    // pubId. The FormattedView ?diag=1 strip surfaces them on-screen so
    // mobile users can see exactly what happened during their upload
    // without needing browser devtools.
    const uploadDiag: UploadDiag = {
      parsedCount: book.parsedImages?.length ?? 0,
      fileStorageAvailable: isFileStorageAvailable(),
      attempted: 0,
      opfsCount: 0,
      dexieCount: 0,
      nativeCount: 0,
      failedCount: 0,
      firstError: null as string | null,
    }
    if (book.parsedImages?.length) {
      for (const img of book.parsedImages) {
        uploadDiag.attempted++
        try {
          const backend = await persistImageAsset(
            pubId,
            img.name,
            img.imageData,
            img.mimeType,
          )
          recordStoredImageBackend(uploadDiag, backend)
        } catch (err) {
          uploadDiag.failedCount++
          if (!uploadDiag.firstError) {
            uploadDiag.firstError = err instanceof Error ? err.message : String(err)
          }
          console.warn('[upload] failed to store image', img.name, err)
        }
      }
      console.log('[upload] image storage summary for pub', pubId, uploadDiag)
    }

    const storedImagePages = new Map<number, { name: string; mimeType: string; width: number; height: number }>()
    if (book.imagePages?.length) {
      for (const page of book.imagePages) {
        const ext = getExtForMime(page.mimeType)
        const name = `cbz-page-${String(page.pageIndex).padStart(4, '0')}${ext}`
        uploadDiag.attempted++
        try {
          const backend = await persistImageAsset(
            pubId,
            name,
            page.imageData,
            page.mimeType,
          )
          recordStoredImageBackend(uploadDiag, backend)
          storedImagePages.set(page.pageIndex, {
            name,
            mimeType: page.mimeType,
            width: page.width,
            height: page.height,
          })
        } catch (err) {
          uploadDiag.failedCount++
          if (!uploadDiag.firstError) {
            uploadDiag.firstError = err instanceof Error ? err.message : String(err)
          }
          console.warn('[upload] failed to store CBZ page', page.pageIndex, err)
        }
      }
    }
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`upload-diag:${pubId}`, JSON.stringify(uploadDiag))
      }
    } catch {
      /* localStorage may be disabled — ignore */
    }

    // Now insert sections + segments + image_pages in a single transaction.
    await db.transaction(
      'rw',
      [db.publications, db.chapters, db.segments, db.image_pages],
      async () => {
        let totalSegments = 0
        let totalPages = 0

        for (let sIdx = 0; sIdx < chunkedSections.length; sIdx++) {
          const section = chunkedSections[sIdx]

          const sectionId = await db.chapters.add({
            publication_id: pubId,
            chapter_index: sIdx,
            title: section.title,
            text_content: section.text || null,
            segment_count: section.segments.length,
            html: section.html || null,
            meta: section.meta ? JSON.stringify(section.meta) : null,
          })

          // Anchor convention: every segment gets `section-{N}` so the
          // formatted view can scroll to its containing section. P5
          // intentionally lands at section-level precision; per-paragraph
          // anchors are PRD §10 future work.
          const anchor = `section-${sIdx}`
          for (const seg of section.segments) {
            await db.segments.add({
              chapter_id: sectionId as number,
              segment_index: seg.index,
              text: seg.text,
              word_count: seg.word_count,
              duration_ms: seg.duration_ms,
              inline_images: null,
              kind: seg.kind ?? 'text',
              html_anchor: anchor,
            })
          }
          totalSegments += section.segments.length
        }

        // CBZ image pages — attach to the (single) section row, AND
        // synthesize one segment per page so the unified reader's segment
        // cursor can step through the comic in any reading mode (PRD §4.5).
        if (book.contentType === 'image' && book.imagePages?.length) {
          const sectionRow = await db.chapters
            .where('publication_id')
            .equals(pubId)
            .first()
          if (sectionRow?.id) {
            for (const page of book.imagePages) {
              const storedPage = storedImagePages.get(page.pageIndex)
              if (!storedPage) continue
              await db.image_pages.add({
                chapter_id: sectionRow.id,
                page_index: page.pageIndex,
                image_path: storedPage.name,
                width: storedPage.width,
                height: storedPage.height,
                mime_type: storedPage.mimeType,
              })
              // One synthetic segment per page. text is empty, duration is
              // a generous default (5 s) so Phrase/RSVP step pages slowly.
              await db.segments.add({
                chapter_id: sectionRow.id,
                segment_index: page.pageIndex,
                text: '',
                word_count: 0,
                duration_ms: 5000,
                inline_images: null,
                kind: 'text',
                html_anchor: `page-${page.pageIndex}`,
              })
            }
            totalPages = book.imagePages.length
            totalSegments = book.imagePages.length
            // Update the section row's segment_count too.
            await db.chapters.update(sectionRow.id, {
              segment_count: book.imagePages.length,
            })
          }
        }

        await db.publications.update(pubId, {
          total_segments: totalSegments,
          total_pages: totalPages,
        })
      },
    )

    try {
      await storeBookFile(pubId, file)
    } catch {
      // Asset storage is optional — don't fail the upload
    }

    const pub = await db.publications.get(pubId)
    return pubRowToPublication(pub!)
  }

  async getPublications(): Promise<Publication[]> {
    const rows = await db.publications.where('status').notEqual('archived').toArray()
    return Promise.all(rows.map(pubRowToPublication))
  }

  async getArchivedPublications(): Promise<Publication[]> {
    const rows = await db.publications.where('status').equals('archived').toArray()
    return Promise.all(rows.map(pubRowToPublication))
  }

  async archivePublication(id: number): Promise<void> {
    await db.publications.update(id, { status: 'archived' })
  }

  async unarchivePublication(id: number): Promise<void> {
    await db.publications.update(id, { status: 'ready' })
  }

  async deletePublication(id: number): Promise<void> {
    await db.transaction('rw', [
      db.publications,
      db.chapters,
      db.segments,
      db.image_pages,
      db.bookmarks,
    ], async () => {
      const chapters = await db.chapters
        .where('publication_id')
        .equals(id)
        .toArray()
      const chapterIds = chapters.map((c) => c.id!)

      if (chapterIds.length > 0) {
        await db.segments.where('chapter_id').anyOf(chapterIds).delete()
        await db.image_pages.where('chapter_id').anyOf(chapterIds).delete()
      }

      await db.chapters.where('publication_id').equals(id).delete()
      await db.bookmarks.where('publication_id').equals(id).delete()
      await db.publications.delete(id)
    })

    await deleteBookFiles(id).catch(() => {})
  }

  async getPublication(id: number): Promise<PublicationDetail> {
    const pub = await db.publications.get(id)
    if (!pub) throw new Error(`Publication ${id} not found`)

    const chapters = await db.chapters
      .where('[publication_id+chapter_index]')
      .between([id, -Infinity], [id, Infinity])
      .sortBy('chapter_index')

    // Convert the parser-side TocNode (camelCase) to the API surface
    // shape (snake_case). The two types intentionally diverge so the parser
    // doesn't leak into UI imports.
    const convert = (n: InternalTocNode): ApiTocNode => ({
      title: n.title,
      section_index: n.sectionIndex,
      html_anchor: n.htmlAnchor ?? null,
      children: mapTocTree(n.children, convert),
    })
    const storedToc = parseTocTreeJson(pub.toc_json)
    const tocTree = storedToc ? mapTocTree(storedToc, convert) ?? null : null

    const base = await pubRowToPublication(pub)
    return {
      ...base,
      chapters: chapters.map((c) => {
        let meta: Record<string, unknown> | null = null
        if (c.meta) {
          try { meta = JSON.parse(c.meta) } catch { meta = null }
        }
        return {
          id: c.id!,
          publication_id: c.publication_id,
          chapter_index: c.chapter_index,
          title: c.title,
          segment_count: c.segment_count,
          html: c.html ?? null,
          meta,
        }
      }),
      toc_tree: tocTree,
    }
  }

  async setDisplayModePref(pubId: number, mode: DisplayMode | null): Promise<void> {
    await db.publications.update(pubId, { display_mode_pref: mode })
  }

  async getSegments(
    _pubId: number,
    chapterId: number,
    start: number,
    end: number,
  ): Promise<SegmentBatch> {
    const rows = await db.segments
      .where('[chapter_id+segment_index]')
      .between([chapterId, start], [chapterId, end], true, false)
      .toArray()

    const total = await db.segments
      .where('chapter_id')
      .equals(chapterId)
      .count()

    return {
      chapter_id: chapterId,
      start_index: start,
      end_index: end,
      total_segments: total,
      segments: rows.map((r) => {
        let inlineImages: SegmentInlineImage[] | null = null
        if (r.inline_images) {
          try {
            inlineImages = JSON.parse(r.inline_images)
          } catch {
            inlineImages = null
          }
        }
        return {
          id: r.id!,
          chapter_id: r.chapter_id,
          segment_index: r.segment_index,
          text: r.text,
          word_count: r.word_count,
          duration_ms: r.duration_ms,
          inline_images: inlineImages,
          html_anchor: r.html_anchor ?? null,
          kind: r.kind ?? 'text',
        }
      }),
    }
  }

  async getImagePages(
    _pubId: number,
    chapterId: number,
    start: number,
    end: number,
  ): Promise<ImagePageBatch> {
    const rows = await db.image_pages
      .where('[chapter_id+page_index]')
      .between([chapterId, start], [chapterId, end], true, false)
      .toArray()

    const total = await db.image_pages
      .where('chapter_id')
      .equals(chapterId)
      .count()

    return {
      chapter_id: chapterId,
      start_index: start,
      end_index: end,
      total_pages: total,
      pages: rows.map((r) => ({
        id: r.id!,
        chapter_id: r.chapter_id,
        page_index: r.page_index,
        image_path: r.image_path,
        width: r.width,
        height: r.height,
        mime_type: r.mime_type,
      })),
    }
  }

  // -------------------------------------------------------------------------
  // Bookmarks
  // -------------------------------------------------------------------------

  async getBookmarks(pubId: number): Promise<Bookmark[]> {
    const rows = await db.bookmarks
      .where('publication_id')
      .equals(pubId)
      .toArray()
    // Sort: auto bookmarks first, then user bookmarks by created_at desc
    rows.sort((a, b) => {
      const aAuto = a.type !== 'user' ? 0 : 1
      const bAuto = b.type !== 'user' ? 0 : 1
      if (aAuto !== bAuto) return aAuto - bAuto
      return b.created_at.localeCompare(a.created_at)
    })
    return rows.map(toBookmark)
  }

  async createBookmark(pubId: number, data: CreateBookmarkInput): Promise<Bookmark> {
    const now = nowIso()
    const record: DBBookmark = {
      publication_id: pubId,
      type: 'user',
      chapter_id: data.chapter_id,
      chapter_idx: data.chapter_idx,
      absolute_segment_index: data.absolute_segment_index,
      word_index: data.word_index,
      snippet: data.snippet,
      name: data.name,
      created_at: now,
      updated_at: now,
    }
    const id = await db.bookmarks.add(record) as number
    return toBookmark({ ...record, id })
  }

  async updateBookmark(bookmarkId: number, name: string): Promise<Bookmark> {
    const row = await db.bookmarks.get(bookmarkId)
    if (!row) throw new Error(`Bookmark ${bookmarkId} not found`)
    if (row.type !== 'user') throw new Error('Cannot rename auto bookmarks')
    await db.bookmarks.update(bookmarkId, { name, updated_at: nowIso() })
    const updated = await db.bookmarks.get(bookmarkId)
    return toBookmark(updated!)
  }

  async deleteBookmark(bookmarkId: number): Promise<void> {
    const row = await db.bookmarks.get(bookmarkId)
    if (!row) return
    if (row.type !== 'user') throw new Error('Cannot delete auto bookmarks')
    await db.bookmarks.delete(bookmarkId)
  }

  async upsertAutoBookmark(
    pubId: number,
    type: 'last_opened' | 'farthest_read',
    location: AutoBookmarkLocation,
  ): Promise<Bookmark> {
    const existing = await db.bookmarks
      .where('[publication_id+type]')
      .equals([pubId, type])
      .first()

    const now = nowIso()
    if (existing) {
      await db.bookmarks.update(existing.id!, {
        chapter_id: location.chapter_id,
        chapter_idx: location.chapter_idx,
        absolute_segment_index: location.absolute_segment_index,
        word_index: location.word_index,
        updated_at: now,
      })
      const updated = await db.bookmarks.get(existing.id!)
      return toBookmark(updated!)
    }

    const record: DBBookmark = {
      publication_id: pubId,
      type,
      chapter_id: location.chapter_id,
      chapter_idx: location.chapter_idx,
      absolute_segment_index: location.absolute_segment_index,
      word_index: location.word_index,
      snippet: '',
      name: null,
      created_at: now,
      updated_at: now,
    }
    const id = await db.bookmarks.add(record) as number
    return toBookmark({ ...record, id })
  }

  async getAutoBookmark(
    pubId: number,
    type: 'last_opened' | 'farthest_read',
  ): Promise<Bookmark | null> {
    const row = await db.bookmarks
      .where('[publication_id+type]')
      .equals([pubId, type])
      .first()
    return row ? toBookmark(row) : null
  }

  async getAutoBookmarksForPubs(
    pubIds: number[],
    type: 'last_opened' | 'farthest_read',
  ): Promise<Map<number, Bookmark>> {
    const result = new Map<number, Bookmark>()
    // Batch fetch all bookmarks of the given type for requested publications
    const rows = await db.bookmarks
      .where('[publication_id+type]')
      .anyOf(pubIds.map((id) => [id, type]))
      .toArray()
    for (const row of rows) {
      result.set(row.publication_id, toBookmark(row))
    }
    return result
  }

}

// ---------------------------------------------------------------------------
// Module-scope client singleton + free-function API
// ---------------------------------------------------------------------------
//
// Previously lived in src/api/client.ts — folded in here now that there is
// no remote-backend facade. Call sites import these free functions; the
// singleton is an implementation detail.

let _client: LocalClient | null = null

export async function initClient(): Promise<void> {
  await ensureSchemaWipe()
  _client = new LocalClient()
}

function getClient(): LocalClient {
  if (!_client) {
    _client = new LocalClient()
  }
  return _client
}

export function uploadBook(
  file: File,
  onProgress?: (phase: string, percent: number) => void,
) {
  const client = getClient()
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
