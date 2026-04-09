import { db } from './database'
import type { DBPublication, DBReadingProgress } from './database'
import type { SpeedReaderClient } from '../api/interface'
import {
  storeBookFile,
  deleteBookFiles,
  storeCover,
  storeImage,
  isFileStorageAvailable,
  getCoverUrl as resolveCoverUrl,
} from '../lib/fileStorage'
import type { InternalTocNode } from '../lib/tocTree'
import { mapTocTree, parseTocTreeJson } from '../lib/tocTree'
import type { WorkerResult } from '../workers/parserProtocol'
import { buildWorkerResult } from '../workers/buildWorkerResult'
import type {
  Publication,
  PublicationDetail,
  SegmentBatch,
  ImagePageBatch,
  ReadingProgress,
  ProgressInput,
  SegmentInlineImage,
  TocNode as ApiTocNode,
} from '../api/types'
import { getExtForMime } from '../parsers/types'

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

async function computeSegmentsRead(
  pubId: number,
  chapterId: number,
  absoluteSegmentIndex: number,
): Promise<number> {
  const chapters = await db.chapters
    .where('[publication_id+chapter_index]')
    .between([pubId, -Infinity], [pubId, Infinity])
    .sortBy('chapter_index')

  let segmentsBefore = 0
  for (const ch of chapters) {
    if (ch.id === chapterId) break
    segmentsBefore += ch.segment_count
  }
  return segmentsBefore + absoluteSegmentIndex
}

function toProgress(row: DBReadingProgress, segmentsRead: number): ReadingProgress {
  return {
    publication_id: row.publication_id,
    chapter_id: row.chapter_id,
    absolute_segment_index: row.absolute_segment_index,
    word_index: row.word_index,
    wpm: row.wpm,
    reading_mode: row.reading_mode,
    updated_at: row.updated_at,
    segments_read: segmentsRead,
  }
}

// ---------------------------------------------------------------------------
// Parsing (main-thread only — Safari/WebKit lacks DOMParser in workers)
// ---------------------------------------------------------------------------

async function runParse(
  data: ArrayBuffer,
  filename: string,
  onProgress?: (phase: string, percent: number) => void,
): Promise<WorkerResult> {
  const { parseFile } = await import('../parsers')
  type LocalParsedBook = import('../parsers/types').ParsedBook

  console.log('[parse] running on main thread:', filename)

  onProgress?.('parsing', 0)
  const book: LocalParsedBook = await parseFile(data, filename)
  onProgress?.('parsing', 100)

  onProgress?.('chunking', 0)
  const { result } = await buildWorkerResult(book)
  onProgress?.('chunking', 100)
  return result
}

// ---------------------------------------------------------------------------
// LocalClient
// ---------------------------------------------------------------------------

/** Progress callback for upload/import operations */
export type UploadProgressCallback = (phase: string, percent: number) => void

export class LocalClient implements SpeedReaderClient {
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

    // Persist cover to OPFS (best-effort).
    let coverPath: string | null = null
    if (book.cover) {
      if (!isFileStorageAvailable()) {
        console.warn('[upload] cover present but file storage unavailable')
      } else {
        try {
          const blob = new Blob([book.cover.imageData], { type: book.cover.mimeType })
          const ext = getExtForMime(book.cover.mimeType)
          coverPath = await storeCover(pubId, blob, ext)
          console.log('[upload] cover stored', { pubId, coverPath, mime: book.cover.mimeType, bytes: book.cover.imageData.byteLength })
        } catch (err) {
          console.error('[upload] storeCover failed', err)
          coverPath = null
        }
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
    const uploadDiag = {
      parsedCount: book.parsedImages?.length ?? 0,
      fileStorageAvailable: isFileStorageAvailable(),
      attempted: 0,
      opfsCount: 0,
      dexieCount: 0,
      nativeCount: 0,
      failedCount: 0,
      firstError: null as string | null,
    }
    if (book.parsedImages?.length && isFileStorageAvailable()) {
      for (const img of book.parsedImages) {
        uploadDiag.attempted++
        try {
          const blob = new Blob([img.imageData], { type: img.mimeType })
          const backend = await storeImage(pubId, img.name, blob)
          if (backend === 'opfs') uploadDiag.opfsCount++
          else if (backend === 'dexie') uploadDiag.dexieCount++
          else if (backend === 'native') uploadDiag.nativeCount++
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
              const blob = new Blob([page.imageData], { type: page.mimeType })
              const url = URL.createObjectURL(blob)
              await db.image_pages.add({
                chapter_id: sectionRow.id,
                page_index: page.pageIndex,
                image_path: url,
                width: page.width,
                height: page.height,
                mime_type: page.mimeType,
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

    if (isFileStorageAvailable()) {
      try {
        await storeBookFile(pubId, file)
      } catch {
        // OPFS storage is optional — don't fail the upload
      }
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
      db.reading_progress,
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
      await db.reading_progress.where('publication_id').equals(id).delete()
      await db.publications.delete(id)
    })

    // Clean up OPFS files
    if (isFileStorageAvailable()) {
      await deleteBookFiles(id).catch(() => {})
    }
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
          html: c.html ?? null,
          meta,
        }
      }),
      toc_tree: tocTree,
    }
  }

  async setDisplayModePref(pubId: number, mode: 'plain' | 'formatted' | null): Promise<void> {
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

  getImageUrl(imagePath: string): string {
    // TODO (Phase 4): Read from OPFS and return a blob URL.
    // For now, return the path as-is (works for migrated data that still
    // has server-relative paths stored).
    return imagePath
  }

  async getProgress(pubId: number): Promise<ReadingProgress | null> {
    const row = await db.reading_progress
      .where('publication_id')
      .equals(pubId)
      .first()
    if (!row) return null
    const segmentsRead = await computeSegmentsRead(
      pubId,
      row.chapter_id,
      row.absolute_segment_index,
    )
    return toProgress(row, segmentsRead)
  }

  async saveProgress(pubId: number, data: ProgressInput): Promise<ReadingProgress> {
    const existing = await db.reading_progress
      .where('publication_id')
      .equals(pubId)
      .first()

    const record: DBReadingProgress = {
      ...(existing ? { id: existing.id } : {}),
      publication_id: pubId,
      chapter_id: data.chapter_id,
      absolute_segment_index: data.absolute_segment_index,
      word_index: data.word_index,
      wpm: data.wpm,
      reading_mode: data.reading_mode,
      updated_at: nowIso(),
    }

    await db.reading_progress.put(record)
    const segmentsRead = await computeSegmentsRead(
      pubId,
      data.chapter_id,
      data.absolute_segment_index,
    )
    return toProgress(record, segmentsRead)
  }

}
