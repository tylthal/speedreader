/**
 * Web Worker that runs file parsing + section chunking off the main thread.
 *
 * Note: this worker is currently not invoked — runParse() in localClient.ts
 * always uses the main-thread fallback because Safari/WebKit doesn't expose
 * DOMParser in workers. The protocol is kept in lock-step with the
 * main-thread implementation so we can re-enable workers if Safari ships the
 * fix.
 */

import { parseFile } from '../parsers'
import { chunkSections } from '../parsers/chunker'
import type { ParsedBook, ImagePage, ParsedCover } from '../parsers/types'
import type {
  ParseRequest,
  WorkerOutMessage,
  SerializedCover,
  SerializedImagePage,
  SerializedSection,
  SerializedTocNode,
  ChunkedSection,
  WorkerResult,
} from './parserProtocol'

function post(msg: WorkerOutMessage, transfer?: Transferable[]) {
  self.postMessage(msg, { transfer: transfer ?? [] })
}

async function serializeCover(cover: ParsedCover): Promise<{ serialized: SerializedCover; buffer: ArrayBuffer }> {
  const buf = await cover.blob.arrayBuffer()
  return { serialized: { imageData: buf, mimeType: cover.mimeType }, buffer: buf }
}

async function serializeImagePage(page: ImagePage): Promise<{ serialized: SerializedImagePage; buffer: ArrayBuffer }> {
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
    post({ type: 'progress', id, phase: 'parsing', percent: 0 })
    const book: ParsedBook = await parseFile(data, filename)
    post({ type: 'progress', id, phase: 'parsing', percent: 100 })

    const transferables: ArrayBuffer[] = []

    let cover: SerializedCover | undefined
    if (book.cover) {
      const { serialized, buffer } = await serializeCover(book.cover)
      cover = serialized
      transferables.push(buffer)
    }

    let imagePages: SerializedImagePage[] | undefined
    if (book.imagePages?.length) {
      imagePages = []
      for (const page of book.imagePages) {
        const { serialized, buffer } = await serializeImagePage(page)
        imagePages.push(serialized)
        transferables.push(buffer)
      }
    }

    const sections: SerializedSection[] = book.sections.map((s) => ({
      title: s.title,
      text: s.text,
      html: s.html,
      meta: s.meta,
    }))

    post({ type: 'progress', id, phase: 'chunking', percent: 0 })
    const chunked = chunkSections(book.sections)
    const chunkedSections: ChunkedSection[] = chunked.map((c) => ({
      title: c.title,
      text: c.text,
      html: c.html,
      meta: c.meta,
      segments: c.segments,
    }))
    post({ type: 'progress', id, phase: 'chunking', percent: 100 })

    const tocTree: SerializedTocNode[] | undefined = book.tocTree?.map(function map(n): SerializedTocNode {
      return {
        title: n.title,
        sectionIndex: n.sectionIndex,
        htmlAnchor: n.htmlAnchor ?? null,
        children: n.children?.map(map),
      }
    })

    const result: WorkerResult = {
      book: {
        title: book.title,
        author: book.author,
        contentType: book.contentType,
        sections,
        cover,
        tocTree,
        imagePages,
      },
      chunkedSections,
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
