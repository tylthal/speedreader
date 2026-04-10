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

interface SpineSectionSource {
  href: string
  headingTitle: string | null
  headingTitles: string[]
  text: string
  html: string
  anchorProgress: Map<string, number>
}

function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/')
  if (!trimmed) return ''
  const withoutHash = trimmed.split('#', 1)[0] ?? ''
  const withoutQuery = withoutHash.split('?', 1)[0] ?? ''
  const leadingSlash = withoutQuery.startsWith('/')
  const out: string[] = []
  for (const rawPart of withoutQuery.split('/')) {
    const part = rawPart.trim()
    if (!part || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    try {
      out.push(decodeURIComponent(part))
    } catch {
      out.push(part)
    }
  }
  const joined = out.join('/')
  return leadingSlash ? joined.replace(/^\/+/, '') : joined
}

function normalizeTocFragment(fragment: string): string {
  const trimmed = fragment.trim().replace(/^#/, '')
  if (!trimmed) return ''
  try {
    return decodeURIComponent(trimmed)
  } catch {
    return trimmed
  }
}

const HTML_ANCHOR_ATTR_RE = /\b(?:id|name)\s*=\s*["']([^"']+)["']/gi

function collectAnchorProgress(html: string): Map<string, number> {
  const progress = new Map<string, number>()
  const length = Math.max(html.length, 1)
  HTML_ANCHOR_ATTR_RE.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = HTML_ANCHOR_ATTR_RE.exec(html)) !== null) {
    const anchor = normalizeTocFragment(match[1] ?? '')
    if (!anchor || progress.has(anchor)) continue
    progress.set(anchor, match.index / length)
  }

  return progress
}

function normalizeTitleForMatch(title: string | null | undefined): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/\bchapter\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function titlesLikelyMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeTitleForMatch(a)
  const right = normalizeTitleForMatch(b)
  if (!left || !right) return false
  return left === right || left.includes(right) || right.includes(left)
}

function resolvePath(base: string, relative: string): string {
  if (!relative.trim()) return normalizePath(base)
  if (relative.startsWith('/')) return normalizePath(relative.slice(1))
  const baseParts = base.split('/')
  baseParts.pop()
  const relParts = relative.split('/')
  for (const part of relParts) {
    if (part === '..') baseParts.pop()
    else if (part !== '.') baseParts.push(part)
  }
  return normalizePath(baseParts.join('/'))
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
    const fullHref = normalizePath(opfDir ? `${opfDir}/${href}` : href)
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
  function localName(el: Element | null | undefined): string {
    if (!el) return ''
    return (el.localName || el.tagName || '').toLowerCase()
  }

  function directChildren(parent: Element, name: string): Element[] {
    return Array.from(parent.children).filter((child) => localName(child) === name)
  }

  function firstDirectChild(parent: Element | null, name: string): Element | null {
    if (!parent) return null
    return directChildren(parent, name)[0] ?? null
  }

  function walk(navPoints: Element[]): TocEntry[] {
    const entries: TocEntry[] = []
    for (const np of navPoints) {
      const navLabel = firstDirectChild(np, 'navlabel')
      const text = firstDirectChild(navLabel, 'text')?.textContent?.trim() ?? ''
      const src = firstDirectChild(np, 'content')?.getAttribute('src') ?? ''
      const parts = src.split('#')
      const filename = parts[0] ? resolvePath(tocHref, parts[0]) : ''
      const childNavPoints = directChildren(np, 'navpoint')
      entries.push({
        filename,
        fragment: normalizeTocFragment(parts[1] ?? ''),
        title: text,
        children: childNavPoints.length ? walk(childNavPoints) : undefined,
      })
    }
    return entries
  }
  const navMap =
    Array.from(tocDoc.getElementsByTagName('*')).find((el) => localName(el) === 'navmap') ?? null
  const top = navMap ? directChildren(navMap, 'navpoint') : []
  return walk(top)
}

function parseNavXhtml(navDoc: Document, navHref: string): TocEntry[] {
  // Find the <nav epub:type="toc"> element (or any nav).
  const navs = Array.from(navDoc.querySelectorAll('nav'))
  const tocNav = navs.find((n) => n.getAttribute('epub:type') === 'toc') ?? navs[0]
  if (!tocNav) return []

  function walkList(ol: Element): TocEntry[] {
    const out: TocEntry[] = []
    for (const li of Array.from(ol.children)) {
      if (li.tagName.toLowerCase() !== 'li') continue
      const directChildren = Array.from(li.children)
      const a = directChildren.find((child) => child.tagName.toLowerCase() === 'a') ?? null
      const labelEl =
        a ??
        directChildren.find((child) => {
          const tag = child.tagName.toLowerCase()
          return tag !== 'ol' && tag !== 'ul'
        }) ??
        null
      const href = a?.getAttribute('href') ?? ''
      const text = labelEl?.textContent?.trim() ?? li.textContent?.trim() ?? ''
      const parts = href.split('#')
      const filename = parts[0] ? resolvePath(navHref, parts[0]) : ''
      const childList =
        directChildren.find((child) => child.tagName.toLowerCase() === 'ol' || child.tagName.toLowerCase() === 'ul') ??
        null
      out.push({
        filename,
        fragment: normalizeTocFragment(parts[1] ?? ''),
        title: text,
        children: childList ? walkList(childList) : undefined,
      })
    }
    return out
  }

  const list = Array.from(tocNav.children).find((child) => {
    const tag = child.tagName.toLowerCase()
    return tag === 'ol' || tag === 'ul'
  })
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
  return collectHeadingTitles(doc)[0] ?? null
}

