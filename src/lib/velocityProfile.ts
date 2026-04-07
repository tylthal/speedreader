/**
 * Velocity profile for the formatted-view auto-scroll engine.
 *
 * Background
 * ----------
 * In scroll/track playback modes the engine pushes `container.scrollTop`
 * forward each rAF tick. The naive model picks a single px-per-second value
 * for the whole chapter (`pxPerSec = sectionHeight / sectionWords * wpm/60`),
 * but that races past code blocks, tables, and images at the same speed it
 * scrolls plain prose — none of which respects the cognitive density of the
 * underlying content.
 *
 * The velocity profile fixes that by walking the formatted-view DOM once
 * after each layout change and producing a sorted list of `ProfileEntry`
 * records, one per top-level block element. Each entry carries:
 *   - `topPx` / `bottomPx` — container-relative coordinates so they're
 *     directly comparable to `container.scrollTop`
 *   - `weight` — an "effective word count" derived from the element type,
 *     so a `<pre>` block contributes 3× its base words, a `<table>` adds
 *     dwell time per cell, an `<img>` is converted to a synthetic word
 *     budget based on its area, etc.
 *   - `pxPerWeight = heightPx / weight`, cached so the engine's tick loop
 *     never has to divide
 *
 * The engine, instead of using a constant px/sec, calls
 * `getPxPerWeight(profile, scrollCenter)` each tick and multiplies the
 * result by `wpm/60` to get px/sec for that instant. The lookup is O(log n)
 * via binary search and uses an adjacency cache so consecutive ticks usually
 * resolve in O(1).
 *
 * Velocity formula derivation
 * ---------------------------
 * Define `v_w = wpm / 60` (target words/sec across the document). For an
 * element with weight `w` and height `h`, we want it to occupy `w / v_w`
 * seconds of scroll time, so the local px/sec is:
 *   pxPerSec = h / (w / v_w) = (h / w) * v_w = pxPerWeight * (wpm / 60)
 *
 * Total document time at constant `wpm` is therefore `totalWeight / v_w`,
 * independent of pixel layout — `weight` is the conserved currency.
 *
 * Smoothing
 * ---------
 * Hard velocity changes at element boundaries are perceptible (a 3× speed
 * drop entering a code block looks like the page hit a brake). The lookup
 * helper linearly interpolates `pxPerWeight` between adjacent entries
 * within a `BLEND_PX` window of the boundary so the transition is gradual.
 */

// ---------------------------------------------------------------------------
// Tunable constants — keep them here so the next person tuning the feel of
// scroll playback only has to read this file.
// ---------------------------------------------------------------------------

/**
 * Half-width (px) of the linear blend window applied at every entry
 * boundary. The two adjacent entries' `pxPerWeight` values are blended
 * linearly across `[boundary - BLEND_PX, boundary + BLEND_PX]`. Larger
 * values produce smoother transitions but spread the speed change over
 * more vertical distance, making the effect of an element type less
 * localized. 40px is roughly two lines of body text at default sizing.
 */
const BLEND_PX = 40

/**
 * Floor applied to every entry's weight. Prevents division explosions on
 * pathological elements (zero-height pre, hidden tables, etc.).
 */
const MIN_WEIGHT = 0.5

/**
 * Heading multipliers — readers anchor on headings and tend to pause to
 * orient themselves. h1/h2 get a stronger pause than h3-h6.
 */
const H1_H2_MULT = 1.8
const H3_H6_MULT = 1.4

/**
 * Code block multiplier — empirical ~3x slower reading speed for code
 * compared to prose. Tune downward if dogfooding shows it feels sluggish.
 */
const CODE_MULT = 3

/**
 * Blockquote multiplier — slight slowdown to give pull quotes a moment.
 */
const BLOCKQUOTE_MULT = 1.2

/**
 * Per-cell dwell weight added to a table's base text words. A 4x4 table
 * with one word per cell ends up at 16 (base words) + 16*2 (cells) = 48
 * effective words, giving it ~3× the dwell of the same words in prose.
 */
const TABLE_CELL_WEIGHT = 2

