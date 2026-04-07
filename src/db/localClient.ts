import { db } from './database'
import type { DBPublication, DBReadingProgress } from './database'
import type { SpeedReaderClient } from '../api/interface'
import {
  storeBookFile,
  deleteBookFiles,
  isFileStorageAvailable,
  getCoverUrl as resolveCoverUrl,
} from '../lib/fileStorage'
import type {
  ParseRequest,
  WorkerOutMessage,
  WorkerResult,
  SerializedInlineImage,
} from '../workers/parserProtocol'
import type {
  Publication,
  PublicationDetail,
  SegmentBatch,
  ImagePageBatch,
  ReadingProgress,
  ProgressInput,
  SegmentInlineImage,
} from '../api/types'

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
    } catch {
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
  segmentIndex: number,
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
  return segmentsBefore + segmentIndex
}

function toProgress(row: DBReadingProgress, segmentsRead: number): ReadingProgress {
  return {
    publication_id: row.publication_id,
    chapter_id: row.chapter_id,
    segment_index: row.segment_index,
    word_index: row.word_index,
    wpm: row.wpm,
    reading_mode: row.reading_mode,
    updated_at: row.updated_at,
    segments_read: segmentsRead,
  }
}

// ---------------------------------------------------------------------------
// Worker-based parsing
// ---------------------------------------------------------------------------

/**
 * Detect whether Web Workers can use DOMParser. Safari/WebKit (including the
 * iOS Capacitor WebView) does not expose DOMParser in workers, which breaks
 * EPUB/HTML/FB2/MD parsing. We probe once and cache the result.
 *
 * The probe uses a module worker to match the actual parserWorker.ts.
 */
let workerDomParserSupported: Promise<boolean> | null = null
function checkWorkerDomParserSupport(): Promise<boolean> {
  if (workerDomParserSupported) return workerDomParserSupported
  workerDomParserSupported = new Promise((resolve) => {
    let probe: Worker | null = null
    let url: string | null = null
    const cleanup = () => {
      if (probe) probe.terminate()
      if (url) URL.revokeObjectURL(url)
    }
    const finish = (result: boolean) => {
      cleanup()
      resolve(result)
    }
    try {
      const code = `
        try {
          const ok = typeof DOMParser !== "undefined" &&
                     !!new DOMParser().parseFromString("<x/>", "application/xml");
          self.postMessage(ok);
        } catch (e) {
          self.postMessage(false);
        }
      `
      const blob = new Blob([code], { type: 'application/javascript' })
      url = URL.createObjectURL(blob)
      probe = new Worker(url, { type: 'module' })
      probe.onmessage = (e) => finish(Boolean(e.data))
      probe.onerror = () => finish(false)
      // Safety timeout — if the worker never responds, assume unsupported.
      setTimeout(() => finish(false), 1500)
    } catch {
      finish(false)
    }
  })
  return workerDomParserSupported
}

function runParseWorker(
  data: ArrayBuffer,
  filename: string,
  onProgress?: (phase: string, percent: number) => void,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/parserWorker.ts', import.meta.url),
      { type: 'module' },
    )
    const id = crypto.randomUUID()

    worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
      const msg = e.data
      if (msg.id !== id) return

      switch (msg.type) {
        case 'progress':
          onProgress?.(msg.phase, msg.percent)
          break
        case 'done':
          worker.terminate()
          resolve(msg.result)
          break
        case 'error':
          worker.terminate()
          reject(new Error(msg.message))
          break
      }
    }

    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message ?? 'Worker failed'))
    }

    const req: ParseRequest = { type: 'parse', id, data, filename }
    worker.postMessage(req, [data])
  })
}

/**
 * Main-thread parsing fallback for environments where the worker can't run
 * DOMParser-based parsers (Safari/WebKit). Mirrors parserWorker.ts.
 */
