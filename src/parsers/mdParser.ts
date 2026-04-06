/**
 * Markdown parser. Port of backend/md_parser.py.
 */

import type { ParsedBook } from './types'

const MIN_CHAPTER_LENGTH = 50

const ATX_HEADING_RE = /^(#{1,3})\s+(.+)$/gm
const SETEXT_H1_RE = /^(.+)\n={3,}\s*$/gm
const SETEXT_H2_RE = /^(.+)\n-{3,}\s*$/gm

const STRIP_PATTERNS: [RegExp, string][] = [
  [/!\[([^\]]*)\]\([^)]+\)/g, '$1'],             // images
  [/\[([^\]]+)\]\([^)]+\)/g, '$1'],               // links
  [/`{3}[^`]*`{3}/gs, ''],                        // fenced code blocks
  [/`([^`]+)`/g, '$1'],                            // inline code
  [/\*{2}(.+?)\*{2}/g, '$1'],                     // bold
  [/\*(.+?)\*/g, '$1'],                            // italic
  [/_{2}(.+?)_{2}/g, '$1'],                        // bold underscore
  [/_(.+?)_/g, '$1'],                              // italic underscore
  [/^>\s?/gm, ''],                                 // blockquotes
  [/^[-*+]\s+/gm, ''],                             // unordered lists
  [/^\d+\.\s+/gm, ''],                             // ordered lists
  [/^#{1,6}\s+/gm, ''],                            // heading markers
]

function stripMarkdown(text: string): string {
  for (const [pattern, replacement] of STRIP_PATTERNS) {
    text = text.replace(pattern, replacement)
  }
  return text.trim()
}

export function parseMd(data: ArrayBuffer, filename?: string): ParsedBook {
  const content = new TextDecoder('utf-8').decode(data)

  // Find all headings with positions
  const headings: { pos: number; level: number; title: string }[] = []

  for (const m of content.matchAll(ATX_HEADING_RE)) {
    headings.push({ pos: m.index!, level: m[1].length, title: m[2].trim() })
  }
  for (const m of content.matchAll(SETEXT_H1_RE)) {
    headings.push({ pos: m.index!, level: 1, title: m[1].trim() })
  }
  for (const m of content.matchAll(SETEXT_H2_RE)) {
    headings.push({ pos: m.index!, level: 2, title: m[1].trim() })
  }

  headings.sort((a, b) => a.pos - b.pos)

  // Title from first h1 or filename
  let title = 'Untitled'
  for (const h of headings) {
    if (h.level === 1) { title = h.title; break }
  }
  if (title === 'Untitled' && filename) {
    title = filename.replace(/\.[^.]+$/, '')
  }

  // Split at h1/h2 boundaries
  const chapterHeadings = headings.filter((h) => h.level <= 2)
  const chapters: { title: string; text: string }[] = []

  if (chapterHeadings.length) {
    for (let i = 0; i < chapterHeadings.length; i++) {
      const start = chapterHeadings[i].pos
      const end = i + 1 < chapterHeadings.length ? chapterHeadings[i + 1].pos : content.length
      const text = stripMarkdown(content.slice(start, end))
      if (text.length >= MIN_CHAPTER_LENGTH) {
        chapters.push({ title: chapterHeadings[i].title, text })
      }
    }
  }

  if (!chapters.length) {
    const text = stripMarkdown(content)
    if (text.length >= MIN_CHAPTER_LENGTH) {
      chapters.push({ title, text })
    }
  }

  return {
    title,
    author: 'Unknown Author',
    contentType: 'text',
    chapters: chapters.map((c) => ({ ...c, inlineImages: [] })),
    imageChapters: [],
  }
}
