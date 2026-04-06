/**
 * Phrase-based text chunker for speed-reading segments.
 * Direct port of backend/chunker.py.
 */

export interface Segment {
  index: number
  text: string
  word_count: number
  duration_ms: number
}

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'etc', 'prof', 'sr', 'jr',
  'gen', 'gov', 'sgt', 'cpl', 'pvt', 'capt', 'lt', 'col', 'maj',
  'dept', 'univ', 'inc', 'corp', 'ltd', 'co', 'jan', 'feb', 'mar',
  'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
])

const DOTTED_ABBREVS_RE = /\b(?:e\.g|i\.e|a\.m|p\.m|a\.k\.a|U\.S|U\.K)\./gi

const ABBR_PLACEHOLDER = '\x00ABBR\x00'

const SENTENCE_SPLIT_RE = /([.!?]["'\)\]]?)\s+(?=[A-Z])/

function splitSentences(text: string): string[] {
  if (!text) return []

  // Protect dotted abbreviations
  let protected_ = text.replace(DOTTED_ABBREVS_RE, (m) =>
    m.replaceAll('.', ABBR_PLACEHOLDER),
  )

  // Protect simple abbreviations
  const abbrList = [...ABBREVIATIONS].sort((a, b) => b.length - a.length)
  const abbrPattern = new RegExp(
    '\\b(' + abbrList.map(escapeRegExp).join('|') + ')\\.',
    'gi',
  )
  protected_ = protected_.replace(abbrPattern, (m) =>
    m.replaceAll('.', ABBR_PLACEHOLDER),
  )

  // Split on sentence boundaries
  const parts = protected_.split(SENTENCE_SPLIT_RE)

  // Re-assemble: parts alternate between text and captured punctuation
  const sentences: string[] = []
  let i = 0
  while (i < parts.length) {
    let piece = parts[i]
    if (i + 1 < parts.length) {
      piece += parts[i + 1]
      i += 2
    } else {
      i += 1
    }
    const restored = piece.replaceAll(ABBR_PLACEHOLDER, '.').trim()
    if (restored) {
      sentences.push(restored)
    }
  }

  return sentences
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Phrase splitting
// ---------------------------------------------------------------------------

const PHRASE_DELIMITERS_RE = /(?<=[,;:\u2014)\]])\s+|\s+(?=[\u2014(])/

const CONJUNCTIONS = new Set([
  'and', 'but', 'or', 'nor', 'yet', 'so', 'for',
  'which', 'that', 'who', 'when', 'where', 'while',
  'although', 'because', 'since', 'if', 'unless',
])

function splitAtConjunctions(words: string[], maxWords = 7): string[][] {
  if (words.length <= maxWords) return [words]

  // Find conjunction positions (not first or last word)
  const conjPositions: number[] = []
  for (let i = 1; i < words.length - 1; i++) {
    if (CONJUNCTIONS.has(words[i].toLowerCase().replace(/[.,;:!?]$/, ''))) {
      conjPositions.push(i)
    }
  }

  if (conjPositions.length > 0) {
    const mid = Math.floor(words.length / 2)
    const best = conjPositions.reduce((a, b) =>
      Math.abs(a - mid) <= Math.abs(b - mid) ? a : b,
    )
    const left = words.slice(0, best)
    const right = words.slice(best)
    const result: string[][] = []
    result.push(...splitAtConjunctions(left, maxWords))
    result.push(...splitAtConjunctions(right, maxWords))
    return result
  }

  // No conjunction — split at midpoint
  const mid = Math.floor(words.length / 2)
  return [words.slice(0, mid), words.slice(mid)]
}

function splitIntoPhrases(sentence: string): string[] {
  const rawPhrases = sentence.split(PHRASE_DELIMITERS_RE)

  const result: string[] = []
  for (const raw of rawPhrases) {
    const phrase = raw.trim()
    if (!phrase) continue
    const words = phrase.split(/\s+/)
    if (words.length === 0) continue

    if (words.length <= 7) {
      result.push(phrase)
    } else {
      for (const chunkWords of splitAtConjunctions(words, 7)) {
        if (chunkWords.length > 0) {
          result.push(chunkWords.join(' '))
        }
      }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Duration calculation
// ---------------------------------------------------------------------------

const LONG_WORD_THRESHOLD = 8

function computeDuration(text: string, wordCount: number, wpm: number): number {
  if (wordCount === 0) return 0

  let baseMs = (wordCount / wpm) * 60_000

  // Punctuation pauses
  const stripped = text.trimEnd()
  if (stripped) {
    const lastChar = stripped[stripped.length - 1]
    if (lastChar === '.' || lastChar === '!' || lastChar === '?') {
      baseMs += 300
    } else if (lastChar === ',' || lastChar === ';') {
      baseMs += 150
    } else if (lastChar === ':') {
      baseMs += 200
    }
  }

  // Long-word penalty
  const words = text.split(/\s+/)
  let longWords = 0
  for (const w of words) {
    if (w.length > LONG_WORD_THRESHOLD) longWords++
  }
  baseMs += longWords * 50

  return Math.max(1, Math.round(baseMs))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function chunkText(text: string, wpm = 250): Segment[] {
  if (!text || !text.trim()) return []
  if (wpm <= 0) throw new Error('wpm must be positive')

  const sentences = splitSentences(text.trim())
  const segments: Segment[] = []
  let index = 0

  for (const sentence of sentences) {
    const phrases = splitIntoPhrases(sentence)
    for (const raw of phrases) {
      const phrase = raw.trim()
      if (!phrase) continue
      const words = phrase.split(/\s+/)
      const wc = words.length
      if (wc === 0) continue
      const duration = computeDuration(phrase, wc, wpm)
      segments.push({ index, text: phrase, word_count: wc, duration_ms: duration })
      index++
    }
  }

  return segments
}
