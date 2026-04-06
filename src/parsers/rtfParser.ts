/**
 * RTF parser. Port of backend/rtf_parser.py.
 * Includes a minimal RTF-to-text stripper (replaces Python's striprtf).
 */

import type { ParsedBook } from './types'

const MIN_CHAPTER_LENGTH = 50
const FALLBACK_WORD_LIMIT = 3000

const CHAPTER_HEADING_RE = /^\s*(chapter|part|section|prologue|epilogue)\s*[\s.:—\-]*(\d+|[ivxlcdm]+)?\s*[.:—\-]?\s*(.*)$/i

// ---------------------------------------------------------------------------
// Minimal RTF stripper (port of striprtf logic)
// ---------------------------------------------------------------------------

/**
 * Convert RTF content to plain text.
 * Handles control words for Unicode, special characters, and groups.
 */
function rtfToText(rtf: string): string {
  const output: string[] = []
  let i = 0
  let groupDepth = 0
  // Track skip depth for groups like {\fonttbl ...}, {\colortbl ...}, etc.
  let skipDepth = 0

  const SKIP_DESTINATIONS = new Set([
    'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict',
    'header', 'footer', 'headerl', 'headerr', 'footerl', 'footerr',
    'object', 'blipuid', 'datafield', 'themedata', 'colorschememapping',
    'latentstyles', 'datastore', 'fldinst',
  ])

  while (i < rtf.length) {
    const ch = rtf[i]

    if (ch === '{') {
      groupDepth++
      // Check if the next thing is a skip destination
      if (i + 1 < rtf.length && rtf[i + 1] === '\\') {
        // Peek at the control word
        let j = i + 2
        let word = ''
        while (j < rtf.length && /[a-z]/.test(rtf[j])) {
          word += rtf[j]
          j++
        }
        if (word === '*') {
          // {\* destination} — skip it
          skipDepth = groupDepth
          i++
          continue
        }
        if (SKIP_DESTINATIONS.has(word)) {
          skipDepth = groupDepth
          i++
          continue
        }
      }
      i++
      continue
    }

    if (ch === '}') {
      if (skipDepth === groupDepth) {
        skipDepth = 0
      }
      groupDepth--
      i++
      continue
    }

    if (skipDepth > 0) {
      i++
      continue
    }

    if (ch === '\\') {
      i++
      if (i >= rtf.length) break

      const next = rtf[i]

      // Escaped special characters
      if (next === '\\' || next === '{' || next === '}') {
        output.push(next)
        i++
        continue
      }

      // Control word
      if (/[a-z]/i.test(next)) {
        let word = ''
        let j = i
        while (j < rtf.length && /[a-z]/i.test(rtf[j])) {
          word += rtf[j]
          j++
        }
        // Optional numeric parameter
        let param = ''
        while (j < rtf.length && /[-\d]/.test(rtf[j])) {
          param += rtf[j]
          j++
        }
        // Space delimiter (consumed but not output)
        if (j < rtf.length && rtf[j] === ' ') j++

        i = j

        // Handle specific control words
        if (word === 'par' || word === 'line') {
          output.push('\n')
        } else if (word === 'tab') {
          output.push('\t')
        } else if (word === 'u') {
          // Unicode character: \uN
          const code = parseInt(param, 10)
          if (!isNaN(code)) {
            output.push(String.fromCodePoint(code < 0 ? code + 65536 : code))
          }
          // Skip the substitution character (typically ?)
          if (i < rtf.length && rtf[i] === '?') i++
        } else if (word === 'lquote') {
          output.push('\u2018')
        } else if (word === 'rquote') {
          output.push('\u2019')
        } else if (word === 'ldblquote') {
          output.push('\u201c')
        } else if (word === 'rdblquote') {
          output.push('\u201d')
        } else if (word === 'emdash') {
          output.push('\u2014')
        } else if (word === 'endash') {
          output.push('\u2013')
        } else if (word === 'bullet') {
          output.push('\u2022')
        }
        // Skip destinations that start a new skip scope
        if (SKIP_DESTINATIONS.has(word)) {
          skipDepth = groupDepth
        }
        continue
      }

      // Hex escape: \'xx
      if (next === "'") {
        const hex = rtf.slice(i + 1, i + 3)
        const code = parseInt(hex, 16)
        if (!isNaN(code)) {
          output.push(String.fromCharCode(code))
        }
        i += 3
        continue
      }

      // Unknown escape, skip
      i++
      continue
    }

    // Regular character
    if (ch === '\r' || ch === '\n') {
      i++
      continue
    }

    output.push(ch)
    i++
  }

  return output.join('')
}

// ---------------------------------------------------------------------------
// Chapter splitting (same as txt/rtf Python logic)
// ---------------------------------------------------------------------------

function splitByHeadings(text: string): { title: string; text: string }[] {
  const lines = text.split('\n')
  const chapters: { title: string; text: string }[] = []
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

function splitByWordCount(text: string, limit = FALLBACK_WORD_LIMIT): { title: string; text: string }[] {
  const words = text.split(/\s+/)
  const chapters: { title: string; text: string }[] = []
  for (let start = 0; start < words.length; start += limit) {
    const chunk = words.slice(start, start + limit).join(' ').trim()
    if (chunk.length >= MIN_CHAPTER_LENGTH) {
      chapters.push({ title: `Chapter ${chapters.length + 1}`, text: chunk })
    }
  }
  return chapters
}

export function parseRtf(data: ArrayBuffer): ParsedBook {
  const rtfContent = new TextDecoder('utf-8', { fatal: false }).decode(data)
  const text = rtfToText(rtfContent)

  if (!text.trim()) {
    throw new Error('RTF file contains no readable text.')
  }

  const lines = text.trim().split('\n')
  const title = lines.length ? lines[0].trim().slice(0, 100) : 'Untitled'

  let chapters = splitByHeadings(text)
  if (!chapters.length) chapters = splitByWordCount(text)

  return {
    title,
    author: 'Unknown Author',
    contentType: 'text',
    chapters: chapters.map((c) => ({ ...c, inlineImages: [] })),
    imageChapters: [],
  }
}
