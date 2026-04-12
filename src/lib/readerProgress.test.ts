import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  readStoredPrefs,
  writeStoredPrefs,
  readStoredPosition,
  writeStoredPosition,
  pickFreshestPosition,
} from './readerProgress'

describe('readStoredPrefs / writeStoredPrefs', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null when nothing is stored', () => {
    expect(readStoredPrefs(999)).toBeNull()
  })

  it('round-trips through write/read', () => {
    writeStoredPrefs(1, { wpm: 300, readingMode: 'rsvp' })
    const result = readStoredPrefs(1)
    expect(result).not.toBeNull()
    expect(result!.wpm).toBe(300)
    expect(result!.readingMode).toBe('rsvp')
  })

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('speedreader_prefs_1', 'not-json')
    expect(readStoredPrefs(1)).toBeNull()
  })

  it('handles localStorage unavailability', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    // Should not throw
    writeStoredPrefs(1, { wpm: 250, readingMode: 'phrase' })
    spy.mockRestore()
  })
})

describe('readStoredPosition / writeStoredPosition', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null when nothing is stored', () => {
    expect(readStoredPosition(999)).toBeNull()
  })

  it('round-trips through write/read', () => {
    writeStoredPosition(1, {
      chapter_id: 2,
      chapter_idx: 1,
      absolute_segment_index: 10,
      word_index: 3,
    })
    const result = readStoredPosition(1)
    expect(result).not.toBeNull()
    expect(result!.chapter_id).toBe(2)
    expect(result!.chapter_idx).toBe(1)
    expect(result!.absolute_segment_index).toBe(10)
    expect(result!.word_index).toBe(3)
    expect(result!.updated_at).toBeDefined()
  })

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('speedreader_position_1', 'not-json')
    expect(readStoredPosition(1)).toBeNull()
  })
})

describe('pickFreshestPosition', () => {
  it('returns null when both are null', () => {
    expect(pickFreshestPosition(null, null)).toBeNull()
  })

  it('returns the only non-null source', () => {
    const bookmark = {
      chapter_id: 1,
      chapter_idx: 0,
      absolute_segment_index: 5,
      word_index: 0,
      updated_at: '2025-01-01T00:00:00Z',
    }
    expect(pickFreshestPosition(bookmark, null)).toBe(bookmark)
    expect(pickFreshestPosition(null, {
      ...bookmark,
    })).toEqual(bookmark)
  })

  it('picks the more recent source', () => {
    const older = {
      chapter_id: 1,
      chapter_idx: 0,
      absolute_segment_index: 0,
      word_index: 0,
      updated_at: '2025-01-01T00:00:00Z',
    }
    const newer = {
      chapter_id: 1,
      chapter_idx: 0,
      absolute_segment_index: 10,
      word_index: 0,
      updated_at: '2025-06-15T12:00:00Z',
    }
    expect(pickFreshestPosition(older, newer)).toBe(newer)
    expect(pickFreshestPosition(newer, older)).toBe(newer)
  })
})
