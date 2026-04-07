/**
 * DOCX parser (PRD §3.1) — single ParsedSection from the converted document.
 *
 * Uses mammoth.js to convert .docx → HTML, then sanitizes the result. The
 * first inline image (if any) becomes the cover. Heading-based splitting is
 * deferred to PRD §10 (sub-section splitting for very long DOCX) and is not
 * implemented here.
 */

import mammoth from 'mammoth'
import type { ParsedBook, ParsedSection, ParsedCover } from './types'
import { sanitizeHtml } from '../lib/sanitize'

const WHITESPACE_RE = /\s+/g

interface CapturedImage {
  blob: Blob
  mimeType: string
  url: string
}

export async function parseDocx(data: ArrayBuffer): Promise<ParsedBook> {
  const captured: CapturedImage[] = []

  const result = await mammoth.convertToHtml(
    { arrayBuffer: data },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const buf = await image.read()
        const mimeType = image.contentType ?? 'image/png'
        const blob = new Blob([buf], { type: mimeType })
        const url = URL.createObjectURL(blob)
        captured.push({ blob, mimeType, url })
        return { src: url }
      }),
    },
  )

  const html = result.value
  const doc = new DOMParser().parseFromString(html, 'text/html')

  // Title from first H1, otherwise "Untitled" (mammoth doesn't expose docx
  // metadata).
  let title = 'Untitled'
  const firstH1 = doc.querySelector('h1')
  if (firstH1?.textContent?.trim()) title = firstH1.textContent.trim()

  const body = doc.body ?? doc.documentElement
  const text = (body.textContent ?? '').replace(WHITESPACE_RE, ' ').trim()
  const sanitized = sanitizeHtml(html)

  // Cover: first captured image, if any.
  let cover: ParsedCover | undefined
  if (captured.length) {
    cover = { blob: captured[0].blob, mimeType: captured[0].mimeType }
  }

  // Section title: first heading or "Untitled".
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
  }
}
