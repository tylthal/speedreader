/**
 * EPUB parser. Port of backend/epub_parser.py.
 * Uses JSZip for ZIP extraction + DOMParser for XHTML/XML.
 *
 * Multi-strategy chapter detection:
 * 1. TOC fragment-based splitting
 * 2. Spine-based iteration with TOC title enrichment
 * 3. Heading-based splitting for large single-file books
 */

import JSZip from 'jszip'
import type { ParsedBook, ParsedChapter, InlineImage } from './types'
import { getImageDimensions } from './types'

const WHITESPACE_RE = /\s+/g
const HEADING_TAGS = new Set(['H1', 'H2', 'H3'])
const MIN_CHAPTER_LENGTH = 50
const LARGE_CHAPTER_THRESHOLD = 5000

const SKIP_PATTERNS = /^(copyright|copy right|contents|table of contents|title\s*page|half\s*title|cover|colophon|dedication|also\s+by|other\s+books|about\s+the\s+author|acknowledgment|imprint|books?\s+by|praise\s+for|endorsement|blurb)s?\s*$/i
const TITLE_ONLY = /^title$/i

// ---------------------------------------------------------------------------
// EPUB structure helpers
// ---------------------------------------------------------------------------

interface ManifestItem {
  id: string
  href: string
  mediaType: string
}

interface TocEntry {
  filename: string
  fragment: string
  title: string
}

function resolvePath(base: string, relative: string): string {
  if (relative.startsWith('/')) return relative.slice(1)
  const baseParts = base.split('/')
  baseParts.pop() // remove filename
  const relParts = relative.split('/')
  for (const part of relParts) {
    if (part === '..') baseParts.pop()
    else if (part !== '.') baseParts.push(part)
  }
  return baseParts.join('/')
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(0, i) : ''
}

async function readContainerXml(zip: JSZip): Promise<string> {
  const containerXml = await zip.file('META-INF/container.xml')?.async('text')
  if (!containerXml) throw new Error('Missing META-INF/container.xml')
  const doc = new DOMParser().parseFromString(containerXml, 'application/xml')
  const rootfile = doc.querySelector('rootfile')
  const path = rootfile?.getAttribute('full-path')
  if (!path) throw new Error('Cannot find OPF path in container.xml')
  return path
}

function parseOpfMetadata(opfDoc: Document): { title: string; author: string } {
  const dcNs = 'http://purl.org/dc/elements/1.1/'
  const titleEl = opfDoc.getElementsByTagNameNS(dcNs, 'title')[0]
  const creatorEl = opfDoc.getElementsByTagNameNS(dcNs, 'creator')[0]
  return {
    title: titleEl?.textContent?.trim() || 'Untitled',
    author: creatorEl?.textContent?.trim() || 'Unknown Author',
  }
}

function parseOpfManifest(opfDoc: Document, opfDir: string): Map<string, ManifestItem> {
  const manifest = new Map<string, ManifestItem>()
  const items = opfDoc.querySelectorAll('manifest > item')
  for (const item of Array.from(items)) {
    const id = item.getAttribute('id') ?? ''
    const href = item.getAttribute('href') ?? ''
    const mediaType = item.getAttribute('media-type') ?? ''
    const fullHref = opfDir ? `${opfDir}/${href}` : href
    manifest.set(id, { id, href: fullHref, mediaType })
  }
  return manifest
}

function parseOpfSpine(opfDoc: Document): { id: string; linear: string }[] {
  const spine: { id: string; linear: string }[] = []
  const itemRefs = opfDoc.querySelectorAll('spine > itemref')
  for (const ref of Array.from(itemRefs)) {
    spine.push({
      id: ref.getAttribute('idref') ?? '',
      linear: ref.getAttribute('linear') ?? 'yes',
    })
  }
  return spine
}

