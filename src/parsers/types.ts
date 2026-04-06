/**
 * Shared types for client-side ebook parsers.
 * Mirrors backend/parser_types.py.
 */

export type ContentType = 'text' | 'image'

export interface InlineImage {
  placeholder: string   // "{{IMG_0}}"
  blob: Blob            // raw image data
  alt: string
  width: number
  height: number
  mimeType: string
}

export interface ParsedChapter {
  title: string
  text: string
  inlineImages: InlineImage[]
}

export interface ImagePage {
  pageIndex: number
  blob: Blob
  width: number
  height: number
  mimeType: string
}

export interface ParsedImageChapter {
  title: string
  pages: ImagePage[]
}

export interface ParsedBook {
  title: string
  author: string
  contentType: ContentType
  chapters: ParsedChapter[]
  imageChapters: ParsedImageChapter[]
}

/**
 * Get image dimensions by decoding the blob header.
 * Works in both main thread and Web Workers.
 */
export async function getImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  try {
    const bmp = await createImageBitmap(blob)
    const { width, height } = bmp
    bmp.close()
    return { width, height }
  } catch {
    return { width: 0, height: 0 }
  }
}

const EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
}

export function getExtForMime(mime: string): string {
  return EXT_MAP[mime] ?? '.jpg'
}
