/**
 * EPUB parser (PRD §3.1, §3.2, §7).
 *
 *  - One ParsedSection per linear OR non-linear spine item.
 *  - No SKIP_PATTERNS, no minimum-length filtering, no auto-naming.
 *  - Section title resolution: NCX/nav title for this spine item → first
 *    h1/h2/h3 in the doc → literal "Untitled".
 *  - Inline images are kept in the section HTML and resolved to OPFS-backed
 *    blob URLs at parse time.
 *  - Cover image: manifest item with properties="cover-image" →
 *    <meta name="cover" content="..."> → first manifest image.
 *  - tocTree mirrors the NCX/nav hierarchy when present, mapping leaves to
 *    spine indices for the sidebar.
 */

import JSZip from 'jszip'
import type { ParsedBook, ParsedSection, ParsedCover, TocNode, ParsedImage } from './types'
import { sanitizeDocument } from '../lib/sanitize'

const WHITESPACE_RE = /\s+/g

interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string
}

interface SpineItem {
  id: string
  linear: string
}

interface TocEntry {
  filename: string
  fragment: string
  title: string
  children?: TocEntry[]
}

function resolvePath(base: string, relative: string): string {
  if (relative.startsWith('/')) return relative.slice(1)
  const baseParts = base.split('/')
  baseParts.pop()
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

function parseOpfMetadata(opfDoc: Document): { title: string; author: string; coverMetaId: string | null } {
  const dcNs = 'http://purl.org/dc/elements/1.1/'
  const titleEl = opfDoc.getElementsByTagNameNS(dcNs, 'title')[0]
  const creatorEl = opfDoc.getElementsByTagNameNS(dcNs, 'creator')[0]
  let coverMetaId: string | null = null
  for (const m of Array.from(opfDoc.querySelectorAll('metadata > meta'))) {
    if (m.getAttribute('name') === 'cover') {
      coverMetaId = m.getAttribute('content')
      break
    }
  }
  return {
    title: titleEl?.textContent?.trim() || 'Untitled',
    author: creatorEl?.textContent?.trim() || 'Unknown Author',
    coverMetaId,
  }
}

function parseOpfManifest(opfDoc: Document, opfDir: string): Map<string, ManifestItem> {
  const manifest = new Map<string, ManifestItem>()
  for (const item of Array.from(opfDoc.querySelectorAll('manifest > item'))) {
    const id = item.getAttribute('id') ?? ''
    const href = item.getAttribute('href') ?? ''
    const mediaType = item.getAttribute('media-type') ?? ''
    const properties = item.getAttribute('properties') ?? ''
    const fullHref = opfDir ? `${opfDir}/${href}` : href
    manifest.set(id, { id, href: fullHref, mediaType, properties })
  }
  return manifest
}

function parseOpfSpine(opfDoc: Document): SpineItem[] {
  const out: SpineItem[] = []
  for (const ref of Array.from(opfDoc.querySelectorAll('spine > itemref'))) {
    out.push({
      id: ref.getAttribute('idref') ?? '',
      linear: ref.getAttribute('linear') ?? 'yes',
    })
  }
  return out
}

function parseNcx(tocDoc: Document, tocHref: string): TocEntry[] {
  function walk(navPoints: Element[]): TocEntry[] {
    const entries: TocEntry[] = []
    for (const np of navPoints) {
      const text = np.querySelector(':scope > navLabel > text')?.textContent?.trim() ?? ''
      const src = np.querySelector(':scope > content')?.getAttribute('src') ?? ''
      const parts = src.split('#')
      const filename = resolvePath(tocHref, parts[0])
      const childNavPoints = Array.from(np.querySelectorAll(':scope > navPoint'))
      entries.push({
        filename,
        fragment: parts[1] ?? '',
        title: text,
        children: childNavPoints.length ? walk(childNavPoints) : undefined,
      })
    }
    return entries
  }
  const top = Array.from(tocDoc.querySelectorAll('navMap > navPoint'))
  return walk(top)
}

function parseNavXhtml(navDoc: Document, navHref: string): TocEntry[] {
  // Find the <nav epub:type="toc"> element (or any nav).
  const navs = Array.from(navDoc.querySelectorAll('nav'))
  let tocNav = navs.find((n) => n.getAttribute('epub:type') === 'toc') ?? navs[0]
  if (!tocNav) return []

  function walkList(ol: Element): TocEntry[] {
    const out: TocEntry[] = []
    for (const li of Array.from(ol.children)) {
      if (li.tagName.toLowerCase() !== 'li') continue
      const a = li.querySelector(':scope > a')
      const href = a?.getAttribute('href') ?? ''
      const text = a?.textContent?.trim() ?? ''
      const parts = href.split('#')
      const filename = resolvePath(navHref, parts[0])
      const childList = li.querySelector(':scope > ol, :scope > ul')
      out.push({
        filename,
        fragment: parts[1] ?? '',
        title: text,
        children: childList ? walkList(childList) : undefined,
      })
    }
    return out
  }

  const list = tocNav.querySelector('ol, ul')
  return list ? walkList(list) : []
}

function flattenToc(entries: TocEntry[], out: TocEntry[] = []): TocEntry[] {
  for (const e of entries) {
    out.push(e)
    if (e.children?.length) flattenToc(e.children, out)
  }
  return out
}

function firstHeading(doc: Document): string | null {
  for (const tag of ['h1', 'h2', 'h3']) {
    const h = doc.querySelector(tag)
    const t = h?.textContent?.trim()
    if (t) return t
  }
  return null
}

/**
 * Walk the manifest, decode every image, and produce a basename-keyed map of
 * `{ blob, mimeType }`. The returned ParsedImage[] becomes ParsedBook.parsedImages
 * which uploadBook persists to OPFS at /images/{pubId}/{name}.
 *
 * Multiple images that share a basename get suffixed with their full path
 * hash so collisions don't clobber each other.
 */
async function buildImageManifest(
  zip: JSZip,
  manifest: Map<string, ManifestItem>,
): Promise<{ images: ParsedImage[]; byHref: Map<string, string>; byBasename: Map<string, string> }> {
  const images: ParsedImage[] = []
  const byHref = new Map<string, string>()
  const byBasename = new Map<string, string>()
  const usedNames = new Set<string>()

  function uniqueName(base: string): string {
    if (!usedNames.has(base)) {
      usedNames.add(base)
      return base
    }
    // Suffix with a counter to avoid collisions.
    let i = 1
    while (usedNames.has(`${i}-${base}`)) i++
    const next = `${i}-${base}`
    usedNames.add(next)
    return next
  }

  for (const item of manifest.values()) {
    if (!item.mediaType.startsWith('image/')) continue
    const file = zip.file(item.href)
    if (!file) continue
    const data = await file.async('arraybuffer')
    const blob = new Blob([data], { type: item.mediaType })
    const rawBasename = item.href.split('/').pop() ?? 'image'
    const name = uniqueName(rawBasename)
    images.push({ name, blob, mimeType: item.mediaType })
    byHref.set(item.href, name)
    if (!byBasename.has(rawBasename)) byBasename.set(rawBasename, name)
  }

  return { images, byHref, byBasename }
}

/**
 * Rewrite every <img src> in the doc to an `opfs:{name}` marker that
 * FormattedView will resolve at render time. Images that don't resolve to
 * any manifest entry are removed.
 */
function rewriteImageSources(
  doc: Document,
  byHref: Map<string, string>,
  byBasename: Map<string, string>,
  chapterDir: string,
): void {
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? ''
    if (!src) {
      img.remove()
      continue
    }
    const resolved =
      chapterDir && !src.startsWith('/')
        ? resolvePath(chapterDir + '/dummy', src)
        : src
    const basename = src.split('/').pop()!
    const name = byHref.get(resolved) ?? byBasename.get(basename)
    if (!name) {
      img.remove()
      continue
    }
    img.setAttribute('src', `opfs:${name}`)
  }
}

