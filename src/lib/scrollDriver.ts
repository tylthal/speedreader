/**
 * ScrollDriver — single scroll-event multiplexer per scrollable view.
 *
 * The problem
 * -----------
 * Before this abstraction, each scrollable view had three-to-four
 * independently-registered `scroll` listeners:
 *   - PIP position updater      (FormattedView)
 *   - Cursor-sync detector      (useFormattedViewCursorSync)
 *   - Diagnostics / perf probes (various)
 *   - IntersectionObserver for section visibility (separate mechanism)
 * Each listener did its own rAF throttling, its own
 * `getBoundingClientRect()` reads, and its own ad-hoc "is this an
 * engine-driven or user-initiated scroll?" guard. During engine-driven
 * playback at 60 Hz this multiplied into dozens of redundant calls per
 * frame.
 *
 * The design
 * ----------
 * ScrollDriver owns ONE passive `scroll` listener per container, ONE
 * rAF throttle, and ONE FrameRectCache. On each throttled frame it
 * invokes subscribers in a deterministic order, passing a ScrollFrame
 * containing:
 *   - scrollTop  — the latched value at listener dispatch time
 *   - source     — who initiated this motion (engine / user / programmatic / restore)
 *   - rectCache  — shared cache so all subscribers read container rect once
 *
 * The source tag is set by whoever initiates motion (engine tick calls
 * driver.withSource('engine', () => container.scrollTop = ...), auto-
 * scroll calls withSource('programmatic', ...)) and latched at event
 * time. Subscribers gate behavior on `frame.source` instead of threading
 * `isPlaying` / `isProgrammaticScrollRef` through every call site.
 */

import { createFrameRectCache, type FrameRectCache } from './frameRectCache'

export type ScrollSource =
  | 'user' // unknown / default — treat as user-initiated
  | 'engine' // playback engine is driving
  | 'programmatic' // one-shot scrollTo (auto-scroll, restore target)
  | 'restore' // position restoration from saved state

export interface ScrollFrame {
  scrollTop: number
  scrollLeft: number
  source: ScrollSource
  rectCache: FrameRectCache
}

export type ScrollSubscriber = (frame: ScrollFrame) => void

/** Deterministic subscriber invocation order. Subscribers not in this
 *  list are invoked after named ones, in registration order. */
const ORDER: readonly string[] = ['engine', 'pip', 'cursor-sync', 'diagnostics']

export interface ScrollDriver {
  subscribe(name: string, fn: ScrollSubscriber): () => void
  unsubscribe(name: string): void
  /** Current source tag. Reads the latched value. */
  currentSource(): ScrollSource
  /** Set the source for subsequent scroll events until cleared. Use
   *  setSource/clearSource pairs for long-running sessions (engine
   *  playback); use withSource for single writes. */
  setSource(source: ScrollSource): void
  clearSource(): void
  /** Run fn with `source` active, then restore the prior source. Useful
   *  for one-shot programmatic scrolls where the scroll event may fire
   *  synchronously OR asynchronously — source stays latched either way
   *  until the next rAF-dispatched subscriber callback reads it. */
  withSource<T>(source: ScrollSource, fn: () => T): T
  /** The cache used for the current frame. Exposed so imperative call
   *  sites (not through subscribe) can share rect reads. */
  rectCache(): FrameRectCache
  /** Tear down. */
  dispose(): void
}

export function createScrollDriver(container: HTMLElement): ScrollDriver {
  const subs = new Map<string, ScrollSubscriber>()
  const cache = createFrameRectCache()
  let source: ScrollSource = 'user'
  // When a withSource(...) block is active, this holds the prior value.
  // scrollend doesn't always fire, so we can't rely on it to unlatch.
  // The withSource wrapper restores in a finally block, and long-
  // running setSource pairs with clearSource.
  let rafScheduled = false
  let pendingScrollTop = 0
  let pendingScrollLeft = 0

  const fire = () => {
    rafScheduled = false
    // Cache is freshly-flushed every frame by createFrameRectCache's
    // own rAF — but we explicitly invalidate here too because a
    // scroll event mutated scrollTop, which changes every element's
    // viewport rect. Any cached rect from before this frame is stale.
    cache.invalidate()
    const frame: ScrollFrame = {
      scrollTop: pendingScrollTop,
      scrollLeft: pendingScrollLeft,
      source,
      rectCache: cache,
    }
    // Invoke in priority order first, then the rest.
    const seen = new Set<string>()
    for (const name of ORDER) {
      const fn = subs.get(name)
      if (fn) {
        seen.add(name)
        try { fn(frame) } catch (err) { console.error('[scrollDriver]', name, err) }
      }
    }
    for (const [name, fn] of subs) {
      if (seen.has(name)) continue
      try { fn(frame) } catch (err) { console.error('[scrollDriver]', name, err) }
    }
  }

  const onScroll = () => {
    pendingScrollTop = container.scrollTop
    pendingScrollLeft = container.scrollLeft
    if (rafScheduled) return
    rafScheduled = true
    requestAnimationFrame(fire)
  }

  container.addEventListener('scroll', onScroll, { passive: true })

  return {
    subscribe(name, fn) {
      subs.set(name, fn)
      return () => {
        if (subs.get(name) === fn) subs.delete(name)
      }
    },
    unsubscribe(name) {
      subs.delete(name)
    },
    currentSource() {
      return source
    },
    setSource(s) {
      source = s
    },
    clearSource() {
      source = 'user'
    },
    withSource(s, fn) {
      const prev = source
      source = s
      try {
        return fn()
      } finally {
        source = prev
      }
    },
    rectCache() {
      return cache
    },
    dispose() {
      container.removeEventListener('scroll', onScroll)
      subs.clear()
    },
  }
}
