/**
 * Plain text parser (PRD §3.1) — emits a single ParsedSection. We do not
 * heuristically split on "Chapter N" headings any more; the whole document is
 * one section, with paragraph breaks preserved in the formatted-view HTML.
 */

import type { ParsedBook, ParsedSection } from './types'
import { paragraphsToHtml } from '../lib/sanitize'

function detectEncoding(data: ArrayBuffer): string {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return 'utf-8'
  } catch {
    return 'windows-1252'
  }
}

export function parseTxt(data: ArrayBuffer, filename?: string): ParsedBook {
  const encoding = detectEncoding(data)
  const text = new TextDecoder(encoding).decode(data).trim()

  const firstLine = text.split('\n')[0]?.trim() ?? ''
  // Use the first non-empty line as the book title only if it's short and
  // looks like a title; otherwise fall back to the filename.
  let title = 'Untitled'
  if (firstLine && firstLine.length < 100) {
    title = firstLine
  } else if (filename) {
    title = filename.replace(/\.[^.]+$/, '')
  }

  const sectionTitle = title || 'Untitled'
  const html = paragraphsToHtml(text)

  const section: ParsedSection = { title: sectionTitle, text, html }

  return {
    title,
    author: 'Unknown Author',
    contentType: 'text',
    sections: [section],
  }
}
