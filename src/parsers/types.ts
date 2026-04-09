import type { InternalTocNode } from '../lib/tocTree'

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

export interface ImagePage {
  pageIndex: number
  blob: Blob
  width: number
  height: number
  mimeType: string
}

// ---------------------------------------------------------------------------
// Reader redesign content model (PRD §7)
// ---------------------------------------------------------------------------

export interface ParsedSection {
  /** PRD §3.2 — never auto-numbered. May be the literal "Untitled". */
  title: string
  /** Flat plain-text representation for the chunker. */
  text: string
  /** Sanitized HTML for formatted view. Empty string for PDF/CBZ. */
  html: string
  /** Format-specific metadata (e.g. PDF page range). */
  meta?: Record<string, unknown>
}

export interface ParsedCover {
  blob: Blob
  mimeType: string
}

export type TocNode = InternalTocNode

/**
 * An image referenced by section HTML. The section HTML uses
 * `<img src="opfs:{name}">` markers; uploadBook persists each entry to OPFS
 * at `/images/{pubId}/{name}`, and FormattedView resolves the `opfs:` srcs
 * to fresh blob URLs at render time. This keeps images valid across reloads
 * (URL.createObjectURL handles are session-bound).
 */
export interface ParsedImage {
  /** Basename used both as the OPFS filename and the `opfs:{name}` marker. */
  name: string
  blob: Blob
  mimeType: string
}

export interface ParsedBook {
  title: string
  author: string
  contentType: ContentType
  /** PRD §3.1 — ordered list of sections derived from the source. */
  sections: ParsedSection[]
  /** Cover image extracted at parse time (PRD §3.4). */
  cover?: ParsedCover
  /** Hierarchical TOC for the sidebar (PRD §6.4). Falsy = use sections list. */
  tocTree?: TocNode[]
  /**
   * For image-format books (CBZ): the ordered list of page images. Sections
   * still exists with one entry whose text/html are empty; this sidecar
   * carries the page bitmaps. The reader treats one segment per page.
   */
  imagePages?: ImagePage[]
  /**
   * Inline images referenced by section HTML via `<img src="opfs:{name}">`.
   * Persisted to OPFS at upload time so the URLs survive page reloads.
   */
  parsedImages?: ParsedImage[]
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
