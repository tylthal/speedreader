/**
 * Web Worker that runs file parsing + text chunking off the main thread.
 *
 * Receives an ArrayBuffer + filename, returns a fully parsed and chunked book.
 * Images are serialized as ArrayBuffers and transferred (zero-copy).
 */

import { parseFile } from '../parsers'
import { chunkText } from '../parsers/chunker'
import type { ParsedBook, InlineImage, ImagePage } from '../parsers/types'
import type {
  ParseRequest,
  WorkerOutMessage,
  SerializedInlineImage,
  SerializedChapter,
  SerializedImageChapter,
  ChunkedChapter,
  WorkerResult,
} from './parserProtocol'

function post(msg: WorkerOutMessage, transfer?: Transferable[]) {
  self.postMessage(msg, { transfer: transfer ?? [] })
}

async function serializeInlineImage(img: InlineImage): Promise<SerializedInlineImage> {
  const buf = await img.blob.arrayBuffer()
  return {
    placeholder: img.placeholder,
    imageData: buf,
    alt: img.alt,
    width: img.width,
    height: img.height,
    mimeType: img.mimeType,
  }
}

async function serializeImagePage(page: ImagePage): Promise<{ serialized: import('./parserProtocol').SerializedImagePage; buffer: ArrayBuffer }> {
  const buf = await page.blob.arrayBuffer()
  return {
    serialized: {
      pageIndex: page.pageIndex,
      imageData: buf,
      width: page.width,
      height: page.height,
      mimeType: page.mimeType,
    },
    buffer: buf,
  }
}

async function handleParse(req: ParseRequest) {
  const { id, data, filename } = req

  try {
    // Phase 1: Parse
    post({ type: 'progress', id, phase: 'parsing', percent: 0 })
    const book: ParsedBook = await parseFile(data, filename)
    post({ type: 'progress', id, phase: 'parsing', percent: 100 })

    // Collect all ArrayBuffers to transfer (zero-copy)
    const transferables: ArrayBuffer[] = []

    // Serialize chapters (text content)
    const serializedChapters: SerializedChapter[] = []
    const chunkedChapters: ChunkedChapter[] = []

    if (book.contentType === 'text') {
      post({ type: 'progress', id, phase: 'chunking', percent: 0 })
      const total = book.chapters.length

      for (let i = 0; i < total; i++) {
        const chapter = book.chapters[i]

        // Serialize inline images
        const serializedImages: SerializedInlineImage[] = []
        for (const img of chapter.inlineImages) {
          const s = await serializeInlineImage(img)
          transferables.push(s.imageData)
          serializedImages.push(s)
        }

        serializedChapters.push({
          title: chapter.title,
          text: chapter.text,
          inlineImages: serializedImages,
        })

        // Chunk text
        const segments = chunkText(chapter.text)
        chunkedChapters.push({
          title: chapter.title,
          text: chapter.text,
          segments,
          inlineImages: serializedImages,
        })

        post({
          type: 'progress',
          id,
          phase: 'chunking',
          percent: Math.round(((i + 1) / total) * 100),
        })
      }
    }

    // Serialize image chapters (CBZ etc)
    const serializedImageChapters: SerializedImageChapter[] = []
    for (const imgChapter of book.imageChapters) {
      const pages = []
      for (const page of imgChapter.pages) {
        const { serialized, buffer } = await serializeImagePage(page)
        transferables.push(buffer)
        pages.push(serialized)
      }
      serializedImageChapters.push({ title: imgChapter.title, pages })
    }

    const result: WorkerResult = {
      book: {
        title: book.title,
        author: book.author,
        contentType: book.contentType,
        chapters: serializedChapters,
        imageChapters: serializedImageChapters,
      },
      chunkedChapters,
    }

    post({ type: 'done', id, result }, transferables)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Parsing failed'
    post({ type: 'error', id, message })
  }
}

self.onmessage = (e: MessageEvent<ParseRequest>) => {
  if (e.data.type === 'parse') {
    handleParse(e.data)
  }
}
