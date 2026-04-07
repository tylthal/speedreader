/**
 * PDF parser. Port of backend/pdf_parser.py.
 * Uses pdfjs-dist (Mozilla's pdf.js).
 *
 * Note: pdf.js does not expose per-image extraction like PyMuPDF,
 * so inline image extraction is skipped in this port.
 * Text extraction works fully.
 */

import * as pdfjsLib from 'pdfjs-dist'
import type { ParsedBook, ParsedChapter } from './types'

// Use Vite's static asset handling for the pdf.js worker.
// new URL(..., import.meta.url) is transformed by Vite to a correct asset URL.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href

const WHITESPACE_RE = /\s+/g
const BLANK_LINES_RE = /\n{3,}/g
const MIN_PAGE_TEXT_LENGTH = 50
const PAGES_PER_FALLBACK_CHAPTER = 10

function normalizeText(text: string): string {
  text = text.replace(BLANK_LINES_RE, '\n\n')
  return text
    .split('\n')
    .map((line) => line.replace(WHITESPACE_RE, ' ').trim())
    .join('\n')
    .trim()
}

async function extractPageText(page: pdfjsLib.PDFPageProxy): Promise<string> {
  const content = await page.getTextContent()
  const raw = content.items
    .map((item) => ('str' in item ? item.str : ''))
    .join(' ')
  return normalizeText(raw)
}

interface OutlineEntry {
  title: string
  pageIndex: number
}

async function resolveOutline(
  doc: pdfjsLib.PDFDocumentProxy,
): Promise<OutlineEntry[]> {
  const outline = await doc.getOutline()
  if (!outline?.length) return []

  const entries: OutlineEntry[] = []

  async function walk(items: typeof outline) {
    for (const item of items) {
      if (item.dest) {
        try {
          let dest: unknown = item.dest
          if (typeof dest === 'string') {
            dest = await doc.getDestination(dest)
          }
          if (Array.isArray(dest) && dest.length) {
            const ref = dest[0]
            const pageIndex = await doc.getPageIndex(ref)
            entries.push({ title: item.title.trim(), pageIndex })
          }
        } catch {
          // Skip unresolvable destinations
        }
      }
      if (item.items?.length) {
        await walk(item.items)
      }
    }
  }

  await walk(outline)
  return entries
}

export async function parsePdf(
  data: ArrayBuffer,
  onProgress?: (percent: number) => void,
): Promise<ParsedBook> {
  const doc = await pdfjsLib.getDocument({ data }).promise

  // Metadata
  const meta = await doc.getMetadata()
  const info = (meta?.info as Record<string, string>) ?? {}
  const title = info.Title?.trim() || 'Untitled'
  const author = info.Author?.trim() || 'Unknown Author'

  // Extract text per page
  const pageTexts: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const text = await extractPageText(page)
    pageTexts.push(text)
    onProgress?.(Math.round((i / doc.numPages) * 80))
  }

  // Resolve TOC
  const toc = await resolveOutline(doc)
  const chapters: ParsedChapter[] = []

  if (toc.length) {
    for (let i = 0; i < toc.length; i++) {
      const { title: entryTitle, pageIndex: startPage } = toc[i]
      const endPage = i + 1 < toc.length ? toc[i + 1].pageIndex : pageTexts.length

      const parts: string[] = []
      for (let p = startPage; p < endPage && p < pageTexts.length; p++) {
        if (pageTexts[p].length >= MIN_PAGE_TEXT_LENGTH) {
          parts.push(pageTexts[p])
        }
      }

      const combined = parts.join('\n\n').trim()
      if (combined.length < MIN_PAGE_TEXT_LENGTH) continue

      chapters.push({
        title: entryTitle || `Chapter ${chapters.length + 1}`,
        text: combined,
        inlineImages: [],
      })
    }
  } else {
    // No TOC — group by page count
    const meaningfulPages = pageTexts
      .map((text, idx) => ({ idx, text }))
      .filter((p) => p.text.length >= MIN_PAGE_TEXT_LENGTH)

    if (meaningfulPages.length < 20) {
      for (let i = 0; i < meaningfulPages.length; i++) {
        chapters.push({
          title: `Section ${i + 1}`,
          text: meaningfulPages[i].text,
          inlineImages: [],
        })
      }
    } else {
      const chunkTexts: string[] = []
      let chapterCounter = 0
      for (let i = 0; i < meaningfulPages.length; i++) {
        chunkTexts.push(meaningfulPages[i].text)
        if (chunkTexts.length >= PAGES_PER_FALLBACK_CHAPTER || i === meaningfulPages.length - 1) {
          const combined = chunkTexts.join('\n\n').trim()
          if (combined.length >= MIN_PAGE_TEXT_LENGTH) {
            chapterCounter++
            chapters.push({
              title: `Chapter ${chapterCounter}`,
              text: combined,
              inlineImages: [],
            })
          }
          chunkTexts.length = 0
        }
      }
    }
  }

  onProgress?.(100)
  doc.destroy()

  return { title, author, contentType: 'text', chapters, imageChapters: [] }
}
