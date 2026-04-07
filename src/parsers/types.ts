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

// ---------------------------------------------------------------------------
// New shape (PRD §7) — populated by P2-rewritten parsers.
// During P1 the legacy `chapters`/`imageChapters` fields are still required
// so the old parsers continue to compile. P2 will flip every parser to emit
// `sections` and these legacy fields will be removed.
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

export interface TocNode {
  title: string
  /** Index into ParsedBook.sections. -1 for display-only parent groupings. */
  sectionIndex: number
  children?: TocNode[]
}

export interface ParsedBook {
  title: string
  author: string
  contentType: ContentType
  chapters: ParsedChapter[]
  imageChapters: ParsedImageChapter[]
  // --- Reader redesign additions (P2 will populate these) ---
  sections?: ParsedSection[]
  cover?: ParsedCover
  /** Hierarchical TOC for the sidebar (PRD §6.4). Flat list if absent. */
  tocTree?: TocNode[]
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