function parseToc(
  tocDoc: Document,
  tocHref: string,
  isNcx: boolean,
): TocEntry[] {
  const entries: TocEntry[] = []
  const tocDir = dirname(tocHref)

  if (isNcx) {
    // NCX format: <navPoint><navLabel><text>, <content src="..."/>
    const navPoints = tocDoc.querySelectorAll('navPoint')
    for (const np of Array.from(navPoints)) {
      const text = np.querySelector('navLabel > text')?.textContent?.trim()
      const src = np.querySelector('content')?.getAttribute('src') ?? ''
      if (!text || !src) continue
      const parts = src.split('#')
      const filename = tocDir ? resolvePath(tocHref, parts[0]) : parts[0]
      entries.push({ filename, fragment: parts[1] ?? '', title: text })
    }
  } else {
    // Nav XHTML: <nav epub:type="toc"> <a href="...">
    const links = tocDoc.querySelectorAll('nav a, nav[*|type="toc"] a')
    for (const a of Array.from(links)) {
      const href = a.getAttribute('href') ?? ''
      const text = a.textContent?.trim()
      if (!text || !href) continue
      const parts = href.split('#')
      const filename = tocDir ? resolvePath(tocHref, parts[0]) : parts[0]
      entries.push({ filename, fragment: parts[1] ?? '', title: text })
    }
  }

  return entries
}

// ---------------------------------------------------------------------------
// Image extraction
// ---------------------------------------------------------------------------

async function buildImageMap(
  zip: JSZip,
  manifest: Map<string, ManifestItem>,
): Promise<Map<string, { blob: Blob; mime: string }>> {
  const imageMap = new Map<string, { blob: Blob; mime: string }>()

  for (const [, item] of manifest) {
    if (!item.mediaType.startsWith('image/')) continue
    const file = zip.file(item.href)
    if (!file) continue
    const data = await file.async('arraybuffer')
    const blob = new Blob([data], { type: item.mediaType })
    imageMap.set(item.href, { blob, mime: item.mediaType })
    // Also store by basename for relative path resolution
    const basename = item.href.split('/').pop()!
    if (!imageMap.has(basename)) {
      imageMap.set(basename, { blob, mime: item.mediaType })
    }
  }

  return imageMap
}

async function replaceImagesWithPlaceholders(
  doc: Document,
  imageMap: Map<string, { blob: Blob; mime: string }>,
  chapterDir: string,
  counterStart: number,
): Promise<{ nextCounter: number; inlineImages: InlineImage[] }> {
  const inlineImages: InlineImage[] = []
  let counter = counterStart

  for (const imgTag of Array.from(doc.querySelectorAll('img'))) {
    const src = imgTag.getAttribute('src') ?? ''
    if (!src) { imgTag.remove(); continue }

    // Resolve path
    const resolved = chapterDir && !src.startsWith('/')
      ? resolvePath(chapterDir + '/dummy', src)
      : src
    const basename = src.split('/').pop()!

    const imgData = imageMap.get(resolved) ?? imageMap.get(basename)
    if (!imgData) { imgTag.remove(); continue }

    const alt = imgTag.getAttribute('alt') ?? ''
    const placeholder = `{{IMG_${counter}}}`
    const dims = await getImageDimensions(imgData.blob)

    inlineImages.push({
      placeholder,
      blob: imgData.blob,
      alt,
      width: dims.width,
      height: dims.height,
      mimeType: imgData.mime,
    })

    const textNode = doc.createTextNode(` ${placeholder} `)
    imgTag.replaceWith(textNode)
    counter++
  }

  return { nextCounter: counter, inlineImages }
}

// ---------------------------------------------------------------------------
// Text extraction and chapter splitting
// ---------------------------------------------------------------------------

function extractText(doc: Document): { title: string | null; text: string } {
  let title: string | null = null
  for (const tag of ['h1', 'h2', 'h3']) {
    const heading = doc.querySelector(tag)
    if (heading?.textContent?.trim()) {
      title = heading.textContent.trim()
      break
    }
  }

  const body = doc.body ?? doc.documentElement
  const rawText = body.textContent ?? ''
  const text = rawText.replace(WHITESPACE_RE, ' ').trim()

  return { title, text }
}