async function runParseMainThread(
  data: ArrayBuffer,
  filename: string,
  onProgress?: (phase: string, percent: number) => void,
): Promise<WorkerResult> {
  const { parseFile } = await import('../parsers')
  const { chunkText } = await import('../parsers/chunker')
  type LocalInlineImage = import('../parsers/types').InlineImage
  type LocalImagePage = import('../parsers/types').ImagePage
  type LocalParsedBook = import('../parsers/types').ParsedBook
  type SerializedChapter = import('../workers/parserProtocol').SerializedChapter
  type SerializedImageChapter = import('../workers/parserProtocol').SerializedImageChapter
  type ChunkedChapter = import('../workers/parserProtocol').ChunkedChapter
  type SerializedImagePage = import('../workers/parserProtocol').SerializedImagePage

  onProgress?.('parsing', 0)
  const book: LocalParsedBook = await parseFile(data, filename)
  onProgress?.('parsing', 100)

  const serializeImg = async (img: LocalInlineImage): Promise<SerializedInlineImage> => ({
    placeholder: img.placeholder,
    imageData: await img.blob.arrayBuffer(),
    alt: img.alt,
    width: img.width,
    height: img.height,
    mimeType: img.mimeType,
  })

  const serializeImgPage = async (page: LocalImagePage): Promise<SerializedImagePage> => ({
    pageIndex: page.pageIndex,
    imageData: await page.blob.arrayBuffer(),
    width: page.width,
    height: page.height,
    mimeType: page.mimeType,
  })

  const serializedChapters: SerializedChapter[] = []
  const chunkedChapters: ChunkedChapter[] = []

  if (book.contentType === 'text') {
    onProgress?.('chunking', 0)
    const total = book.chapters.length
    for (let i = 0; i < total; i++) {
      const chapter = book.chapters[i]
      const serializedImages: SerializedInlineImage[] = []
      for (const img of chapter.inlineImages) serializedImages.push(await serializeImg(img))

      serializedChapters.push({
        title: chapter.title,
        text: chapter.text,
        inlineImages: serializedImages,
      })

      const segments = chunkText(chapter.text)
      chunkedChapters.push({
        title: chapter.title,
        text: chapter.text,
        segments,
        inlineImages: serializedImages,
      })

      onProgress?.('chunking', Math.round(((i + 1) / total) * 100))
    }
  }

  const serializedImageChapters: SerializedImageChapter[] = []
  for (const imgChapter of book.imageChapters) {
    const pages: SerializedImagePage[] = []
    for (const page of imgChapter.pages) pages.push(await serializeImgPage(page))
    serializedImageChapters.push({ title: imgChapter.title, pages })
  }

  return {
    book: {
      title: book.title,
      author: book.author,
      contentType: book.contentType,
      chapters: serializedChapters,
      imageChapters: serializedImageChapters,
    },
    chunkedChapters,
  }
}

async function runParse(
  data: ArrayBuffer,
  filename: string,
  onProgress?: (phase: string, percent: number) => void,
): Promise<WorkerResult> {
  // Always parse on the main thread. The worker-based approach failed on
  // Safari/WebKit (no DOMParser in workers) and the probe-based fallback
  // proved unreliable. Main-thread parsing is slightly slower but works
  // everywhere, and most files are small enough that the difference is
  // imperceptible.
  console.log('[parse] running on main thread:', filename)
  return runParseMainThread(data, filename, onProgress)
}

