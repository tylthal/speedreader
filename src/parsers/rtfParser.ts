/**
 * RTF parser (PRD §3.1) — single ParsedSection. The RTF stripping logic is
 * unchanged; only the post-strip splitting was removed.
 */

import type { ParsedBook, ParsedSection } from './types'
import { paragraphsToHtml } from '../lib/sanitize'

// ---------------------------------------------------------------------------
// Minimal RTF stripper (port of striprtf logic)
// ---------------------------------------------------------------------------

function rtfToText(rtf: string): string {
  const output: string[] = []
  let i = 0
  let groupDepth = 0
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
      if (i + 1 < rtf.length && rtf[i + 1] === '\\') {
        let j = i + 2
        let word = ''
        while (j < rtf.length && /[a-z]/.test(rtf[j])) {
          word += rtf[j]
          j++
        }
        if (word === '*') {
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
      if (skipDepth === groupDepth) skipDepth = 0
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

      if (next === '\\' || next === '{' || next === '}') {
        output.push(next)
        i++
        continue
      }

      if (/[a-z]/i.test(next)) {
        let word = ''
        let j = i
        while (j < rtf.length && /[a-z]/i.test(rtf[j])) {
          word += rtf[j]
          j++
        }
        let param = ''
        while (j < rtf.length && /[-\d]/.test(rtf[j])) {
          param += rtf[j]
          j++
        }
        if (j < rtf.length && rtf[j] === ' ') j++
        i = j

        if (word === 'par' || word === 'line') output.push('\n')
        else if (word === 'tab') output.push('\t')
        else if (word === 'u') {
          const code = parseInt(param, 10)
          if (!isNaN(code)) {
            output.push(String.fromCodePoint(code < 0 ? code + 65536 : code))
          }
          if (i < rtf.length && rtf[i] === '?') i++
        } else if (word === 'lquote') output.push('\u2018')
        else if (word === 'rquote') output.push('\u2019')
        else if (word === 'ldblquote') output.push('\u201c')
        else if (word === 'rdblquote') output.push('\u201d')
        else if (word === 'emdash') output.push('\u2014')
        else if (word === 'endash') output.push('\u2013')
        else if (word === 'bullet') output.push('\u2022')

        if (SKIP_DESTINATIONS.has(word)) skipDepth = groupDepth
        continue
      }

      if (next === "'") {
        const hex = rtf.slice(i + 1, i + 3)
        const code = parseInt(hex, 16)
        if (!isNaN(code)) output.push(String.fromCharCode(code))
        i += 3
        continue
      }

      i++
      continue
    }

    if (ch === '\r' || ch === '\n') {
      i++
      continue
    }
    output.push(ch)
    i++
  }

  return output.join('')
}

export function parseRtf(data: ArrayBuffer, filename?: string): ParsedBook {
  const rtfContent = new TextDecoder('utf-8', { fatal: false }).decode(data)
  const text = rtfToText(rtfContent).trim()

  if (!text) throw new Error('RTF file contains no readable text.')

  const firstLine = text.split('\n')[0]?.trim() ?? ''
  let title = 'Untitled'
  if (firstLine && firstLine.length < 100) {
    title = firstLine
  } else if (filename) {
    title = filename.replace(/\.[^.]+$/, '')
  }

  const section: ParsedSection = {
    title: title || 'Untitled',
    text,
    html: paragraphsToHtml(text),
  }

  return {
    title,
    author: 'Unknown Author',
    contentType: 'text',
    sections: [section],
  }
}
