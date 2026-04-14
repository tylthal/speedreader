import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createScrollDriver } from './scrollDriver'

describe('scrollDriver', () => {
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

  function makeContainer(): HTMLElement {
    const el = document.createElement('div')
    Object.defineProperty(el, 'scrollTop', {
      writable: true,
      value: 0,
    })
    Object.defineProperty(el, 'scrollLeft', {
      writable: true,
      value: 0,
    })
    return el
  }

  it('fires subscribers on scroll with rAF-throttled frame', () => {
    const container = makeContainer()
    const driver = createScrollDriver(container)
    const calls: number[] = []
    driver.subscribe('pip', (f) => calls.push(f.scrollTop))
    ;(container as unknown as { scrollTop: number }).scrollTop = 42
    container.dispatchEvent(new Event('scroll'))
    expect(calls).toEqual([]) // not yet — rAF pending
    flushRaf()
    expect(calls).toEqual([42])
    driver.dispose()
  })

  it('collapses multiple scrolls in one frame into a single dispatch', () => {
    const container = makeContainer()
    const driver = createScrollDriver(container)
    let fires = 0
    driver.subscribe('pip', () => fires++)
    for (let i = 0; i < 10; i++) {
      ;(container as unknown as { scrollTop: number }).scrollTop = i
      container.dispatchEvent(new Event('scroll'))
    }
    flushRaf()
    expect(fires).toBe(1)
    driver.dispose()
  })

  it('passes source to subscribers', () => {
    const container = makeContainer()
    const driver = createScrollDriver(container)
    const seen: string[] = []
    driver.subscribe('pip', (f) => seen.push(f.source))

    driver.setSource('engine')
    container.dispatchEvent(new Event('scroll'))
    flushRaf()

    driver.clearSource()
    container.dispatchEvent(new Event('scroll'))
    flushRaf()

    expect(seen).toEqual(['engine', 'user'])
    driver.dispose()
  })

  it('withSource restores prior source even on throw', () => {
    const container = makeContainer()
    const driver = createScrollDriver(container)
    driver.setSource('engine')
    expect(() =>
      driver.withSource('programmatic', () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(driver.currentSource()).toBe('engine')
    driver.dispose()
  })

  it('invokes subscribers in deterministic order', () => {
    const container = makeContainer()
    const driver = createScrollDriver(container)
    const order: string[] = []
    driver.subscribe('diagnostics', () => order.push('diagnostics'))
    driver.subscribe('cursor-sync', () => order.push('cursor-sync'))
    driver.subscribe('pip', () => order.push('pip'))
    driver.subscribe('engine', () => order.push('engine'))
    driver.subscribe('misc', () => order.push('misc'))

    container.dispatchEvent(new Event('scroll'))
    flushRaf()
    expect(order).toEqual(['engine', 'pip', 'cursor-sync', 'diagnostics', 'misc'])
    driver.dispose()
  })

  it('unsubscribe stops further callbacks', () => {
    const container = makeContainer()
    const driver = createScrollDriver(container)
    let n = 0
    const unsub = driver.subscribe('pip', () => n++)
    container.dispatchEvent(new Event('scroll'))
    flushRaf()
    unsub()
    container.dispatchEvent(new Event('scroll'))
    flushRaf()
    expect(n).toBe(1)
    driver.dispose()
  })

  it('dispose detaches the scroll listener', () => {
    const container = makeContainer()
    const driver = createScrollDriver(container)
    let n = 0
    driver.subscribe('pip', () => n++)
    driver.dispose()
    container.dispatchEvent(new Event('scroll'))
    flushRaf()
    expect(n).toBe(0)
  })
})