function imgBlobFromSerialized(img: SerializedInlineImage): Blob {
  return new Blob([img.imageData], { type: img.mimeType })
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

    // Parse + chunk (Web Worker if supported, else main thread)
    const result = await runParse(data, file.name, this.onUploadProgress)
    const { book, chunkedChapters } = result

    const IMG_PLACEHOLDER_RE = /\{\{IMG_(\d+)\}\}/g

    const pubId = await db.transaction(
      'rw',
      [db.publications, db.chapters, db.segments, db.image_pages],
      async () => {
        const id = await db.publications.add({
          title: book.title,
          author: book.author,
          filename: file.name,
          status: 'ready',
          total_segments: 0,
          content_type: book.contentType,
          total_pages: 0,
          created_at: nowIso(),
        })

        if (book.contentType === 'text') {
          let totalSegments = 0

          for (let chIdx = 0; chIdx < chunkedChapters.length; chIdx++) {
            const chapter = chunkedChapters[chIdx]

            // Build placeholder → image mapping
            const imgMap = new Map(
              chapter.inlineImages.map((img) => [img.placeholder, img]),
            )

            const chapterId = await db.chapters.add({
              publication_id: id as number,
              chapter_index: chIdx,
              title: chapter.title,
              text_content: chapter.text,
              segment_count: chapter.segments.length,
            })

            for (const seg of chapter.segments) {
              let segImagesJson: string | null = null
              const matches = [...seg.text.matchAll(IMG_PLACEHOLDER_RE)]

              if (matches.length && imgMap.size) {
                const segImages: object[] = []
                for (const m of matches) {
                  const placeholder = `{{IMG_${m[1]}}}`
                  const img = imgMap.get(placeholder)
                  if (img) {
                    const blob = imgBlobFromSerialized(img)
                    const url = URL.createObjectURL(blob)
                    segImages.push({
                      image_url: url,
                      alt: img.alt,
                      width: img.width,
                      height: img.height,
                    })
                  }
                }
                if (segImages.length) {
                  segImagesJson = JSON.stringify(segImages)
                  let cleanText = seg.text.replace(IMG_PLACEHOLDER_RE, '').trim()
                  cleanText = cleanText.replace(/\s{2,}/g, ' ')
                  if (cleanText) {
                    seg.text = cleanText
                    seg.word_count = cleanText.split(/\s+/).length
                  }
                }
              }

              await db.segments.add({
                chapter_id: chapterId as number,
                segment_index: seg.index,
                text: seg.text,
                word_count: seg.word_count,
                duration_ms: seg.duration_ms,
                inline_images: segImagesJson,
              })
            }

            totalSegments += chapter.segments.length
          }

          await db.publications.update(id as number, { total_segments: totalSegments })
        } else {
          // Image content (CBZ)
          let totalPages = 0

          for (let chIdx = 0; chIdx < book.imageChapters.length; chIdx++) {
            const imgChapter = book.imageChapters[chIdx]

            const chapterId = await db.chapters.add({
              publication_id: id as number,
              chapter_index: chIdx,
              title: imgChapter.title,
              text_content: null,
              segment_count: 0,
            })

            for (const page of imgChapter.pages) {
              const blob = new Blob([page.imageData], { type: page.mimeType })
              const url = URL.createObjectURL(blob)
              await db.image_pages.add({
                chapter_id: chapterId as number,
                page_index: page.pageIndex,
                image_path: url,
                width: page.width,
                height: page.height,
                mime_type: page.mimeType,
              })
            }

            totalPages += imgChapter.pages.length
          }

          await db.publications.update(id as number, { total_pages: totalPages })
        }

        return id as number
      },
    )

    // Store raw file in OPFS for re-export / re-parse
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

    let tocTree = null
    if (pub.toc_json) {
      try {
        tocTree = JSON.parse(pub.toc_json)
      } catch {
        tocTree = null
      }
    }

    const base = await pubRowToPublication(pub)
    return {
      ...base,
      chapters: chapters.map((c) => ({
        id: c.id!,
        publication_id: c.publication_id,
        chapter_index: c.chapter_index,
        title: c.title,
      })),
      toc_tree: tocTree,
    }
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
      row.segment_index,
    )
    return toProgress(row, segmentsRead)
  }

  async saveProgress(pubId: number, data: ProgressInput): Promise<ReadingProgress> {
    const existing = await db.reading_progress
      .where('publication_id')
      .equals(pubId)
      .first()

    const record = {
      ...(existing ? { id: existing.id } : {}),
      publication_id: pubId,
      chapter_id: data.chapter_id,
      segment_index: data.segment_index,
      word_index: data.word_index,
      wpm: data.wpm,
      reading_mode: data.reading_mode,
      updated_at: nowIso(),
    }

    await db.reading_progress.put(record)

    const segmentsRead = await computeSegmentsRead(
      pubId,
      data.chapter_id,
      data.segment_index,
    )
    return toProgress(record as any, segmentsRead)
  }

}
