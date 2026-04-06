/**
 * DOCX parser. Port of backend/docx_parser.py.
 * Uses mammoth.js for DOCX → HTML conversion, then DOMParser for splitting.
 */

import mammoth from 'mammoth'
import type { ParsedBook, ParsedChapter, InlineImage } from './types'
import { getImageDimensions } from './types'

const MIN_CHAPTER_LENGTH = 50
const FALLBACK_WORD_LIMIT = 3000
const WHITESPACE_RE = /\s+/g
const HEADING_SELECTOR = 'h1, h2, h3'

interface CapturedImage {
  blob: Blob
  mimeType: string
}

export async function parseDocx(data: ArrayBuffer): Promise<ParsedBook> {
  // Capture images during conversion
  const capturedImages: CapturedImage[] = []

  const result = await mammoth.convertToHtml(
    { arrayBuffer: data },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const buf = await image.read()
        const mimeType = image.contentType ?? 'image/png'
        const blob = new Blob([buf], { type: mimeType })
        capturedImages.push({ blob, mimeType })
        const idx = capturedImages.length - 1
        return { src: `__IMG_${idx}__` }
      }),
    },
  )

  const html = result.value

  // Parse the HTML
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')

  // Extract title from first heading or from docx metadata
  // (mammoth doesn't expose metadata, so use first heading)
  let title = 'Untitled'
  let author = 'Unknown Author'
  const firstH1 = doc.querySelector('h1')
  if (firstH1?.textContent?.trim()) {
    title = firstH1.textContent.trim()
  }

  // Process images: replace __IMG_N__ src with placeholders in text
  const imgEls = doc.querySelectorAll('img')
  const inlineImages: InlineImage[] = []

  for (const imgEl of Array.from(imgEls)) {
    const src = imgEl.getAttribute('src') ?? ''
    const match = src.match(/^__IMG_(\d+)__$/)
    if (!match) continue

    const idx = parseInt(match[1], 10)
    const captured = capturedImages[idx]
    if (!captured || captured.blob.size < 500) {
      imgEl.remove()
      continue
    }

    const dims = await getImageDimensions(captured.blob)
    const placeholder = `{{IMG_${inlineImages.length}}}`

    inlineImages.push({
      placeholder,
      blob: captured.blob,
      alt: imgEl.getAttribute('alt') ?? '',
      width: dims.width,
      height: dims.height,
      mimeType: captured.mimeType,
    })

    // Replace img element with placeholder text
    const textNode = doc.createTextNode(` ${placeholder} `)
    imgEl.replaceWith(textNode)
  }

  // Split by headings
  const body = doc.body ?? doc.documentElement
  const headings = Array.from(body.querySelectorAll(HEADING_SELECTOR))

  const chapters: ParsedChapter[] = []

  if (headings.length > 1) {
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i]
      const hTitle = heading.textContent?.trim() || `Chapter ${i + 1}`
      const texts: string[] = [heading.textContent ?? '']

      let sibling = heading.nextSibling
      while (sibling) {
        if (sibling instanceof Element) {
          if (sibling.matches(HEADING_SELECTOR)) break
          if (sibling.querySelector(HEADING_SELECTOR)) break
          texts.push(sibling.textContent ?? '')
        } else if (sibling.textContent) {
          texts.push(sibling.textContent)
        }
        sibling = sibling.nextSibling
      }

      const text = texts.join(' ').replace(WHITESPACE_RE, ' ').trim()
      if (text.length >= MIN_CHAPTER_LENGTH) {
        chapters.push({ title: hTitle, text, inlineImages })
      }
    }
  }

  // Fallback: whole document, split by word count
  if (!chapters.length) {
    const allText = (body.textContent ?? '').replace(WHITESPACE_RE, ' ').trim()
    if (allText.length >= MIN_CHAPTER_LENGTH) {
      const words = allText.split(/\s+/)
      for (let start = 0; start < words.length; start += FALLBACK_WORD_LIMIT) {
        const chunk = words.slice(start, start + FALLBACK_WORD_LIMIT).join(' ').trim()
        if (chunk.length >= MIN_CHAPTER_LENGTH) {
          chapters.push({
            title: `Chapter ${chapters.length + 1}`,
            text: chunk,
            inlineImages: start === 0 ? inlineImages : [],
          })
        }
      }
    }
  }

  return { title, author, contentType: 'text', chapters, imageChapters: [] }
}
