/**
 * FrameRectCache — a per-rAF cache for getBoundingClientRect() reads.
 *
 * Hot scroll paths in this codebase read the same container's bounding
 * rect multiple times per frame: the PIP updater reads it, the segment-
 * range materializer reads it, the segment-detection path reads it, and
 * during engine playback the tick loop reads it again. Each call forces
 * a layout flush. Collapsing them into a single read per frame is worth
 * measurable frame-time.
 *
 * Design
 * ------
 * - One cache instance per view (not global). Avoids cross-view poisoning
 *   and makes the cache's lifetime unambiguous — it lives as long as the
 *   component that owns it.
 * - Entries are keyed by Element identity (WeakMap), so GC'd elements
 *   don't leak cache slots.
 * - The cache auto-invalidates on the next animation frame. The first
 *   rectOf() call in a frame schedules an rAF that bumps the frame
 *   counter; reads against a stale counter re-query the DOM.
 * - Explicit invalidate() lets callers drop the cache after they know
 *   they mutated layout (e.g. after writing scrollTop, after adjusting
 *   innerHTML).
 *
 * This primitive is passed through ScrollFrame to subscribers so all
 * code running inside a single scroll-driven rAF reads through the same
 * cache without threading it manually.
 */

export interface FrameRectCache {
  /** Read a cached rect, or query + cache. */
  rectOf(el: Element): DOMRect
  /** Drop all cached rects. Call after DOM mutations that invalidate
   *  geometry (scrollTop write, innerHTML rewrite, layout-relevant
   *  style change). */
  invalidate(): void
  /** Current frame counter. Increments on each auto-flush so stale
   *  reads in the next frame re-query automatically. Useful for tests. */
  frame(): number
}

export function createFrameRectCache(): FrameRectCache {
  let rects = new WeakMap<Element, DOMRect>()
  let frameNo = 0
  let scheduled = false

  const scheduleFlush = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      rects = new WeakMap()
      frameNo++
    })
  }

  return {
    rectOf(el: Element): DOMRect {
      const hit = rects.get(el)
      if (hit) return hit
      const rect = el.getBoundingClientRect()
      rects.set(el, rect)
      scheduleFlush()
      return rect
    },
    invalidate(): void {
      rects = new WeakMap()
      frameNo++
    },
    frame(): number {
      return frameNo
    },
  }
}
