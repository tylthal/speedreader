import { describe, it, expect } from 'vitest'
import { chunkText, chunkSections } from './chunker'

describe('chunkText', () => {
  it('returns empty array for empty input', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   ')).toEqual([])
  })

  it('throws on non-positive wpm', () => {
    expect(() => chunkText('hello', 0)).toThrow('wpm must be positive')
    expect(() => chunkText('hello', -1)).toThrow('wpm must be positive')
  })

  it('chunks a simple sentence into segments', () => {
    const segments = chunkText('The quick brown fox jumps over the lazy dog.')
    expect(segments.length).toBeGreaterThan(0)
    // All segments should have positive word counts and durations
    for (const seg of segments) {
      expect(seg.word_count).toBeGreaterThan(0)
      expect(seg.duration_ms).toBeGreaterThan(0)
      expect(seg.text.length).toBeGreaterThan(0)
    }
  })

  it('preserves all words across segments', () => {
    const input = 'The quick brown fox jumps over the lazy dog.'
    const segments = chunkText(input)
    const reassembled = segments.map((s) => s.text).join(' ')
    // Every word should appear
    for (const word of input.split(/\s+/)) {
      expect(reassembled).toContain(word)
    }
  })

  it('assigns sequential indices starting at 0', () => {
    const segments = chunkText('Hello world. This is a test. Another sentence here.')
    for (let i = 0; i < segments.length; i++) {
      expect(segments[i].index).toBe(i)
    }
  })

  it('handles abbreviations without splitting', () => {
    const segments = chunkText('Dr. Smith met Mrs. Jones at 3 p.m. today.')
    // Should not split on Dr. or Mrs.
    const fullText = segments.map((s) => s.text).join(' ')
    expect(fullText).toContain('Dr.')
    expect(fullText).toContain('Mrs.')
  })

  it('limits phrase length to ~7 words', () => {
    const segments = chunkText(
      'This is a very long sentence that contains many words and should be split into multiple segments.',
    )
    for (const seg of segments) {
      expect(seg.word_count).toBeLessThanOrEqual(8) // some tolerance
    }
  })

  it('adds punctuation pauses for sentence endings', () => {
    const plain = chunkText('Hello world', 250)
    const withPeriod = chunkText('Hello world.', 250)
    // The period version should have a longer duration
    const plainDuration = plain.reduce((sum, s) => sum + s.duration_ms, 0)
    const periodDuration = withPeriod.reduce((sum, s) => sum + s.duration_ms, 0)
    expect(periodDuration).toBeGreaterThan(plainDuration)
  })
})

describe('chunkSections', () => {
  it('throws on non-positive wpm', () => {
    expect(() => chunkSections([], 0)).toThrow('wpm must be positive')
  })

  it('returns empty array for empty input', () => {
    expect(chunkSections([])).toEqual([])
  })

  it('emits a section_title segment at the start of each section', () => {
    const sections = [
      { title: 'Chapter 1', text: 'Some text here.', html: '', meta: {} },
      { title: 'Chapter 2', text: 'More text here.', html: '', meta: {} },
    ]
    const result = chunkSections(sections)
    expect(result).toHaveLength(2)
    expect(result[0].segments[0].kind).toBe('section_title')
    expect(result[0].segments[0].text).toBe('Chapter 1')
    expect(result[1].segments[0].kind).toBe('section_title')
    expect(result[1].segments[0].text).toBe('Chapter 2')
  })

  it('tags segments with section_index', () => {
    const sections = [
      { title: 'A', text: 'Hello world.', html: '', meta: {} },
    ]
    const result = chunkSections(sections)
    for (const seg of result[0].segments) {
      expect(seg.section_index).toBe(0)
    }
  })

  it('handles sections with no text', () => {
    const sections = [
      { title: 'Images Only', text: '', html: '', meta: {} },
    ]
    const result = chunkSections(sections)
    expect(result[0].segments).toHaveLength(1) // just the title
    expect(result[0].segments[0].kind).toBe('section_title')
  })
})
