/**
 * HTML parser. Port of backend/html_parser.py.
 */

import type { ParsedBook } from './types'

const WHITESPACE_RE = /\s+/g
const HEADING_SELECTOR = 'h1, h2, h3'
const MIN_CHAPTER_LENGTH = 50

function splitByHeadings(doc: Document): { title: string; text: string }[] {
  const body = doc.body ?? doc.documentElement
  const headings = Array.from(body.querySelectorAll(HEADING_SELECTOR))

  if (headings.length <= 1) return []

  const chapters: { title: string; text: string }[] = []

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]
    const title = heading.textContent?.trim() || `Section ${i + 1}`
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
      chapters.push({ title, text })
    }
  }

  return chapters
}

export function parseHtml(data: ArrayBuffer): ParsedBook {
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    content = new TextDecoder('windows-1252').decode(data)
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(content, 'text/html')

  // Metadata
  const titleEl = doc.querySelector('title')
  let title = titleEl?.textContent?.trim() || 'Untitled'
  if (!title) title = 'Untitled'

  const authorEl = doc.querySelector('meta[name="author"]')
  let author = authorEl?.getAttribute('content')?.trim() || 'Unknown Author'
  if (!author) author = 'Unknown Author'

  let chapters = splitByHeadings(doc)

  if (!chapters.length) {
    const body = doc.body ?? doc.documentElement
    const text = (body.textContent ?? '').replace(WHITESPACE_RE, ' ').trim()
    if (text.length >= MIN_CHAPTER_LENGTH) {
      chapters = [{ title, text }]
    }
  }

  return {
    title,
    author,
    contentType: 'text',
    chapters: chapters.map((c) => ({ ...c, inlineImages: [] })),
    imageChapters: [],
  }
}
