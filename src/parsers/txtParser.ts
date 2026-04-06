/**
 * Plain text parser. Port of backend/txt_parser.py.
 */

import type { ParsedBook, ParsedChapter } from './types'

const CHAPTER_HEADING_RE = /^\s*(chapter|part|book|section|prologue|epilogue|introduction|preface)[\s.:—\-]*(\d+|[ivxlcdm]+)?\s*[.:—\-]?\s*(.*)$/i
const SEPARATOR_RE = /^[\s*=\-_#]{3,}$/
const MIN_CHAPTER_LENGTH = 50
const FALLBACK_WORD_LIMIT = 3000

function detectEncoding(data: ArrayBuffer): string {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return 'utf-8'
  } catch {
    return 'windows-1252'
  }
}

interface SimpleChapter { title: string; text: string }

function splitByHeadings(text: string): SimpleChapter[] {
  const lines = text.split('\n')
  const chapters: SimpleChapter[] = []
  let currentTitle = ''
  let currentLines: string[] = []

  for (const line of lines) {
    if (CHAPTER_HEADING_RE.test(line.trim())) {
      if (currentLines.length) {
        const body = currentLines.join('\n').trim()
        if (body.length >= MIN_CHAPTER_LENGTH) {
          chapters.push({ title: currentTitle || `Chapter ${chapters.length + 1}`, text: body })
        }
      }
      currentTitle = line.trim()
      currentLines = []
    } else {
      currentLines.push(line)
    }
  }

  if (currentLines.length) {
    const body = currentLines.join('\n').trim()
    if (body.length >= MIN_CHAPTER_LENGTH) {
      chapters.push({ title: currentTitle || `Chapter ${chapters.length + 1}`, text: body })
    }
  }

  return chapters
}

function splitBySeparators(text: string): SimpleChapter[] {
  const lines = text.split('\n')
  const sections: string[][] = [[]]

  for (const line of lines) {
    if (SEPARATOR_RE.test(line.trim()) && sections[sections.length - 1].length) {
      sections.push([])
    } else {
      sections[sections.length - 1].push(line)
    }
  }

  const chapters: SimpleChapter[] = []
  for (const sectionLines of sections) {
    const body = sectionLines.join('\n').trim()
    if (body.length >= MIN_CHAPTER_LENGTH) {
      chapters.push({ title: `Section ${chapters.length + 1}`, text: body })
    }
  }

  return chapters.length > 1 ? chapters : []
}

function splitByWordCount(text: string, limit = FALLBACK_WORD_LIMIT): SimpleChapter[] {
  const words = text.split(/\s+/)
  if (!words.length) return []

  const chapters: SimpleChapter[] = []
  for (let start = 0; start < words.length; start += limit) {
    const chunk = words.slice(start, start + limit).join(' ').trim()
    if (chunk.length >= MIN_CHAPTER_LENGTH) {
      chapters.push({ title: `Chapter ${chapters.length + 1}`, text: chunk })
    }
  }
  return chapters
}

export function parseTxt(data: ArrayBuffer, filename?: string): ParsedBook {
  const encoding = detectEncoding(data)
  const text = new TextDecoder(encoding).decode(data)

  const lines = text.trim().split('\n')
  const title = lines.length ? lines[0].trim().slice(0, 100) : (filename ?? 'Untitled')

  let chapters = splitByHeadings(text)
  if (!chapters.length) chapters = splitBySeparators(text)
  if (!chapters.length) {
    // Double blank line splitting
    const sections = text.split(/\n\s*\n\s*\n/)
    if (sections.length > 3) {
      chapters = []
      for (const section of sections) {
        const s = section.trim()
        if (s.length >= MIN_CHAPTER_LENGTH) {
          chapters.push({ title: `Section ${chapters.length + 1}`, text: s })
        }
      }
    }
  }
  if (!chapters.length) chapters = splitByWordCount(text)

  return {
    title,
    author: 'Unknown Author',
    contentType: 'text',
    chapters: chapters.map((c) => ({ ...c, inlineImages: [] })),
    imageChapters: [],
  }
}