async function extractCover(
  zip: JSZip,
  manifest: Map<string, ManifestItem>,
  coverMetaId: string | null,
): Promise<ParsedCover | undefined> {
  // 1. Manifest item with properties="cover-image"
  for (const item of manifest.values()) {
    if (item.properties.split(/\s+/).includes('cover-image')) {
      const file = zip.file(item.href)
      if (file) {
        const data = await file.async('arraybuffer')
        return { blob: new Blob([data], { type: item.mediaType }), mimeType: item.mediaType }
      }
    }
  }
  // 2. <meta name="cover" content="ID">
  if (coverMetaId) {
    const item = manifest.get(coverMetaId)
    if (item && item.mediaType.startsWith('image/')) {
      const file = zip.file(item.href)
      if (file) {
        const data = await file.async('arraybuffer')
        return { blob: new Blob([data], { type: item.mediaType }), mimeType: item.mediaType }
      }
    }
  }
  // 3. First image in manifest
  for (const item of manifest.values()) {
    if (item.mediaType.startsWith('image/')) {
      const file = zip.file(item.href)
      if (file) {
        const data = await file.async('arraybuffer')
        return { blob: new Blob([data], { type: item.mediaType }), mimeType: item.mediaType }
      }
    }
  }
  return undefined
}

export async function parseEpub(data: ArrayBuffer): Promise<ParsedBook> {
  const zip = await JSZip.loadAsync(data)

  const opfPath = await readContainerXml(zip)
  const opfDir = dirname(opfPath)
  const opfXml = await zip.file(opfPath)?.async('text')
  if (!opfXml) throw new Error('Cannot read OPF file')
  const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml')

  const { title, author, coverMetaId } = parseOpfMetadata(opfDoc)
  const manifest = parseOpfManifest(opfDoc, opfDir)
  const spine = parseOpfSpine(opfDoc)
  const { images: parsedImages, byHref: imagesByHref, byBasename: imagesByBasename } =
    await buildImageManifest(zip, manifest)

  // Resolve TOC (NCX preferred, nav fallback).
  let tocEntries: TocEntry[] = []
  let tocHrefForLog = ''
  for (const item of manifest.values()) {
    if (item.mediaType === 'application/x-dtbncx+xml') {
      const tocXml = await zip.file(item.href)?.async('text')
      if (tocXml) {
        const tocDoc = new DOMParser().parseFromString(tocXml, 'application/xml')
        tocEntries = parseNcx(tocDoc, item.href)
        tocHrefForLog = item.href
      }
      break
    }
  }
  if (!tocEntries.length) {
    for (const item of manifest.values()) {
      if (item.properties.split(/\s+/).includes('nav')) {
        const navXml = await zip.file(item.href)?.async('text')
        if (navXml) {
          const navDoc = new DOMParser().parseFromString(navXml, 'text/html')
          tocEntries = parseNavXhtml(navDoc, item.href)
          tocHrefForLog = item.href
          if (tocEntries.length) break
        }
      }
    }
  }
  void tocHrefForLog

  // Build a flat title lookup keyed by spine filename so per-section titles
  // can be resolved without walking the tree.
  const flatToc = flattenToc(tocEntries)
  const tocTitleByFile = new Map<string, string>()
  for (const e of flatToc) {
    if (!tocTitleByFile.has(e.filename) && e.title) {
      tocTitleByFile.set(e.filename, e.title)
    }
  }

  // Iterate spine — one section per item, both linear and non-linear (PRD §3.1).
  const sections: ParsedSection[] = []
  const spineHrefToSectionIdx = new Map<string, number>()

  for (const { id } of spine) {
    const item = manifest.get(id)
    if (!item) continue
    if (!item.mediaType.includes('html')) continue

    const file = zip.file(item.href)
    if (!file) continue
    const content = await file.async('text')
    if (!content) continue

    const chapterDir = dirname(item.href)
    const htmlDoc = new DOMParser().parseFromString(content, 'text/html')
    rewriteImageSources(htmlDoc, imagesByHref, imagesByBasename, chapterDir)

    const tocTitle = tocTitleByFile.get(item.href)
    const headingTitle = firstHeading(htmlDoc)
    const sectionTitle = tocTitle || headingTitle || 'Untitled'

    const body = htmlDoc.body ?? htmlDoc.documentElement
    const text = (body.textContent ?? '').replace(WHITESPACE_RE, ' ').trim()
    const html = sanitizeDocument(htmlDoc)

    spineHrefToSectionIdx.set(item.href, sections.length)
    sections.push({ title: sectionTitle, text, html })
  }

  // Build the TOC tree with section indices for the sidebar.
  function mapTocTree(entries: TocEntry[]): TocNode[] {
    return entries.map((e) => {
      const sectionIndex = spineHrefToSectionIdx.get(e.filename) ?? -1
      const children = e.children?.length ? mapTocTree(e.children) : undefined
      return { title: e.title || 'Untitled', sectionIndex, children }
    })
  }
  const tocTree = tocEntries.length ? mapTocTree(tocEntries) : undefined

  const cover = await extractCover(zip, manifest, coverMetaId)

  return {
    title,
    author,
    contentType: 'text',
    sections,
    cover,
    tocTree,
    parsedImages,
  }
}
