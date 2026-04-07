/**
 * Markdown parser (PRD §3.1) — emits a single ParsedSection. We do not split
 * MD by H1/H2 boundaries; the PRD says "the whole document is one section".
 */

import type { ParsedBook, ParsedSection } from './types'
import { paragraphsToHtml, sanitizeHtml } from '../lib/sanitize'

const ATX_HEADING_RE = /^(#{1,3})\s+(.+)$/m
const STRIP_PATTERNS: [RegExp, string][] = [
  [/!\[([^\]]*)\]\([^)]+\)/g, '$1'],
  [/\[([^\]]+)\]\([^)]+\)/g, '$1'],
  [/`{3}[^`]*`{3}/gs, ''],
  [/`([^`]+)`/g, '$1'],
  [/\*{2}(.+?)\*{2}/g, '$1'],
  [/\*(.+?)\*/g, '$1'],
  [/_{2}(.+?)_{2}/g, '$1'],
  [/_(.+?)_/g, '$1'],
  [/^>\s?/gm, ''],
  [/^[-*+]\s+/gm, ''],
  [/^\d+\.\s+/gm, ''],
  [/^#{1,6}\s+/gm, ''],
]

function stripMarkdown(text: string): string {
  for (const [pattern, replacement] of STRIP_PATTERNS) {
    text = text.replace(pattern, replacement)
  }
  return text.trim()
}

/**
 * Render markdown to a minimal HTML string. Intentionally simple — handles
 * paragraphs, headings, and emphasis. Anything fancier is out of scope for the
 * formatted view; the source markdown text remains the canonical content.
 */
function markdownToHtml(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let para: string[] = []

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join(' ')}</p>`)
      para = []
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      flushPara()
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed)
    if (heading) {
      flushPara()
      const level = Math.min(heading[1].length, 6)
      out.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`)
      continue
    }
    if (/^[-*+]\s+/.test(trimmed)) {
      flushPara()
      out.push(`<ul><li>${escapeHtml(trimmed.replace(/^[-*+]\s+/, ''))}</li></ul>`)
      continue
    }
    if (/^>\s?/.test(trimmed)) {
      flushPara()
      out.push(`<blockquote>${escapeHtml(trimmed.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }
    para.push(escapeHtml(trimmed))
  }
  flushPara()

  return sanitizeHtml(out.join('\n'))
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function parseMd(data: ArrayBuffer, filename?: string): ParsedBook {
  const content = new TextDecoder('utf-8').decode(data)

  // Title from first H1, otherwise filename, otherwise "Untitled".
  let title = 'Untitled'
  const m = ATX_HEADING_RE.exec(content)
  if (m && m[1].length === 1) title = m[2].trim()
  if (title === 'Untitled' && filename) {
    title = filename.replace(/\.[^.]+$/, '')
  }

  const sectionTitle = (m && m[2].trim()) || 'Untitled'
  const text = stripMarkdown(content)
  const html = markdownToHtml(content) || paragraphsToHtml(text)

  const section: ParsedSection = { title: sectionTitle, text, html }

  return {
    title,
    author: 'Unknown Author',
    contentType: 'text',
    sections: [section],
  }
}
