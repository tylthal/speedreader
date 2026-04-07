/**
 * HTML parser (PRD §3.1) — emits a single ParsedSection containing the
 * sanitized document body.
 */

import type { ParsedBook, ParsedSection } from './types'
import { sanitizeDocument } from '../lib/sanitize'

const WHITESPACE_RE = /\s+/g

function firstHeading(doc: Document): string | null {
  for (const tag of ['h1', 'h2', 'h3']) {
    const h = doc.querySelector(tag)
    const t = h?.textContent?.trim()
    if (t) return t
  }
  return null
}

export function parseHtml(data: ArrayBuffer): ParsedBook {
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    content = new TextDecoder('windows-1252').decode(data)
  }

  const doc = new DOMParser().parseFromString(content, 'text/html')

  const titleEl = doc.querySelector('title')
  const metaTitle = titleEl?.textContent?.trim()
  const headingTitle = firstHeading(doc)
  const title = metaTitle || headingTitle || 'Untitled'

  const authorEl = doc.querySelector('meta[name="author"]')
  const author = authorEl?.getAttribute('content')?.trim() || 'Unknown Author'

  const body = doc.body ?? doc.documentElement
  const text = (body.textContent ?? '').replace(WHITESPACE_RE, ' ').trim()
  const html = sanitizeDocument(doc)

  // PRD §3.2 — section title is NCX/heading/Untitled. For a single-document
  // HTML the section title is the document's first heading, or "Untitled".
  const sectionTitle = headingTitle || 'Untitled'

  const section: ParsedSection = { title: sectionTitle, text, html }

  return {
    title,
    author,
    contentType: 'text',
    sections: [section],
  }
}