function splitByTocFragments(
  htmlStr: string,
  fragmentEntries: [string, string][],
): ParsedChapter[] {
  const doc = new DOMParser().parseFromString(htmlStr, 'text/html')
  const body = doc.body ?? doc.documentElement
  const fullText = (body.textContent ?? '').replace(WHITESPACE_RE, ' ').trim()
  if (!fullText) return []

  const anchorPositions: { pos: number; title: string }[] = []

  for (const [fragId, title] of fragmentEntries) {
    let el = doc.getElementById(fragId)
    if (!el) el = doc.querySelector(`[name="${fragId}"]`)
    if (!el) continue

    let markerEl: Element = el
    if (!el.textContent?.trim()) {
      let nxt = el.nextElementSibling
      if (nxt) markerEl = nxt
    }

    const markerText = (markerEl.textContent ?? '').replace(WHITESPACE_RE, ' ').trim()
    if (markerText) {
      const searchStart = anchorPositions.length ? anchorPositions[anchorPositions.length - 1].pos + 1 : 0
      let pos = fullText.indexOf(markerText.slice(0, 80), searchStart)
      if (pos === -1) pos = fullText.indexOf(markerText.slice(0, 40), searchStart)
      if (pos >= 0) {
        anchorPositions.push({ pos, title })
      } else {
        const fallbackPos = anchorPositions.length ? anchorPositions[anchorPositions.length - 1].pos + 1 : 0
        const titlePos = fullText.indexOf(title.slice(0, 30), fallbackPos)
        if (titlePos >= 0) {
          anchorPositions.push({ pos: titlePos, title })
        } else if (anchorPositions.length) {
          anchorPositions.push({ pos: fallbackPos, title })
        }
      }
    }
  }

  if (!anchorPositions.length) return []

  const chapters: ParsedChapter[] = []

  // Pre-anchor content
  if (anchorPositions[0].pos > MIN_CHAPTER_LENGTH) {
    const preText = fullText.slice(0, anchorPositions[0].pos).trim()
    if (preText.length >= MIN_CHAPTER_LENGTH) {
      // Find a heading for pre-anchor content
      let preTitle: string | null = null
      for (const tag of ['h1', 'h2', 'h3']) {
        const h = doc.querySelector(tag)
        if (h?.textContent?.trim()) {
          preTitle = h.textContent.trim()
          break
        }
      }
      if (preTitle && !SKIP_PATTERNS.test(preTitle.trim())) {
        chapters.push({ title: preTitle, text: preText, inlineImages: [] })
      }
    }
  }

  for (let i = 0; i < anchorPositions.length; i++) {
    const { pos, title } = anchorPositions[i]
    const endPos = i + 1 < anchorPositions.length ? anchorPositions[i + 1].pos : fullText.length
    const text = fullText.slice(pos, endPos).trim()
    if (text.length >= MIN_CHAPTER_LENGTH) {
      chapters.push({ title, text, inlineImages: [] })
    }
  }

  return chapters
}