function collectHeadingTitles(doc: Document): string[] {
  const titles: string[] = []
  const seen = new Set<string>()

  for (const heading of Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
    const title = heading.textContent?.trim()
    if (!title) continue
    const normalized = normalizeTitleForMatch(title)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    titles.push(title)
  }

  return titles
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

  // Resolve TOC (NCX preferred, nav fallback). Some EPUBs label NCX as
  // `text/xml`, so we also respect the spine's `toc=` id and `.ncx` hrefs.
  let tocEntries: TocEntry[] = []
  const spineTocId = opfDoc.querySelector('spine')?.getAttribute('toc') ?? ''
  const ncxCandidates: ManifestItem[] = []
  if (spineTocId) {
    const spineTocItem = manifest.get(spineTocId)
    if (spineTocItem) ncxCandidates.push(spineTocItem)
  }
  for (const item of manifest.values()) {
    const hrefLower = item.href.toLowerCase()
    const mediaLower = item.mediaType.toLowerCase()
    const isNcxLike =
      mediaLower === 'application/x-dtbncx+xml' ||
      mediaLower === 'text/xml' ||
      hrefLower.endsWith('.ncx')
    if (!isNcxLike) continue
    if (!ncxCandidates.includes(item)) ncxCandidates.push(item)
  }
  for (const item of ncxCandidates) {
    const tocXml = await zip.file(item.href)?.async('text')
    if (!tocXml) continue
    const tocDoc = new DOMParser().parseFromString(tocXml, 'application/xml')
    const parsed = parseNcx(tocDoc, item.href)
    if (parsed.length) {
      tocEntries = parsed
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
          if (tocEntries.length) break
        }
      }
    }
  }

  // Iterate spine — one section per item, both linear and non-linear (PRD §3.1).
  const sectionSources: SpineSectionSource[] = []
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

    const headingTitle = firstHeading(htmlDoc)
    const body = htmlDoc.body ?? htmlDoc.documentElement
    const text = (body.textContent ?? '').replace(WHITESPACE_RE, ' ').trim()
    const html = sanitizeDocument(htmlDoc)

    spineHrefToSectionIdx.set(item.href, sectionSources.length)
    sectionSources.push({
      href: item.href,
      headingTitle,
      headingTitles: collectHeadingTitles(htmlDoc),
      text,
      html,
      anchorProgress: collectAnchorProgress(content),
    })
  }

  function sectionMatchesTocTitle(
    section: SpineSectionSource | undefined,
    tocTitle: string,
  ): boolean {
    if (!section) return false
    return section.headingTitles.some((heading) => titlesLikelyMatch(tocTitle, heading))
  }

  function resolveTocSectionIndex(entry: TocEntry): number {
    const directIndex = spineHrefToSectionIdx.get(entry.filename) ?? -1
    if (directIndex < 0) return -1

    if (!entry.fragment) return directIndex

    const current = sectionSources[directIndex]
    const next = sectionSources[directIndex + 1]
    const fragmentProgress = current?.anchorProgress.get(entry.fragment)

    if (
      fragmentProgress != null &&
      fragmentProgress >= 0.85 &&
      next &&
      !sectionMatchesTocTitle(current, entry.title) &&
      sectionMatchesTocTitle(next, entry.title)
    ) {
      return directIndex + 1
    }

    return directIndex
  }

  function shouldDropTocFragment(entry: TocEntry, resolvedSectionIndex: number): boolean {
    if (!entry.fragment) return false
    const directIndex = spineHrefToSectionIdx.get(entry.filename) ?? -1
    return directIndex >= 0 && resolvedSectionIndex !== directIndex
  }

  // Build a per-section title lookup so end-of-file bridge anchors in the TOC
  // can title the actual destination section instead of the preceding contents page.
  const flatToc = flattenToc(tocEntries)
  const tocTitleBySectionIndex = new Map<number, string>()
  for (const entry of flatToc) {
    const sectionIndex = resolveTocSectionIndex(entry)
    if (sectionIndex >= 0 && entry.title && !tocTitleBySectionIndex.has(sectionIndex)) {
      tocTitleBySectionIndex.set(sectionIndex, entry.title)
    }
  }

  const sections: ParsedSection[] = sectionSources.map((section, index) => ({
    title:
      tocTitleBySectionIndex.get(index) ||
      section.headingTitle ||
      'Untitled',
    text: section.text,
    html: section.html,
  }))

  // Build the TOC tree with section indices for the sidebar.
  function mapTocTree(entries: TocEntry[]): TocNode[] {
    return entries.map((e) => {
      const children = e.children?.length ? mapTocTree(e.children) : undefined
      let sectionIndex = resolveTocSectionIndex(e)
      if (sectionIndex < 0 && children?.length) {
        const firstMappedChild = children.find((child) => child.sectionIndex >= 0)
        if (firstMappedChild) sectionIndex = firstMappedChild.sectionIndex
      }
      return {
        title: e.title || 'Untitled',
        sectionIndex,
        htmlAnchor:
          shouldDropTocFragment(e, sectionIndex)
            ? null
            : e.fragment || null,
        children,
      }
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
