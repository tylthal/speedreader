import { describe, it, expect, beforeEach, vi } from 'vitest'
import { safeGetItem, safeSetItem, safeRemoveItem } from './safeStorage'

describe('safeStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips through set/get', () => {
    expect(safeSetItem('key', 'value')).toBe(true)
    expect(safeGetItem('key')).toBe('value')
  })

  it('returns null for missing keys', () => {
    expect(safeGetItem('nonexistent')).toBeNull()
  })

  it('removes items', () => {
    safeSetItem('key', 'value')
    safeRemoveItem('key')
    expect(safeGetItem('key')).toBeNull()
  })

  it('handles setItem failure gracefully', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(safeSetItem('key', 'value')).toBe(false)
    spy.mockRestore()
  })

  it('handles getItem failure gracefully', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(safeGetItem('key')).toBeNull()
    spy.mockRestore()
  })
})
