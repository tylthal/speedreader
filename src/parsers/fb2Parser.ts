/**
 * FictionBook2 (.fb2) parser. Port of backend/fb2_parser.py.
 * Uses DOMParser for XML + JSZip for .fb2.zip files.
 */

import JSZip from 'jszip'
import type { ParsedBook, ParsedChapter, InlineImage } from './types'
import { getImageDimensions } from './types'

const FB2_NS = 'http://www.gribuser.ru/xml/fictionbook/2.0'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const WHITESPACE_RE = /\s+/g
const MIN_CHAPTER_LENGTH = 50

function base64ToBlob(b64: string, mimeType: string): Blob {
  const binary = atob(b64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
}

async function extractBinaries(
  root: Document,
): Promise<Map<string, InlineImage>> {
  const binaries = new Map<string, InlineImage>()
  let counter = 0

  // DOMParser with XML doesn't handle namespaces in querySelectorAll well,
  // so use getElementsByTagNameNS
  const binaryEls = root.getElementsByTagNameNS(FB2_NS, 'binary')

  for (const el of Array.from(binaryEls)) {
    const binId = el.getAttribute('id') ?? ''
    const contentType = el.getAttribute('content-type') ?? 'image/jpeg'
    const dataB64 = el.textContent
    if (!binId || !dataB64) continue

    const blob = base64ToBlob(dataB64, contentType)
    if (blob.size < 500) continue // skip tiny decorations

    const dims = await getImageDimensions(blob)
    const placeholder = `{{IMG_${counter}}}`

    const img: InlineImage = {
      placeholder,
      blob,
      alt: '',
      width: dims.width,
      height: dims.height,
      mimeType: contentType,
    }

    binaries.set(binId, img)
    binaries.set(`#${binId}`, img)
    counter++
  }

  return binaries
}

function getTextWithImages(
  el: Element,
  binaries: Map<string, InlineImage>,
  collected: InlineImage[],
): string {
  if (el.localName === 'binary') return ''

  if (el.localName === 'image') {
    const href = el.getAttributeNS(XLINK_NS, 'href') ?? el.getAttribute('href') ?? ''
    if (href && binaries.has(href)) {
      const img = binaries.get(href)!
      if (!collected.includes(img)) collected.push(img)
      return ` ${img.placeholder} `
    }
    return ''
  }

  const parts: string[] = []
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '')
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      parts.push(getTextWithImages(node as Element, binaries, collected))
    }
  }
  return parts.join(' ')
}

function extractSectionTitle(section: Element): string {
  const titleEl = section.getElementsByTagNameNS(FB2_NS, 'title')[0]
  if (!titleEl) return ''

  const parts: string[] = []
  const pEls = titleEl.getElementsByTagNameNS(FB2_NS, 'p')
  for (const p of Array.from(pEls)) {
    const t = p.textContent?.trim()
    if (t) parts.push(t)
  }
  const result = parts.join(' ').replace(WHITESPACE_RE, ' ').trim()
  if (result) return result

  return (titleEl.textContent ?? '').replace(WHITESPACE_RE, ' ').trim()
}

function parseSections(
  body: Element,
  binaries: Map<string, InlineImage>,
): ParsedChapter[] {
  const chapters: ParsedChapter[] = []
  const sections = body.getElementsByTagNameNS(FB2_NS, 'section')

  // Only top-level sections (direct children of body)
  const topSections = Array.from(sections).filter((s) => s.parentElement === body)

  if (!topSections.length) {
    const collected: InlineImage[] = []
    const text = getTextWithImages(body, binaries, collected).replace(WHITESPACE_RE, ' ').trim()
    if (text.length >= MIN_CHAPTER_LENGTH) {
      chapters.push({ title: 'Chapter 1', text, inlineImages: collected })
    }
    return chapters
  }

  for (let i = 0; i < topSections.length; i++) {
    const section = topSections[i]
    const title = extractSectionTitle(section) || `Chapter ${i + 1}`

    // Check for subsections
    const subsections = Array.from(
      section.getElementsByTagNameNS(FB2_NS, 'section'),
    ).filter((s) => s.parentElement === section)

    if (subsections.length) {
      for (let j = 0; j < subsections.length; j++) {
        const sub = subsections[j]
        const subTitle = extractSectionTitle(sub)
        const collected: InlineImage[] = []
        const subText = getTextWithImages(sub, binaries, collected).replace(WHITESPACE_RE, ' ').trim()
        if (subText.length >= MIN_CHAPTER_LENGTH) {
          const fullTitle = subTitle ? `${title} - ${subTitle}` : `${title} (${j + 1})`
          chapters.push({ title: fullTitle, text: subText, inlineImages: collected })
        }
      }
    } else {
      const collected: InlineImage[] = []
      const text = getTextWithImages(section, binaries, collected).replace(WHITESPACE_RE, ' ').trim()
      if (text.length >= MIN_CHAPTER_LENGTH) {
        chapters.push({ title, text, inlineImages: collected })
      }
    }
  }

  return chapters
}

export async function parseFb2(data: ArrayBuffer, filename?: string): Promise<ParsedBook> {
  let xmlData: ArrayBuffer = data

  // Handle .fb2.zip
  const fn = (filename ?? '').toLowerCase()
  if (fn.endsWith('.fb2.zip') || fn.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(data)
    const fb2File = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith('.fb2'))
    if (!fb2File) throw new Error('No .fb2 file found inside the ZIP archive.')
    xmlData = await zip.files[fb2File].async('arraybuffer')
  }

  const xmlText = new TextDecoder('utf-8').decode(xmlData)
  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlText, 'application/xml')

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

  // Extract binary images
  const binaries = await extractBinaries(doc)

  // Parse body sections
  const body = doc.getElementsByTagNameNS(FB2_NS, 'body')[0]
  if (!body) return { title, author, contentType: 'text', chapters: [], imageChapters: [] }

  const chapters = parseSections(body, binaries)

  return { title, author, contentType: 'text', chapters, imageChapters: [] }
}
