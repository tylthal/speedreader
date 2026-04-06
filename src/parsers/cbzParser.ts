/**
 * CBZ parser. Port of backend/cbz_cbr_parser.py (CBZ portion only).
 * CBR (RAR) is not supported client-side — users must convert to CBZ.
 */

import JSZip from 'jszip'
import type { ParsedBook, ParsedImageChapter, ImagePage } from './types'
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
    if (titleEl?.textContent?.trim()) {
      title = titleEl.textContent.trim()
    }
    if (!title) {
      const series = doc.querySelector('Series')
      const number = doc.querySelector('Number')
      if (series?.textContent?.trim()) {
        title = series.textContent.trim()
        if (number?.textContent?.trim()) {
          title += ` #${number.textContent.trim()}`
        }
      }
    }

    const writer = doc.querySelector('Writer')
    if (writer?.textContent?.trim()) {
      author = writer.textContent.trim()
    }

    return { title: title || 'Untitled', author: author || 'Unknown Author' }
  } catch {
    return { title: 'Untitled', author: 'Unknown Author' }
  }
}

function getDirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(0, i) : ''
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

  // Check for ComicInfo.xml
  for (const name of Object.keys(zip.files)) {
    if (name.toLowerCase() === 'comicinfo.xml') {
      const xml = await zip.files[name].async('text')
      const info = parseComicInfo(xml)
      title = info.title
      author = info.author
      break
    }
  }

  // Get all image files
  const imageNames = Object.keys(zip.files)
    .filter((n) => !zip.files[n].dir && isImageFile(n))
    .sort(naturalCompare)

  if (!imageNames.length) {
    throw new Error('No image files found in the archive.')
  }

  // Group by directory
  const dirGroups = new Map<string, string[]>()
  for (const name of imageNames) {
    const dir = getDirname(name)
    const list = dirGroups.get(dir) ?? []
    list.push(name)
    dirGroups.set(dir, list)
  }

  const chapters: ParsedImageChapter[] = []

  if (dirGroups.size > 1) {
    const sortedDirs = [...dirGroups.keys()].sort(naturalCompare)
    for (const dir of sortedDirs) {
      const files = dirGroups.get(dir)!
      const chapterTitle = dir.split('/').pop() || 'Chapter 1'
      const pages: ImagePage[] = []

      for (let i = 0; i < files.length; i++) {
        const imgData = await zip.files[files[i]].async('arraybuffer')
        const mime = getMimeType(files[i])
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

      chapters.push({ title: chapterTitle, pages })
    }
  } else {
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
    chapters.push({ title: 'Full Comic', pages })
  }

  if (title === 'Untitled') {
    title = filename.replace(/\.[^.]+$/, '')
  }

  return {
    title,
    author,
    contentType: 'image',
    chapters: [],
    imageChapters: chapters,
  }
}
