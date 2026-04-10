import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  progressStorageKey,
  buildStoredProgress,
  readStoredProgress,
  writeStoredProgress,
  pickFreshestProgress,
} from './readerProgress'

describe('progressStorageKey', () => {
  it('returns namespaced key', () => {
    expect(progressStorageKey(42)).toBe('speedreader_progress_42')
  })
})

describe('buildStoredProgress', () => {
  it('builds a ReadingProgress object', () => {
    const result = buildStoredProgress(1, {
      chapterId: 2,
      absoluteSegmentIndex: 10,
      wordIndex: 3,
      wpm: 300,
      readingMode: 'phrase',
    })
    expect(result.publication_id).toBe(1)
    expect(result.chapter_id).toBe(2)
    expect(result.absolute_segment_index).toBe(10)
    expect(result.word_index).toBe(3)
    expect(result.wpm).toBe(300)
    expect(result.reading_mode).toBe('phrase')
    expect(result.updated_at).toBeDefined()
  })
})

describe('readStoredProgress / writeStoredProgress', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null when nothing is stored', () => {
    expect(readStoredProgress(999)).toBeNull()
  })

  it('round-trips through write/read', () => {
    writeStoredProgress(1, {
      chapterId: 2,
      absoluteSegmentIndex: 5,
      wordIndex: 0,
      wpm: 250,
      readingMode: 'rsvp',
    })
    const result = readStoredProgress(1)
    expect(result).not.toBeNull()
    expect(result!.publication_id).toBe(1)
    expect(result!.chapter_id).toBe(2)
    expect(result!.absolute_segment_index).toBe(5)
    expect(result!.reading_mode).toBe('rsvp')
  })

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('speedreader_progress_1', 'not-json')
    expect(readStoredProgress(1)).toBeNull()
  })

  it('handles localStorage unavailability', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    // Should not throw
    writeStoredProgress(1, {
      chapterId: 1,
      absoluteSegmentIndex: 0,
      wordIndex: 0,
      wpm: 250,
      readingMode: 'phrase',
    })
    spy.mockRestore()
  })
})

describe('pickFreshestProgress', () => {
  it('returns null when all candidates are null', () => {
    expect(pickFreshestProgress(null, null)).toBeNull()
  })

  it('returns the only non-null candidate', () => {
    const p = {
      publication_id: 1,
      chapter_id: 1,
      absolute_segment_index: 0,
      word_index: 0,
      wpm: 250,
      reading_mode: 'phrase',
      updated_at: '2025-01-01T00:00:00Z',
      segments_read: 0,
    }
    expect(pickFreshestProgress(null, p)).toBe(p)
    expect(pickFreshestProgress(p, null)).toBe(p)
  })

  it('picks the more recent candidate', () => {
    const older = {
      publication_id: 1,
      chapter_id: 1,
      absolute_segment_index: 0,
      word_index: 0,
      wpm: 250,
      reading_mode: 'phrase',
      updated_at: '2025-01-01T00:00:00Z',
      segments_read: 0,
    }
    const newer = {
      ...older,
      absolute_segment_index: 10,
      updated_at: '2025-06-15T12:00:00Z',
    }
    expect(pickFreshestProgress(older, newer)).toBe(newer)
    expect(pickFreshestProgress(newer, older)).toBe(newer)
  })
})
