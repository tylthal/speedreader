/**
 * FictionBook2 (.fb2) parser (PRD §3.1).
 *
 * One ParsedSection per top-level <section> in the source. Section title
 * comes from the FB2 <title>; "Untitled" if absent. Inline images are
 * preserved in the section HTML; the first one becomes the book cover.
 */

import JSZip from 'jszip'
import type { ParsedBook, ParsedSection, ParsedCover, ParsedImage } from './types'

const FB2_NS = 'http://www.gribuser.ru/xml/fictionbook/2.0'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
import { normalizeWhitespace } from './textUtils'

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
}

interface BinaryEntry {
  blob: Blob
  mimeType: string
  /** Stable basename used as both the OPFS filename and the `opfs:{name}` marker. */
  name: string
}

function base64ToBlob(b64: string, mimeType: string): Blob {
  const binary = atob(b64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
}

function extractBinaries(root: Document): { byHref: Map<string, BinaryEntry>; images: ParsedImage[] } {
  const byHref = new Map<string, BinaryEntry>()
  const images: ParsedImage[] = []
  const binaryEls = root.getElementsByTagNameNS(FB2_NS, 'binary')
  for (const el of Array.from(binaryEls)) {
    const id = el.getAttribute('id') ?? ''
    const contentType = el.getAttribute('content-type') ?? 'image/jpeg'
    const dataB64 = el.textContent
    if (!id || !dataB64) continue
    const blob = base64ToBlob(dataB64, contentType)
    if (!blob.size) continue
    // Use the FB2 binary id as the OPFS basename, with a sensible extension.
    const ext = EXT_BY_MIME[contentType] ?? '.bin'
    const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '_')
    const name = safeId.includes('.') ? safeId : `${safeId}${ext}`
    const entry: BinaryEntry = { blob, mimeType: contentType, name }
    byHref.set(id, entry)
    byHref.set(`#${id}`, entry)
    images.push({ name, blob, mimeType: contentType })
  }
  return { byHref, images }
}

function getSectionTitle(section: Element): string {
  const titleEl = section.getElementsByTagNameNS(FB2_NS, 'title')[0]
  if (!titleEl) return ''
  const parts: string[] = []
  for (const p of Array.from(titleEl.getElementsByTagNameNS(FB2_NS, 'p'))) {
    const t = p.textContent?.trim()
    if (t) parts.push(t)
  }
  const joined = normalizeWhitespace(parts.join(' '))
  return joined || normalizeWhitespace(titleEl.textContent ?? '')
}

/** Recursively serialize an FB2 element into sanitized HTML. */
function elementToHtml(el: Element, binaries: Map<string, BinaryEntry>): string {
  const local = el.localName
  if (local === 'binary') return ''

  if (local === 'image') {
    const href =
      el.getAttributeNS(XLINK_NS, 'href') ??
      el.getAttribute('href') ??
      ''
    const entry = binaries.get(href)
    if (!entry) return ''
    return `<img src="opfs:${entry.name}" alt="" />`
  }

  // FB2 → HTML mapping
  let tag: string | null
  switch (local) {
    case 'p':
    case 'cite':
    case 'epigraph':
      tag = 'p'
      break
    case 'emphasis':
      tag = 'em'
      break
    case 'strong':
      tag = 'strong'
      break
    case 'subtitle':
      tag = 'h3'
      break
    case 'title':
      tag = 'h2'
      break
    case 'poem':
    case 'stanza':
      tag = 'blockquote'
      break
    case 'v':
      tag = 'p'
      break
    default:
      // Unknown — unwrap children
      tag = null
  }

  let inner = ''
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      inner += escapeHtml(node.textContent ?? '')
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      inner += elementToHtml(node as Element, binaries)
    }
  }

  if (!tag) return inner
  return `<${tag}>${inner}</${tag}>`
}

function elementToText(el: Element, binaries: Map<string, BinaryEntry>): string {
  if (el.localName === 'binary') return ''
  if (el.localName === 'image') return ''
  void binaries
  const parts: string[] = []
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '')
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      parts.push(elementToText(node as Element, binaries))
    }
  }
  return parts.join(' ')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function parseFb2(data: ArrayBuffer, filename?: string): Promise<ParsedBook> {
  let xmlData: ArrayBuffer = data
  const fn = (filename ?? '').toLowerCase()
  if (fn.endsWith('.fb2.zip') || fn.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(data)
    const fb2File = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith('.fb2'))
    if (!fb2File) throw new Error('No .fb2 file found inside the ZIP archive.')
    xmlData = await zip.files[fb2File].async('arraybuffer')
  }

  const xmlText = new TextDecoder('utf-8').decode(xmlData)
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  const parseError = doc.querySelector('parsererror')
  if (parseError) throw new Error(`Invalid FB2 XML: ${parseError.textContent}`)

  // Metadata
  let title = 'Untitled'
  let author = 'Unknown Author'
  const bookTitle = doc.getElementsByTagNameNS(FB2_NS, 'book-title')[0]
  if (bookTitle?.textContent?.trim()) title = bookTitle.textContent.trim()
  const authorEl = doc.getElementsByTagNameNS(FB2_NS, 'author')[0]
  if (authorEl) {
    const first = authorEl.getElementsByTagNameNS(FB2_NS, 'first-name')[0]
    const last = authorEl.getElementsByTagNameNS(FB2_NS, 'last-name')[0]
    const parts: string[] = []
    if (first?.textContent?.trim()) parts.push(first.textContent.trim())
    if (last?.textContent?.trim()) parts.push(last.textContent.trim())
    if (parts.length) author = parts.join(' ')
  }

  const { byHref: binaries, images: parsedImages } = extractBinaries(doc)

  // Cover: try <coverpage> first, then first available binary.
  let cover: ParsedCover | undefined
  const coverpage = doc.getElementsByTagNameNS(FB2_NS, 'coverpage')[0]
  if (coverpage) {
    const img = coverpage.getElementsByTagNameNS(FB2_NS, 'image')[0]
    if (img) {
      const href =
        img.getAttributeNS(XLINK_NS, 'href') ?? img.getAttribute('href') ?? ''
      const entry = binaries.get(href)
      if (entry) cover = { blob: entry.blob, mimeType: entry.mimeType }
    }
  }
  if (!cover && parsedImages.length) {
    cover = { blob: parsedImages[0].blob, mimeType: parsedImages[0].mimeType }
  }

  // Body sections
  const body = doc.getElementsByTagNameNS(FB2_NS, 'body')[0]
  const sections: ParsedSection[] = []
  if (body) {
    const topSections = Array.from(
      body.getElementsByTagNameNS(FB2_NS, 'section'),
    ).filter((s) => s.parentElement === body)

    if (!topSections.length) {
      const text = normalizeWhitespace(elementToText(body, binaries))
      const html = elementToHtml(body, binaries)
      sections.push({ title: 'Untitled', text, html })
    } else {
      for (const sec of topSections) {
        const sectionTitle = getSectionTitle(sec) || 'Untitled'
        const text = normalizeWhitespace(elementToText(sec, binaries))
        const html = elementToHtml(sec, binaries)
        sections.push({ title: sectionTitle, text, html })
      }
    }
  }

  return {
    title,
    author,
    contentType: 'text',
    sections,
    cover,
    parsedImages,
  }
}
