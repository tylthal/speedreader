/**
 * CBZ parser (PRD §3.1, §4.5) — one ParsedSection (empty text/html) plus an
 * imagePages sidecar carrying the page bitmaps. Always rendered in formatted
 * view by the reader.
 */

import JSZip from 'jszip'
import type { ParsedBook, ParsedSection, ParsedCover, ImagePage } from './types'
import { getImageDimensions } from './types'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff'])
const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
}

function getExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(getExt(name))
}

function getMimeType(name: string): string {
  return MIME_MAP[getExt(name)] ?? 'image/jpeg'
}

function naturalSortKey(s: string): (string | number)[] {
  return s.split(/(\d+)/).map((part) => {
    const n = parseInt(part, 10)
    return isNaN(n) ? part.toLowerCase() : n
  })
}

function naturalCompare(a: string, b: string): number {
  const ka = naturalSortKey(a)
  const kb = naturalSortKey(b)
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const va = ka[i] ?? ''
    const vb = kb[i] ?? ''
    if (typeof va === 'number' && typeof vb === 'number') {
      if (va !== vb) return va - vb
    } else {
      const sa = String(va)
      const sb = String(vb)
      if (sa !== sb) return sa < sb ? -1 : 1
    }
  }
  return 0
}

function parseComicInfo(xml: string): { title: string; author: string } {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    let title = ''
    let author = ''
    const titleEl = doc.querySelector('Title')
    if (titleEl?.textContent?.trim()) title = titleEl.textContent.trim()
    if (!title) {
      const series = doc.querySelector('Series')
      const number = doc.querySelector('Number')
      if (series?.textContent?.trim()) {
        title = series.textContent.trim()
        if (number?.textContent?.trim()) title += ` #${number.textContent.trim()}`
      }
    }
    const writer = doc.querySelector('Writer')
    if (writer?.textContent?.trim()) author = writer.textContent.trim()
    return { title: title || 'Untitled', author: author || 'Unknown Author' }
  } catch {
    return { title: 'Untitled', author: 'Unknown Author' }
  }
}

export async function parseCbz(data: ArrayBuffer, filename: string): Promise<ParsedBook> {
  const ext = getExt(filename)
  if (ext === '.cbr') {
    throw new Error(
      'CBR (RAR) files are not supported in the browser. ' +
      'Please convert to CBZ using a tool like Calibre.',
    )
  }

  const zip = await JSZip.loadAsync(data)
  let title = 'Untitled'
  let author = 'Unknown Author'

  for (const name of Object.keys(zip.files)) {
    if (name.toLowerCase() === 'comicinfo.xml') {
      const xml = await zip.files[name].async('text')
      const info = parseComicInfo(xml)
      title = info.title
      author = info.author
      break
    }
  }

  const imageNames = Object.keys(zip.files)
    .filter((n) => !zip.files[n].dir && isImageFile(n))
    .sort(naturalCompare)

  if (!imageNames.length) {
    throw new Error('No image files found in the archive.')
  }

  // PRD §3.1 — CBZ is one section. We ignore directory grouping.
  const pages: ImagePage[] = []
  for (let i = 0; i < imageNames.length; i++) {
    const imgData = await zip.files[imageNames[i]].async('arraybuffer')
    const mime = getMimeType(imageNames[i])
    const blob = new Blob([imgData], { type: mime })
    const dims = await getImageDimensions(blob)
    pages.push({
      pageIndex: i,
      blob,
      width: dims.width,
      height: dims.height,
      mimeType: mime,
    })
  }

  if (title === 'Untitled') {
    title = filename.replace(/\.[^.]+$/, '')
  }

  // PRD §3.4 — first image is the cover.
  let cover: ParsedCover | undefined
  if (pages.length) {
    cover = { blob: pages[0].blob, mimeType: pages[0].mimeType }
  }

  const section: ParsedSection = {
    title: title || 'Untitled',
    text: '',
    html: '',
    meta: { pageCount: pages.length },
  }

  return {
    title,
    author,
    contentType: 'image',
    sections: [section],
    imagePages: pages,
    cover,
  }
}