/**
 * Image weight: `max(IMAGE_MIN_WEIGHT, sqrt(naturalArea) / IMAGE_AREA_DIVISOR)`.
 * A 100×100 thumbnail = max(2, 100/50) = 2.
 * A 800×600 mid image  = max(2, ~692/50) ≈ 13.85.
 * A 1600×2400 full pg  = max(2, ~1960/50) ≈ 39.2.
 * At 250 wpm, that's a 9.4-second dwell on a full-page illustration —
 * enough to actually look at it.
 */
const IMAGE_MIN_WEIGHT = 2
const IMAGE_AREA_DIVISOR = 50

/**
 * Synthetic-image area used when an `<img>` has no `naturalWidth` yet
 * (still loading). Lets the builder produce a non-zero entry instead of
 * waiting; the ResizeObserver/decode-settle path will trigger a rebuild
 * once the real dimensions are known.
 */
const IMAGE_FALLBACK_AREA = 100 * 100

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileEntry {
  /** Container-relative pixel coordinate of the element's top edge. */
  topPx: number
  /** Container-relative pixel coordinate of the element's bottom edge. */
  bottomPx: number
  /** Element height in pixels. */
  heightPx: number
  /** Effective word count assigned to this element. */
  weight: number
  /** `heightPx / weight`, cached so the engine never divides per tick. */
  pxPerWeight: number
  /** Lowercased tag name; useful for the debug overlay. */
  tag: string
}

export interface VelocityProfile {
  /** Sorted ascending by `topPx`, contiguous-ish (gaps for margins are fine). */
  entries: ProfileEntry[]
  /** Sum of `weight` across all entries. */
  totalWeight: number
  /** Sum of `heightPx` across all entries. */
  totalHeight: number
  /** Bumped on every rebuild — useful for debug telemetry. */
  generation: number
  /** `performance.now()` at build time. */
  builtAt: number
}

/**
 * Mutable state passed into `findEntryAt` so consecutive ticks can
 * short-circuit the binary search. The engine owns one of these per
 * profile-using instance.
 */
export interface ProfileLookupCache {
  lastIdx: number
}

