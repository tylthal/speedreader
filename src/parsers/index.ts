/**
 * Format router: dispatches to the correct parser based on file extension.
 */

import type { ParsedBook } from './types'

export type { ParsedBook, ParsedChapter, InlineImage, ImagePage, ParsedImageChapter } from './types'
export { chunkText } from './chunker'
export type { Segment } from './chunker'

const UNSUPPORTED_FORMATS: Record<string, string> = {
  '.mobi': 'MOBI files must be converted to EPUB first (use Calibre).',
  '.azw3': 'AZW3 files must be converted to EPUB first (use Calibre).',
  '.djvu': 'DJVU files must be converted to PDF first.',
  '.cbr': 'CBR (RAR) files must be converted to CBZ first.',
}

function detectExtension(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.fb2.zip')) return '.fb2'
  const dot = lower.lastIndexOf('.')
  return dot >= 0 ? lower.slice(dot) : ''
}

export async function parseFile(
  data: ArrayBuffer,
  filename: string,
): Promise<ParsedBook> {
  const ext = detectExtension(filename)

  const unsupported = UNSUPPORTED_FORMATS[ext]
  if (unsupported) throw new Error(unsupported)

  switch (ext) {
    case '.epub': {
      const { parseEpub } = await import('./epubParser')
      return parseEpub(data)
    }
    case '.pdf': {
      const { parsePdf } = await import('./pdfParser')
      return parsePdf(data)
    }
    case '.fb2': {
      const { parseFb2 } = await import('./fb2Parser')
      return parseFb2(data, filename)
    }
    case '.html':
    case '.htm': {
      const { parseHtml } = await import('./htmlParser')
      return parseHtml(data)
    }
    case '.md':
    case '.markdown': {
      const { parseMd } = await import('./mdParser')
      return parseMd(data, filename)
    }
    case '.txt': {
      const { parseTxt } = await import('./txtParser')
      return parseTxt(data, filename)
    }
    case '.docx': {
      const { parseDocx } = await import('./docxParser')
      return parseDocx(data)
    }
    case '.rtf': {
      const { parseRtf } = await import('./rtfParser')
      return parseRtf(data)
    }
    case '.cbz': {
      const { parseCbz } = await import('./cbzParser')
      return parseCbz(data, filename)
    }
    default:
      throw new Error(`Unsupported format: ${ext || '(unknown)'}`)
  }
}