function splitByHeadings(htmlStr: string): ParsedChapter[] {
  const doc = new DOMParser().parseFromString(htmlStr, 'text/html')
  const body = doc.body ?? doc.documentElement
  const headings = Array.from(body.querySelectorAll('h1, h2, h3'))

  if (headings.length <= 1) return []

  const chapters: ParsedChapter[] = []

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]
    const title = heading.textContent?.trim() || `Section ${i + 1}`
    const texts: string[] = [heading.textContent ?? '']

    let sibling = heading.nextSibling
    while (sibling) {
      if (sibling instanceof Element) {
        if (HEADING_TAGS.has(sibling.tagName)) break
        if (sibling.querySelector('h1, h2, h3')) break
        texts.push(sibling.textContent ?? '')
      } else if (sibling.textContent) {
        texts.push(sibling.textContent)
      }
      sibling = sibling.nextSibling
    }

    const text = texts.join(' ').replace(WHITESPACE_RE, ' ').trim()
    if (text.length >= MIN_CHAPTER_LENGTH) {
      chapters.push({ title, text, inlineImages: [] })
    }
  }

  return chapters
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export async function parseEpub(data: ArrayBuffer): Promise<ParsedBook> {
  const zip = await JSZip.loadAsync(data)

  // 1. Read container.xml → OPF path
  const opfPath = await readContainerXml(zip)
  const opfDir = dirname(opfPath)
  const opfXml = await zip.file(opfPath)?.async('text')
  if (!opfXml) throw new Error('Cannot read OPF file')
  const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml')

  // 2. Metadata
  const { title, author } = parseOpfMetadata(opfDoc)

  // 3. Manifest + spine
  const manifest = parseOpfManifest(opfDoc, opfDir)
  const spine = parseOpfSpine(opfDoc)

  // 4. Build image map
  const imageMap = await buildImageMap(zip, manifest)

  // 5. Find and parse TOC
  let tocEntries: TocEntry[] = []
  // Find TOC in manifest (NCX or nav)
  for (const [, item] of manifest) {
    if (item.mediaType === 'application/x-dtbncx+xml') {
      const tocXml = await zip.file(item.href)?.async('text')
      if (tocXml) {
        const tocDoc = new DOMParser().parseFromString(tocXml, 'application/xml')
        tocEntries = parseToc(tocDoc, item.href, true)
      }
      break
    }
  }
  if (!tocEntries.length) {
    // Try nav document
    for (const [, item] of manifest) {
      if (item.mediaType === 'application/xhtml+xml') {
        const navXml = await zip.file(item.href)?.async('text')
        if (navXml && navXml.includes('epub:type="toc"')) {
          const navDoc = new DOMParser().parseFromString(navXml, 'text/html')
          tocEntries = parseToc(navDoc, item.href, false)
          if (tocEntries.length) break
        }
      }
    }
  }

  // Group TOC entries by filename
  const tocByFile = new Map<string, [string, string][]>()
  const tocTitleMap = new Map<string, string>()
  for (const entry of tocEntries) {
    if (entry.fragment) {
      const list = tocByFile.get(entry.filename) ?? []
      list.push([entry.fragment, entry.title])
      tocByFile.set(entry.filename, list)
    }
    if (!tocTitleMap.has(entry.filename)) {
      tocTitleMap.set(entry.filename, entry.title)
    }
  }

  // 6. Iterate spine → build chapters
  const chapters: ParsedChapter[] = []
  let chapterCounter = 0
  const processedFiles = new Set<string>()
  let imageCounter = 0

  for (const { id, linear } of spine) {
    if (linear === 'no') continue
    const item = manifest.get(id)
    if (!item || !item.mediaType.includes('html')) continue
    if (processedFiles.has(item.href)) continue
    processedFiles.add(item.href)

    const file = zip.file(item.href)
    if (!file) continue
    const content = await file.async('text')
    if (!content) continue

    const chapterDir = dirname(item.href)

    // Strategy 1: TOC fragment splitting
    const fragmentEntries = tocByFile.get(item.href)
    if (fragmentEntries && fragmentEntries.length > 1) {
      let fragChapters = splitByTocFragments(content, fragmentEntries)
      if (fragChapters.length) {
        fragChapters = fragChapters.filter(
          (ch) => !SKIP_PATTERNS.test(ch.title.trim()) && !TITLE_ONLY.test(ch.title.trim()),
        )
        chapters.push(...fragChapters)
        chapterCounter += fragChapters.length
        continue
      }
    }

    // Parse HTML for text + images
    const htmlDoc = new DOMParser().parseFromString(content, 'text/html')
    const imgResult = await replaceImagesWithPlaceholders(
      htmlDoc, imageMap, chapterDir, imageCounter,
    )
    imageCounter = imgResult.nextCounter
    const { title: headingTitle, text } = extractText(htmlDoc)

    if (text.length < MIN_CHAPTER_LENGTH) continue

    // Strategy 3: Large file → heading-based split
    if (text.length > LARGE_CHAPTER_THRESHOLD && !fragmentEntries) {
      let headingChapters = splitByHeadings(content)
      if (headingChapters.length) {
        headingChapters = headingChapters.filter(
          (ch) => !SKIP_PATTERNS.test(ch.title.trim()) && !TITLE_ONLY.test(ch.title.trim()),
        )
        chapters.push(...headingChapters)
        chapterCounter += headingChapters.length
        continue
      }
    }

    // Strategy 2: Single chapter from this file
    chapterCounter++
    const tocTitle = tocTitleMap.get(item.href)
    const finalTitle = tocTitle ?? headingTitle ?? `Chapter ${chapterCounter}`

    if (SKIP_PATTERNS.test(finalTitle.trim()) || TITLE_ONLY.test(finalTitle.trim())) {
      chapterCounter--
      continue
    }
    if (headingTitle && SKIP_PATTERNS.test(headingTitle.trim())) {
      chapterCounter--
      continue
    }
    if (!tocTitle && text.length < 2000) {
      chapterCounter--
      continue
    }

    chapters.push({ title: finalTitle, text, inlineImages: imgResult.inlineImages })
  }

  return { title, author, contentType: 'text', chapters, imageChapters: [] }
}