export function createLookupCache(): ProfileLookupCache {
  return { lastIdx: 0 }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Top-level block selectors we treat as profile entries. We deliberately
 * avoid descending into `<p>` etc. for inline elements — inline `<code>`
 * is too small to matter and inline `<img>` is rare in body text.
 */
const BLOCK_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, pre, table, blockquote, ul, ol, dl, figure, img, math, svg'

/**
 * Build a velocity profile by walking every block-level element inside
 * `container`, measuring it, and assigning a weight. The build proceeds in
 * two phases:
 *
 *  1. **Read phase** — collect every `getBoundingClientRect()` result into
 *     a temporary array before doing any math. Browsers batch contiguous
 *     reads into a single layout flush, so this stays cheap (~10ms even
 *     for 3000+ elements). Mixing reads with anything that touches layout
 *     would force per-element thrashing.
 *  2. **Compute phase** — pure JS, no DOM access.
 *
 * Nested blocks are deduplicated: if a `<figure>` contains an `<img>`,
 * only the figure becomes an entry (the image's contribution is computed
 * by walking its descendants in `weightForElement`).
 */
export function buildProfile(
  container: HTMLElement,
  generation: number,
): VelocityProfile {
  const containerRect = container.getBoundingClientRect()
  const scrollTop = container.scrollTop

  // Phase 1: collect all candidates and their rects.
  const candidates = container.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)
  type Raw = { el: HTMLElement; rect: DOMRect }
  const raws: Raw[] = []
  for (const el of candidates) {
    raws.push({ el, rect: el.getBoundingClientRect() })
  }

  // Phase 2: dedupe nested entries (skip any element that's a descendant of
  // a previously kept ancestor). We sort by document order — querySelectorAll
  // already returns in document order, so we just iterate and maintain a
  // "last kept ancestor" guard.
  const kept: Raw[] = []
  for (const raw of raws) {
    let isNested = false
    for (let i = kept.length - 1; i >= 0; i--) {
      // Walk backwards: nested elements always come AFTER their ancestors
      // in document order, and once we hit an ancestor we can stop. If the
      // current `kept[i]` is not an ancestor and ends before us, it can't
      // contain anything later either, so we can also stop.
      const k = kept[i]
      if (k.el.contains(raw.el)) {
        isNested = true
        break
      }
      // Optimization: if k ends before raw starts, no earlier kept entry
      // can contain raw either (document order + tree containment).
      if (k.rect.bottom <= raw.rect.top) break
    }
    if (!isNested) kept.push(raw)
  }

  // Phase 3: compute entries.
  const entries: ProfileEntry[] = []
  let totalWeight = 0
  let totalHeight = 0
  for (const { el, rect } of kept) {
    const heightPx = rect.height
    if (heightPx <= 0) continue // display:none, collapsed margins, etc.

    const topPx = rect.top - containerRect.top + scrollTop
    const bottomPx = topPx + heightPx
    const rawWeight = weightForElement(el)
    const weight = Math.max(rawWeight, MIN_WEIGHT)
    const pxPerWeight = heightPx / weight

    entries.push({
      topPx,
      bottomPx,
      heightPx,
      weight,
      pxPerWeight,
      tag: el.tagName.toLowerCase(),
    })
    totalWeight += weight
    totalHeight += heightPx
  }

  // Sort by topPx for binary search. querySelectorAll order is document
  // order, which matches visual order for normal flow content but NOT for
  // floats, absolutely-positioned elements, or grid/flex with order:. We
  // sort defensively.
  entries.sort((a, b) => a.topPx - b.topPx)

  return {
    entries,
    totalWeight,
    totalHeight,
    generation,
    builtAt: typeof performance !== 'undefined' ? performance.now() : Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Weight rules
// ---------------------------------------------------------------------------

/**
 * Compute the effective word count for a single block element. Image-like
 * elements use area-based weight; everything else uses (textContent words ×
 * a per-tag multiplier).
 *
 * For `<figure>` we sum the contributions of its descendants so a figure
 * containing an image and a caption gets both image dwell time and caption
 * read time.
 */
function weightForElement(el: HTMLElement): number {
  const tag = el.tagName.toLowerCase()

  if (tag === 'img') return imageWeight(el as HTMLImageElement)
  if (tag === 'svg' || tag === 'math') return imageLikeWeight(el)

  if (tag === 'figure') {
    // A figure can contain anything — sum descendant contributions.
    let sum = 0
    const imgs = el.querySelectorAll('img')
    for (const img of imgs) sum += imageWeight(img as HTMLImageElement)
    const svgs = el.querySelectorAll('svg, math')
    for (const s of svgs) sum += imageLikeWeight(s as HTMLElement)
    // Caption / surrounding text. Subtract image alt text length so we
    // don't double-count.
    const captionWords = countWords(el.textContent ?? '')
    sum += captionWords
    return sum
  }

  if (tag === 'table') {
    const baseWords = countWords(el.textContent ?? '')
    const cells = el.querySelectorAll('td, th').length
    return baseWords + cells * TABLE_CELL_WEIGHT
  }

  if (tag === 'pre') {
    return countWords(el.textContent ?? '') * CODE_MULT
  }

  if (tag === 'blockquote') {
    return countWords(el.textContent ?? '') * BLOCKQUOTE_MULT
  }

  if (tag === 'h1' || tag === 'h2') {
    return countWords(el.textContent ?? '') * H1_H2_MULT
  }
  if (tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
    return countWords(el.textContent ?? '') * H3_H6_MULT
  }

  // Default: p, ul, ol, dl, and any other block we accidentally captured.
  return countWords(el.textContent ?? '')
}

function imageWeight(img: HTMLImageElement): number {
  // naturalWidth is 0 until the image has loaded. Use a fallback so the
  // first build (before decode-settle) still produces a usable entry; the
  // ResizeObserver path will rebuild once dimensions arrive.
  const w = img.naturalWidth || Math.sqrt(IMAGE_FALLBACK_AREA)
  const h = img.naturalHeight || Math.sqrt(IMAGE_FALLBACK_AREA)
  const area = w * h
  return Math.max(IMAGE_MIN_WEIGHT, Math.sqrt(area) / IMAGE_AREA_DIVISOR)
}

function imageLikeWeight(el: HTMLElement): number {
  // SVG / MathML — fall back to bounding box since they don't have
  // naturalWidth. The caller already has a rect, but to keep the API
  // simple we re-read here. This is fine because it's only called once
  // per build per element.
  const rect = el.getBoundingClientRect()
  const area = Math.max(rect.width, 1) * Math.max(rect.height, 1)
  return Math.max(IMAGE_MIN_WEIGHT, Math.sqrt(area) / IMAGE_AREA_DIVISOR)
}

function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Find the profile entry whose vertical extent contains `centerY`. Uses
 * `cache.lastIdx` as a starting hint: if `centerY` is still inside the
 * previous entry, returns it in O(1). If it's drifted into an immediate
 * neighbor, walks one step. Otherwise falls back to binary search.
 *
 * Returns -1 if `entries` is empty or `centerY` is outside the profile's
 * vertical range. The caller should fall back to a constant-speed model
 * in that case.
 */
export function findEntryAt(
  profile: VelocityProfile,
  centerY: number,
  cache: ProfileLookupCache,
): number {
  const { entries } = profile
  if (entries.length === 0) return -1

  // Adjacency hot path
  const last = cache.lastIdx
  if (last >= 0 && last < entries.length) {
    const e = entries[last]
    if (centerY >= e.topPx && centerY < e.bottomPx) return last
    // One step forward
    if (last + 1 < entries.length) {
      const n = entries[last + 1]
      if (centerY >= n.topPx && centerY < n.bottomPx) {
        cache.lastIdx = last + 1
        return last + 1
      }
    }
    // One step backward
    if (last - 1 >= 0) {
      const p = entries[last - 1]
      if (centerY >= p.topPx && centerY < p.bottomPx) {
        cache.lastIdx = last - 1
        return last - 1
      }
    }
  }

  // Binary search by topPx — find rightmost entry whose topPx <= centerY.
  let lo = 0
  let hi = entries.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (entries[mid].topPx <= centerY) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (best === -1) return -1
  // Verify centerY is actually inside (handles gaps between entries)
  if (centerY >= entries[best].bottomPx) {
    // We're in a gap (e.g. margin between two paragraphs). Use the entry
    // we landed on anyway — it's the closest preceding one and its
    // pxPerWeight is the right approximation for the gap.
  }
  cache.lastIdx = best
  return best
}

/**
 * Resolve the effective `pxPerWeight` at scroll-center `centerY`, with
 * linear blending across `±BLEND_PX` of every entry boundary.
 *
 * Returns 0 if there's no usable profile entry — caller should treat that
 * as "fall back to constant-speed model".
 */
export function getPxPerWeight(
  profile: VelocityProfile,
  centerY: number,
  cache: ProfileLookupCache,
): number {
  const idx = findEntryAt(profile, centerY, cache)
  if (idx < 0) return 0

  const cur = profile.entries[idx]
  const curPpw = cur.pxPerWeight

  // Distance to nearest boundary determines whether we need to blend.
  const distToBottom = cur.bottomPx - centerY // positive while inside
  const distToTop = centerY - cur.topPx        // positive while inside

  if (distToBottom < BLEND_PX && idx + 1 < profile.entries.length) {
    // Blending into the next entry
    const next = profile.entries[idx + 1]
    // t goes 0 at the boundary midpoint moving downward... let's use:
    // at distToBottom = BLEND_PX  → t = 0   (pure cur)
    // at distToBottom = 0          → t = 0.5 (half-blend)
    // at distToBottom = -BLEND_PX  → t = 1   (pure next)
    // distToBottom can't go negative inside cur — but we keep the formula
    // symmetric so it composes with the next entry's blend window when
    // both ranges overlap a tiny gap.
    const t = (BLEND_PX - distToBottom) / (2 * BLEND_PX)
    return lerp(curPpw, next.pxPerWeight, clamp01(t))
  }

  if (distToTop < BLEND_PX && idx - 1 >= 0) {
    // Blending out of the previous entry
    const prev = profile.entries[idx - 1]
    const t = (BLEND_PX - distToTop) / (2 * BLEND_PX)
    return lerp(curPpw, prev.pxPerWeight, clamp01(t))
  }

  return curPpw
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp01(t: number): number {
  if (t < 0) return 0
  if (t > 1) return 1
  return t
}
