import { cloneTocTree } from '../lib/tocTree'
import { chunkSections } from '../parsers/chunker'
import type { ImagePage, ParsedBook, ParsedCover, ParsedImage } from '../parsers/types'
import type {
  ChunkedSection,
  SerializedCover,
  SerializedImagePage,
  SerializedParsedImage,
  SerializedSection,
  WorkerResult,
} from './parserProtocol'

async function serializeCover(
  cover: ParsedCover,
): Promise<{ serialized: SerializedCover; buffer: ArrayBuffer }> {
  const buffer = await cover.blob.arrayBuffer()
  return {
    serialized: { imageData: buffer, mimeType: cover.mimeType },
    buffer,
  }
}

async function serializeImagePage(
  page: ImagePage,
): Promise<{ serialized: SerializedImagePage; buffer: ArrayBuffer }> {
  const buffer = await page.blob.arrayBuffer()
  return {
    serialized: {
      pageIndex: page.pageIndex,
      imageData: buffer,
      width: page.width,
      height: page.height,
      mimeType: page.mimeType,
    },
    buffer,
  }
}

async function serializeParsedImage(
  image: ParsedImage,
): Promise<{ serialized: SerializedParsedImage; buffer: ArrayBuffer }> {
  const buffer = await image.blob.arrayBuffer()
  return {
    serialized: {
      name: image.name,
      imageData: buffer,
      mimeType: image.mimeType,
    },
    buffer,
  }
}

export async function buildWorkerResult(
  book: ParsedBook,
): Promise<{ result: WorkerResult; transferables: ArrayBuffer[] }> {
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

  let parsedImages: SerializedParsedImage[] | undefined
  if (book.parsedImages?.length) {
    parsedImages = []
    for (const image of book.parsedImages) {
      const { serialized, buffer } = await serializeParsedImage(image)
      parsedImages.push(serialized)
      transferables.push(buffer)
    }
  }

  const sections: SerializedSection[] = book.sections.map((section) => ({
    title: section.title,
    text: section.text,
    html: section.html,
    meta: section.meta,
  }))

  const chunkedSections: ChunkedSection[] = chunkSections(book.sections).map((section) => ({
    title: section.title,
    text: section.text,
    html: section.html,
    meta: section.meta,
    segments: section.segments,
  }))

  return {
    result: {
      book: {
        title: book.title,
        author: book.author,
        contentType: book.contentType,
        sections,
        cover,
        tocTree: cloneTocTree(book.tocTree),
        imagePages,
        parsedImages,
      },
      chunkedSections,
    },
    transferables,
  }
}
