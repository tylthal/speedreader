/**
 * DOCX parser (PRD §3.1) — single ParsedSection from the converted document.
 *
 * Uses mammoth.js to convert .docx → HTML, then sanitizes the result. The
 * first inline image (if any) becomes the cover. Heading-based splitting is
 * deferred to PRD §10 (sub-section splitting for very long DOCX) and is not
 * implemented here.
 */

import mammoth from 'mammoth'
import type { ParsedBook, ParsedSection, ParsedCover, ParsedImage } from './types'
import { sanitizeHtml, sanitizeDocument } from '../lib/sanitize'

const WHITESPACE_RE = /\s+/g

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
}

export async function parseDocx(data: ArrayBuffer): Promise<ParsedBook> {
  const parsedImages: ParsedImage[] = []
  const placeholderToName = new Map<string, string>()

  const result = await mammoth.convertToHtml(
    { arrayBuffer: data },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const buf = await image.read()
        const mimeType = image.contentType ?? 'image/png'
        const blob = new Blob([buf], { type: mimeType })
        const ext = EXT_BY_MIME[mimeType] ?? '.bin'
        const name = `docx-img-${parsedImages.length}${ext}`
        parsedImages.push({ name, blob, mimeType })
        // Use a placeholder src that we'll rewrite to opfs:{name} after
        // mammoth finishes (mammoth's API forces a real string here).
        const placeholder = `__docx_img_${parsedImages.length - 1}__`
        placeholderToName.set(placeholder, name)
        return { src: placeholder }
      }),
    },
  )

  const html = result.value
  const doc = new DOMParser().parseFromString(html, 'text/html')

  // Rewrite placeholder srcs to opfs: markers before sanitizing.
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? ''
    const name = placeholderToName.get(src)
    if (name) {
      img.setAttribute('src', `opfs:${name}`)
    } else {
      img.remove()
    }
  }

  let title = 'Untitled'
  const firstH1 = doc.querySelector('h1')
  if (firstH1?.textContent?.trim()) title = firstH1.textContent.trim()

  const body = doc.body ?? doc.documentElement
  const text = (body.textContent ?? '').replace(WHITESPACE_RE, ' ').trim()
  const sanitized = sanitizeDocument(doc)
  // sanitizeHtml is referenced for tree-shaking discipline; ensure it's used.
  void sanitizeHtml

  // Cover: first inline image, if any.
  let cover: ParsedCover | undefined
  if (parsedImages.length) {
    cover = { blob: parsedImages[0].blob, mimeType: parsedImages[0].mimeType }
  }

  let sectionTitle = 'Untitled'
  for (const tag of ['h1', 'h2', 'h3']) {
    const h = doc.querySelector(tag)
    const t = h?.textContent?.trim()
    if (t) { sectionTitle = t; break }
  }

  const section: ParsedSection = { title: sectionTitle, text, html: sanitized }

  return {
    title,
    author: 'Unknown Author',
    contentType: 'text',
    sections: [section],
    cover,
    parsedImages,
  }
}
