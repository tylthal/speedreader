import { describe, it, expect } from 'vitest'
import { shallowEqual } from './shallowEqual'

describe('shallowEqual', () => {
  it('returns true for identical refs', () => {
    const a = { x: 1 }
    expect(shallowEqual(a, a)).toBe(true)
  })

  it('returns true for objects with same shallow values', () => {
    expect(shallowEqual({ x: 1, y: 'a' }, { x: 1, y: 'a' })).toBe(true)
  })

  it('returns false when a value differs', () => {
    expect(shallowEqual({ x: 1 }, { x: 2 })).toBe(false)
  })

  it('returns false for different key sets', () => {
    expect(shallowEqual({ x: 1 } as Record<string, unknown>, { y: 1 } as Record<string, unknown>)).toBe(false)
  })

  it('returns false for different key counts', () => {
    expect(shallowEqual({ x: 1 } as Record<string, unknown>, { x: 1, y: 2 } as Record<string, unknown>)).toBe(false)
  })

  it('treats NaN as equal (Object.is semantics)', () => {
    expect(shallowEqual({ x: NaN }, { x: NaN })).toBe(true)
  })

  it('distinguishes +0 and -0 (Object.is semantics)', () => {
    expect(shallowEqual({ x: 0 }, { x: -0 })).toBe(false)
  })

  it('does not recurse — nested objects compared by identity', () => {
    const nested = { a: 1 }
    expect(shallowEqual({ x: nested }, { x: nested })).toBe(true)
    expect(shallowEqual({ x: { a: 1 } }, { x: { a: 1 } })).toBe(false)
  })
})
