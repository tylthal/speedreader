/**
 * PDF parser (PRD §3.1).
 *
 *  - One section per *top-level* outline entry. We do not flatten nested
 *    outlines into more sections; nested entries are emitted as a hierarchical
 *    TOC tree for the sidebar (PRD §6.4).
 *  - If the PDF has no outline, the entire document becomes a single section
 *    titled with the PDF metadata title (or filename).
 *  - The cover is page 1 rendered to a canvas at thumbnail size.
 *  - PDFs render via pdf.js on the original file in formatted view, so the
 *    section's `html` field stays empty; the page range goes into `meta`.
 */

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import PdfWorker from '../workers/pdfWorker.ts?worker'
import type { ParsedBook, ParsedSection, ParsedCover, TocNode } from './types'

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()

import { normalizeWhitespace } from './textUtils'

const BLANK_LINES_RE = /\n{3,}/g

function normalizeText(text: string): string {
  text = text.replace(BLANK_LINES_RE, '\n\n')
  return text
    .split('\n')
    .map((line) => normalizeWhitespace(line))
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

interface OutlineLeaf {
  title: string
  pageIndex: number
}

/** Resolve only top-level outline entries to (title, pageIndex) pairs. */
async function resolveTopLevelOutline(
  doc: pdfjsLib.PDFDocumentProxy,
): Promise<OutlineLeaf[]> {
  const outline = await doc.getOutline()
  if (!outline?.length) return []

  const out: OutlineLeaf[] = []
  for (const item of outline) {
    if (!item.dest) continue
    try {
      let dest: unknown = item.dest
      if (typeof dest === 'string') dest = await doc.getDestination(dest)
      if (Array.isArray(dest) && dest.length) {
        const ref = dest[0]
        const pageIndex = await doc.getPageIndex(ref)
        out.push({ title: (item.title ?? '').trim() || 'Untitled', pageIndex })
      }
    } catch {
      // skip unresolvable destinations
    }
  }
  return out
}

/** Walk the full outline tree (including nested children) into a TocNode tree. */
async function buildTocTree(
  doc: pdfjsLib.PDFDocumentProxy,
  topLeaves: OutlineLeaf[],
): Promise<TocNode[]> {
  const outline = await doc.getOutline()
  if (!outline?.length) return []

  // Map a (title, pageIndex) tuple back to its index in topLeaves so children
  // can reference the section index correctly.
  const findSectionIdx = (title: string, pageIndex: number): number => {
    return topLeaves.findIndex((l) => l.title === title && l.pageIndex === pageIndex)
  }

  async function walk(items: typeof outline, isTop: boolean): Promise<TocNode[]> {
    const nodes: TocNode[] = []
    for (const item of items) {
      let pageIndex = -1
      if (item.dest) {
        try {
          let dest: unknown = item.dest
          if (typeof dest === 'string') dest = await doc.getDestination(dest)
          if (Array.isArray(dest) && dest.length) {
            pageIndex = await doc.getPageIndex(dest[0])
          }
        } catch {
          /* ignore */
        }
      }
      const title = (item.title ?? '').trim() || 'Untitled'
      const sectionIndex = isTop ? findSectionIdx(title, pageIndex) : -1
      const children = item.items?.length ? await walk(item.items, false) : undefined
      nodes.push({ title, sectionIndex, children })
    }
    return nodes
  }

  return walk(outline, true)
}

async function renderPageToBlob(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
  maxWidth = 600,
): Promise<{ blob: Blob; mimeType: string } | null> {
  try {
    const page = await doc.getPage(pageNum)
    const baseViewport = page.getViewport({ scale: 1 })
    const scale = Math.min(maxWidth / baseViewport.width, 2)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    await page.render({ canvasContext: ctx, viewport, canvas } as any).promise
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85),
    )
    if (!blob) return null
    return { blob, mimeType: 'image/jpeg' }
  } catch {
    return null
  }
}

export async function parsePdf(
  data: ArrayBuffer,
  onProgress?: (percent: number) => void,
): Promise<ParsedBook> {
  const doc = await pdfjsLib.getDocument({ data }).promise

  const meta = await doc.getMetadata()
  const info = (meta?.info as Record<string, string>) ?? {}
  const title = info.Title?.trim() || 'Untitled'
  const author = info.Author?.trim() || 'Unknown Author'

  // Page texts (still needed for plain-text view).
  const pageTexts: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    pageTexts.push(await extractPageText(page))
    onProgress?.(Math.round((i / doc.numPages) * 70))
  }

  const topLeaves = await resolveTopLevelOutline(doc)
  const sections: ParsedSection[] = []

  if (topLeaves.length) {
    for (let i = 0; i < topLeaves.length; i++) {
      const { title: entryTitle, pageIndex: startPage } = topLeaves[i]
      const endPage = i + 1 < topLeaves.length ? topLeaves[i + 1].pageIndex : pageTexts.length
      const parts: string[] = []
      for (let p = startPage; p < endPage && p < pageTexts.length; p++) {
        parts.push(pageTexts[p])
      }
      sections.push({
        title: entryTitle || 'Untitled',
        text: parts.join('\n\n').trim(),
        html: '',
        meta: { startPage, endPage },
      })
    }
  } else {
    // PRD §3.1 — no outline → one section, name from PDF metadata title.
    sections.push({
      title: title || 'Untitled',
      text: pageTexts.join('\n\n').trim(),
      html: '',
      meta: { startPage: 0, endPage: pageTexts.length },
    })
  }

  const tocTree = topLeaves.length ? await buildTocTree(doc, topLeaves) : undefined

  // Cover: render page 1 (PRD §3.4).
  let cover: ParsedCover | undefined
  if (doc.numPages > 0) {
    onProgress?.(85)
    const rendered = await renderPageToBlob(doc, 1)
    if (rendered) cover = rendered
  }

  onProgress?.(100)
  doc.destroy()

  return {
    title,
    author,
    contentType: 'text',
    sections,
    cover,
    tocTree,
  }
}
