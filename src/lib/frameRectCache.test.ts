import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFrameRectCache } from './frameRectCache'

describe('frameRectCache', () => {
  let rafCallbacks: Array<() => void> = []

  beforeEach(() => {
    rafCallbacks = []
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: () => void) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function flushRaf() {
    const cbs = rafCallbacks
    rafCallbacks = []
    for (const cb of cbs) cb()
  }

  function makeEl(rect: Partial<DOMRect>): HTMLElement {
    const el = document.createElement('div')
    let calls = 0
    const r = { top: 0, left: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, ...rect } as DOMRect
    el.getBoundingClientRect = () => {
      calls++
      ;(el as unknown as { _calls: number })._calls = calls
      return r
    }
    return el
  }

  it('returns the rect on first call and reuses it on second call in same frame', () => {
    const cache = createFrameRectCache()
    const el = makeEl({ top: 10 })
    const a = cache.rectOf(el)
    const b = cache.rectOf(el)
    expect(a.top).toBe(10)
    expect(b).toBe(a)
    expect((el as unknown as { _calls: number })._calls).toBe(1)
  })

  it('re-queries after the rAF flush', () => {
    const cache = createFrameRectCache()
    const el = makeEl({ top: 5 })
    cache.rectOf(el)
    flushRaf()
    cache.rectOf(el)
    expect((el as unknown as { _calls: number })._calls).toBe(2)
  })

  it('re-queries after explicit invalidate()', () => {
    const cache = createFrameRectCache()
    const el = makeEl({})
    cache.rectOf(el)
    cache.invalidate()
    cache.rectOf(el)
    expect((el as unknown as { _calls: number })._calls).toBe(2)
  })

  it('caches multiple elements independently', () => {
    const cache = createFrameRectCache()
    const a = makeEl({ top: 1 })
    const b = makeEl({ top: 2 })
    expect(cache.rectOf(a).top).toBe(1)
    expect(cache.rectOf(b).top).toBe(2)
    expect((a as unknown as { _calls: number })._calls).toBe(1)
    expect((b as unknown as { _calls: number })._calls).toBe(1)
  })

  it('increments frame counter on flush and invalidate', () => {
    const cache = createFrameRectCache()
    expect(cache.frame()).toBe(0)
    cache.rectOf(makeEl({}))
    flushRaf()
    expect(cache.frame()).toBe(1)
    cache.invalidate()
    expect(cache.frame()).toBe(2)
  })
})
