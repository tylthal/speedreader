import {
  memo,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { RefObject } from 'react'
import type { Chapter } from '../api/client'
import { getImageBlobWithSource, type ImageBlobSource } from '../lib/fileStorage'
import { useContentTap } from '../hooks/useContentTap'
import { buildProfile, type VelocityProfile } from '../lib/velocityProfile'
import {
  buildSegmentRangeIndex,
  materializeRangeRects,
  type SegmentRangeIndex,
  type RectInContainer,
} from './formattedView/segmentRangeIndex'
import { positionStore } from '../state/position/positionStore'
import {
  FormattedViewDiagnostics,
  type ImageDiag,
  type UploadDiag,
} from './formattedView/FormattedViewDiagnostics'

/**
 * Vertical position of the reference line as a fraction of the viewport
 * height. PIP detection, auto-scroll targeting, and segment detection all
 * use this value so they agree on "where the user is reading".
 */
export const REFERENCE_LINE_RATIO = 0.4

interface FormattedViewProps {
  publicationId: number
  chapters: Chapter[]
  /** Index of the section the reader cursor is currently in. */
  currentSectionIndex: number
  /** Called when scrolling causes a different section to become visible. */
  onVisibleSectionChange: (sectionIndex: number) => void
  /** Tap-to-toggle-playback. Fires for bare taps that don't land on a link/button. */
  onTap?: () => void
  /**
   * When supplied, FormattedView populates this ref with the latest
   * velocity profile any time it rebuilds (post innerHTML write, ResizeObserver
   * fire, manual `rebuildProfile()` call). The owning component (ReaderViewport)
   * passes the same ref into useScrollEngine / useTrackEngine so the engines
   * can read the profile each tick without a React re-render.
   */
  velocityProfileRef?: RefObject<VelocityProfile | null>
  /**
   * Fired after every velocity-profile rebuild. ReaderViewport uses
   * this to re-trigger the formatted-view auto-scroll/highlight band
   * once content has actually laid out — the formatted bodies are
   * written via innerHTML in a useEffect that depends on the async
   * image loader, so on first mount the section heights are small
   * (just the title h1) and any scroll/band computation reads stale
   * geometry. This callback is the "layout settled" signal.
   */
  onLayoutChange?: () => void
  /**
   * Whether the formatted view should be visible to the user.
   * FormattedView stays MOUNTED across the play/pause lifecycle to
   * avoid the multi-second cost of rewriting innerHTML, rebuilding the
   * velocity profile, and rebuilding the segment range index every
   * time the user pauses from phrase/RSVP. When `visible` is false the
   * component CSS-hides itself and the IntersectionObserver
   * suppresses dispatches so it doesn't fight with the focus overlay.
   * Defaults to true.
   */
  visible?: boolean
  /** Called when the user taps the PIP indicator. */
  onPipTap?: () => void
  /** When false the PIP indicator is hidden (e.g. during playback). Defaults to true. */
  showPip?: boolean
}

/**
 * Minimal segment shape the highlight system needs from the parent.
 * Decoupled from the full Segment type so this component doesn't pull
 * in db/parser types just for highlighting. chapter_id is included so
 * the highlight pipeline can detect stale-chapter segments (e.g. when
 * the loader hasn't finished switching chapters yet) and refuse to
 * match — without this guard the matcher walks chapter A's segments
 * against chapter B's DOM and produces 0 hits, which downstream falls
 * through to a giant proportional band that gets clamped to null and
 * leaves the auto-scroll stuck.
 */
export interface HighlightSegment {
  text: string
  word_count?: number
  chapter_id?: number
}

/** Result returned from setHighlightForSegment so the parent can reuse
 *  the band geometry for auto-scroll without doing a second lookup. */
export interface HighlightInfo {
  /** Top of the topmost rect, in scroll-container coordinates. */
  topPx: number
  /** Total height covered by all rects (top of first rect → bottom of last). */
  heightPx: number
  /** True iff the result came from the DOM-range matcher (word-accurate),
   *  false if it fell back to the proportional / velocity-profile estimate. */
  accurate: boolean
}

export interface TocTargetInfo {
  topPx: number
  /**
   * Best-effort segment array index nearest the TOC target. Null means the
   * DOM target exists but couldn't be matched to a specific reader segment.
   */
  arrIdx: number | null
}

/**
 * Imperative handle exposed via forwardRef. The surface stays minimal —
 * ReaderViewport reaches in for the things that can't be expressed as
 * props without forcing a re-render of the section innerHTML write path.
 */
export interface FormattedViewHandle {
  getScrollContainer: () => HTMLDivElement | null
  getSectionEl: (idx: number) => HTMLElement | null
  isSectionReady: (idx: number) => boolean
  rebuildProfile: () => void
  settleImages: (sectionIdx: number) => Promise<void>
  /** Highlight a single segment. See setHighlightForSegment docstring. */
  setHighlightForSegment: (
    sectionIdx: number,
    arrIdx: number,
    segments: ReadonlyArray<HighlightSegment>,
  ) => HighlightInfo | null
  resolveTocTarget: (
    sectionIdx: number,
    htmlAnchor: string | null | undefined,
    segments: ReadonlyArray<HighlightSegment>,
  ) => TocTargetInfo | null
  /** Synchronously re-run the pip detection so callers get fresh
   *  coordinates even if no scroll event has fired since the last
   *  layout change. Call before detectAtViewportCenter when stale
   *  data could cause a position mismatch (e.g. play() after pause). */
  refreshPipPosition: () => void
  /** Unified position detection at the reference line. Reads the block
   *  found by the pip scroll listener (shared via ref), then finds
   *  the segment at the pip's line via caretRangeFromPoint. Because
   *  both systems use the same block, they cannot disagree. */
  detectAtViewportCenter: (
    currentSectionIdx: number,
    segments: ReadonlyArray<HighlightSegment>,
  ) => { sectionIdx: number; arrIdx: number | null } | null
  /** Mark a window of programmatic scrolling so the IntersectionObserver
   *  inside FormattedView and the pause-mode scroll listener in
   *  ReaderViewport both know to suppress their callbacks. The auto-
   *  scroll effect calls this immediately before container.scrollTo
   *  and clears it on scrollend (with a 600ms fallback). Without this,
   *  auto-scroll would race the IO + listener in a feedback loop —
   *  scrollTo fires a scroll event, listener dispatches USER_SCROLL,
   *  IO dispatches CHAPTER_NAV, both override the auto-scroll target. */
  beginProgrammaticScroll: () => void
  endProgrammaticScroll: () => void
  /** True iff a programmatic scroll is currently in flight. */
  isProgrammaticScrollActive: () => boolean
}

const OPFS_SRC_RE = /<img\s[^>]*?src=["']opfs:([^"']+)["']/gi

function collectOpfsNames(chapters: Chapter[]): string[] {
  const names = new Set<string>()
  for (const ch of chapters) {
    const html = ch.html
    if (!html) continue
    OPFS_SRC_RE.lastIndex = 0
    let m
    while ((m = OPFS_SRC_RE.exec(html)) !== null) {
      names.add(m[1])
    }
  }
  return [...names]
}

/**
 * Returns true if the section's html starts with a heading element. We use
 * this to suppress our own `formatted-view__title` for sections where the
 * book's body already has its own visible heading (which is the common case
 * for EPUB chapter files), and only render our title as a fallback for
 * sections like "Cover" or "Title Page" whose body has no heading.
 *
 * The check skips over any opening container tags (div/section/article/main/
 * header/figure/p with empty content) before looking for the first
 * <h1>-<h6>. It does NOT parse the HTML — that would be expensive for every
 * section every render. A regex on the leading characters is enough.
 */
const LEADING_HEADING_RE =
  /^(?:\s*<(?:div|section|article|main|header|figure)(?:\s[^>]*)?>)*\s*<h[1-6](?:\s|>)/i

function bodyHasLeadingHeading(html: string | null | undefined): boolean {
  if (!html) return false
  return LEADING_HEADING_RE.test(html)
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function findAnchorElement(sectionEl: HTMLElement, htmlAnchor: string): HTMLElement | null {
  const normalized = htmlAnchor.trim()
  if (!normalized) return null
  return (
    sectionEl.querySelector(`[id="${escapeAttributeValue(normalized)}"]`) as HTMLElement | null
  ) ?? (
    sectionEl.querySelector(`[name="${escapeAttributeValue(normalized)}"]`) as HTMLElement | null
  )
}

function normalizeHtmlAnchor(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim().replace(/^#/, '')
  if (!trimmed) return ''
  try {
    return decodeURIComponent(trimmed)
  } catch {
    return trimmed
  }
}

// ---------------------------------------------------------------------------
// Module-level image-URL cache, keyed by publicationId.
//
// The cache lives outside any React component so URLs persist across mounts,
// unmounts, StrictMode double-invokes, HMR, parent re-renders, and any other
// React lifecycle event. Each publication's images are loaded at most once
// per page-load. We never revoke — the leak is bounded by the number of
// distinct publications opened in a session, which is fine for a reader app
// (a few MB at most). The browser reclaims everything on tab close.
// ---------------------------------------------------------------------------

/**
 * Aggregate result of a single publication's image-load pass. Counts are
 * surfaced to the diagnostic strip so the user can see — without browser
 * console access — whether OPFS or the Dexie fallback is doing the work,
 * and how many images failed to resolve from either backend.
 */
interface ImageLoadResult {
  urls: Map<string, string>
  expected: number
  opfsCount: number
  dexieCount: number
  missingCount: number
}

interface ImageCacheEntry {
  promise: Promise<ImageLoadResult>
  /** Track insertion order for LRU eviction */
  accessOrder: number
}

const IMAGE_CACHE_MAX = 3
const imageCache = new Map<number, ImageCacheEntry>()
let imageCacheOrder = 0

/** Revoke all blob URLs held for a publication and remove from cache. */
function releasePublicationImages(publicationId: number): void {
  const entry = imageCache.get(publicationId)
  if (!entry) return
  entry.promise.then(({ urls }) => {
    for (const url of urls.values()) URL.revokeObjectURL(url)
  }).catch(() => {})
  imageCache.delete(publicationId)
}

/** Evict the oldest cache entry when over limit. */
function evictOldestImageCache(): void {
  if (imageCache.size <= IMAGE_CACHE_MAX) return
  let oldestKey: number | null = null
  let oldestOrder = Infinity
  for (const [key, entry] of imageCache) {
    if (entry.accessOrder < oldestOrder) {
      oldestOrder = entry.accessOrder
      oldestKey = key
    }
  }
  if (oldestKey != null) releasePublicationImages(oldestKey)
}

function loadPublicationImages(
  publicationId: number,
  chapters: Chapter[],
): Promise<ImageLoadResult> {
  const cached = imageCache.get(publicationId)
  if (cached) {
    cached.accessOrder = ++imageCacheOrder
    return cached.promise
  }

  const promise = (async () => {
    const names = collectOpfsNames(chapters)
    const urls = new Map<string, string>()
    const counts: Record<ImageBlobSource, number> = {
      opfs: 0,
      dexie: 0,
      native: 0,
      missing: 0,
    }
    for (const name of names) {
      try {
        const { blob, source } = await getImageBlobWithSource(publicationId, name)
        counts[source] = (counts[source] ?? 0) + 1
        if (blob) {
          urls.set(name, URL.createObjectURL(blob))
        } else {
          console.warn('[formatted] image not found', { publicationId, name })
        }
      } catch (err) {
        counts.missing++
        console.warn('[formatted] image resolve failed', { name, err })
      }
    }
    return {
      urls,
      expected: names.length,
      opfsCount: counts.opfs + counts.native,
      dexieCount: counts.dexie,
      missingCount: counts.missing,
    }
  })()

  imageCache.set(publicationId, { promise, accessOrder: ++imageCacheOrder })
  evictOldestImageCache()
  return promise
}

function isImageDiagEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).has('diag')
  } catch {
    return false
  }
}

function readUploadDiag(publicationId: number): UploadDiag | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(`upload-diag:${publicationId}`)
    if (!raw) return null
    return JSON.parse(raw) as UploadDiag
  } catch {
    return null
  }
}

/**
 * Continuous-scroll formatted view (PRD §4.3) for HTML-derived books.
 *
 * Image loading strategy: at mount we extract every unique `opfs:NAME` marker
 * from all section HTML, fetch the blobs from OPFS in parallel, and build a
 * Map<name, blobUrl>. The section HTML is then rewritten via simple string
 * substitution BEFORE being passed to dangerouslySetInnerHTML. This avoids
 * the fragile post-render DOM-mutation pattern that broke under StrictMode
 * and on subsequent re-renders triggered by scrolling.
 */
const FormattedViewInner = forwardRef<FormattedViewHandle, FormattedViewProps>(function FormattedView(
  {
    publicationId,
    chapters,
    currentSectionIndex,
    onVisibleSectionChange,
    onTap,
    velocityProfileRef,
    onLayoutChange,
    visible = true,
    onPipTap,
    showPip = true,
  },
  ref,
) {
  // Stabilize the parent's onLayoutChange in a ref so rebuildProfileNow
  // doesn't need to re-create itself when the parent re-renders.
  const onLayoutChangeRef = useRef(onLayoutChange)
  onLayoutChangeRef.current = onLayoutChange
  // Mirror visible into a ref so the IntersectionObserver callback can
  // consult it without re-creating the observer on every visibility flip.
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const tapHandlers = useContentTap(onTap)
  const containerRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Map<number, HTMLElement>>(new Map())
  // Multi-line highlight rects for the current segment. Each entry
  // represents one visual line of the segment, in scroll-container
  // coordinates. The renderer maps each rect to an absolute-positioned
  // div so the highlight hugs the actual text instead of spanning the
  // full container width.
  const [pipTop, setPipTop] = useState<number | null>(null)
  // Per-section text→DOM-range cache. Built lazily on the first
  // setHighlightForSegment call for a section, invalidated inline in
  // the innerHTML-write effect when the body content changes. Stores
  // node+offset pairs (not rects), so the cache survives layout-only
  // shifts (font size, image decode, theme toggles); only the derived
  // rects are recomputed via Range.getClientRects() per cursor change.
  const segmentIndexRef = useRef<Map<number, SegmentRangeIndex>>(new Map())
  // Shared pip→detection bridge. The pip scroll listener writes the
  // block it found on every scroll frame; detectAtViewportCenter reads
  // it instead of doing its own elementFromPoint + block walk. This
  // guarantees both systems always reference the exact same block.
  const pipBlockRef = useRef<{
    block: HTMLElement
    bodyEl: HTMLElement
    sectionIdx: number
    centerX: number
    pipViewportY: number
  } | null>(null)
  // Suppression flag for the IntersectionObserver below — flipped on
  // by scrollSectionIntoView() while a programmatic scroll is in flight,
  // cleared on scrollend (with a 400ms timer fallback). Without this,
  // a TOC click or chapter-nav scroll would loop back through the
  // observer and dispatch a redundant CHAPTER_NAV at the destination.
  const isProgrammaticScrollRef = useRef(false)

  // Generation counter bumped on every profile rebuild — engines compare
  // against their cached value to know when to reset the lookup adjacency
  // cache after a layout change.
  const profileGenerationRef = useRef(0)

  // Resolved name → blob URL. Pulled from a module-level cache so the URLs
  // persist across mounts/unmounts (StrictMode, HMR, conditional rendering).
  const [imageMap, setImageMap] = useState<Map<string, string>>(new Map())
  const opfsNames = useMemo(() => collectOpfsNames(chapters), [chapters])
  const chapterTitleSuppression = useMemo(
    () => chapters.map((chapter) => bodyHasLeadingHeading(chapter.html)),
    [chapters],
  )

  const getReadySectionContext = (sectionIdx: number) => {
    const container = containerRef.current
    const sectionEl = sectionRefs.current.get(sectionIdx)
    if (!container || !sectionEl) return null

    const sectionRect = sectionEl.getBoundingClientRect()
    if (sectionRect.height === 0) return null

    const bodyEl = sectionEl.querySelector(
      '.formatted-view__body',
    ) as HTMLElement | null
    if (bodyEl && bodyEl.dataset.lastHtml === undefined) return null

    return { container, sectionEl, sectionRect, bodyEl }
  }
  const [imageDiag, setImageDiag] = useState<ImageDiag | null>(null)
  // Flips true once loadPublicationImages has resolved (success OR failure).
  // The gate below uses this instead of `imageMap.size > 0` because on
  // mobile browsers where OPFS writes silently failed at upload time, the
  // map will legitimately be empty — and we still need text to render.
  const [imageLoadResolved, setImageLoadResolved] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadPublicationImages(publicationId, chapters)
      .then((result) => {
        if (cancelled) return
        setImageMap(result.urls)
        setImageDiag({
          expected: result.expected,
          opfsCount: result.opfsCount,
          dexieCount: result.dexieCount,
          missingCount: result.missingCount,
        })
      })
      .catch((err) => {
        // Don't block the text render on a storage failure.
        console.warn('[formatted] image loader rejected', err)
      })
      .finally(() => {
        if (!cancelled) setImageLoadResolved(true)
      })
    return () => {
      cancelled = true
    }
  }, [publicationId, chapters])

  // Pre-rewrite each section's HTML in two passes:
  //   1. Substitute resolved opfs: markers with their blob URL.
  //   2. Strip any <img> tags whose src is still an unresolved opfs: marker
  //      so the user gets clean text instead of broken-image icons. This
  //      matters on mobile WebKit where the OPFS image storage may have
  //      silently failed at upload time.
  //
  // We DELAY the rewrite until the loader has *resolved* (gate below) — not
  // until images are populated — so chapters with no images render as soon
  // as the loader settles, and chapters whose images failed to store still
  // render their text. Either way, the unresolved opfs: markers never reach
  // the DOM, so the browser never fires ERR_UNKNOWN_URL_SCHEME.
  const imagesReady =
    imageLoadResolved || opfsNames.length === 0
  const rewrittenSections = useMemo(() => {
    if (!imagesReady) return null
    return chapters.map((ch, idx) => {
      const html = ch.html ?? ''
      if (!html) return { idx, html }
      // Pass 1 — substitute resolved markers.
      let out = html
      if (imageMap.size > 0) {
        out = out.replace(
          /(<img\s[^>]*?src=["'])opfs:([^"']+)(["'])/gi,
          (match, head: string, name: string, tail: string) => {
            const url = imageMap.get(name)
            if (!url) return match
            return `${head}${url}${tail}`
          },
        )
      }
      // Pass 2 — strip any img tag whose src is still an unresolved opfs:
      // marker. The lazy [^>]*? keeps each match scoped to a single tag.
      out = out.replace(
        /<img\s[^>]*?\bsrc=["']opfs:[^"']+["'][^>]*>/gi,
        '',
      )
      return { idx, html: out }
    })
  }, [chapters, imageMap, imagesReady])

  const prioritySectionIndexes = useMemo(() => {
    if (chapters.length === 0) return []
    const indexes = new Set<number>()
    indexes.add(currentSectionIndex)
    if (currentSectionIndex > 0) indexes.add(currentSectionIndex - 1)
    if (currentSectionIndex < chapters.length - 1) indexes.add(currentSectionIndex + 1)
    return [...indexes].sort((a, b) => a - b)
  }, [chapters.length, currentSectionIndex])

  // We set the section body innerHTML *imperatively* via a ref, NOT through
  // dangerouslySetInnerHTML. React 19's reconciler appears to track img
  // elements inside dangerouslySetInnerHTML and "fix" their src attributes
  // back to the original (unresolved) opfs: markers during commit, which
  // breaks the images on every re-render. Setting innerHTML imperatively
  // takes the inner DOM out of React's hands entirely.
  const bodyRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  useEffect(() => {
    if (!rewrittenSections) return
    let cancelled = false
    let pendingTimeout: ReturnType<typeof setTimeout> | null = null
    let pendingRaf = 0

    const sectionHtmlByIndex = new Map(rewrittenSections.map(({ idx, html }) => [idx, html]))
    const deferredIndexes = rewrittenSections
      .map(({ idx }) => idx)
      .filter((idx) => !prioritySectionIndexes.includes(idx))

    const writeSection = (idx: number): boolean => {
      const html = sectionHtmlByIndex.get(idx)
      if (html == null) return false
      const el = bodyRefs.current.get(idx)
      if (!el) return false
      if (el.dataset.lastHtml === html) return false
      el.innerHTML = html
      el.dataset.lastHtml = html
      segmentIndexRef.current.delete(idx)
      return true
    }

    const scheduleProfileRebuild = () => {
      if (pendingRaf) return
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = 0
        rebuildProfileNow()
      })
    }

    let didWritePriority = false
    for (const idx of prioritySectionIndexes) {
      didWritePriority = writeSection(idx) || didWritePriority
    }
    if (didWritePriority) scheduleProfileRebuild()

    const flushDeferred = () => {
      if (cancelled) return
      let wroteChunk = false
      for (let i = 0; i < 4 && deferredIndexes.length > 0; i += 1) {
        const idx = deferredIndexes.shift()
        if (idx == null) break
        wroteChunk = writeSection(idx) || wroteChunk
      }
      if (wroteChunk) scheduleProfileRebuild()
      if (deferredIndexes.length > 0) {
        pendingTimeout = setTimeout(flushDeferred, 16)
      }
    }

    if (deferredIndexes.length > 0) {
      pendingTimeout = setTimeout(flushDeferred, 16)
    }

    return () => {
      cancelled = true
      if (pendingTimeout) clearTimeout(pendingTimeout)
      if (pendingRaf) cancelAnimationFrame(pendingRaf)
    }
  }, [prioritySectionIndexes, rewrittenSections])

  // ---- Velocity profile build ---------------------------------------------
  //
  // Builds happen on three triggers:
  //   1. After the imperative innerHTML write completes (above), one rAF later
  //   2. ResizeObserver fires on any tracked section after a meaningful
  //      height change (late image load, font reflow)
  //   3. ReaderViewport calls handle.rebuildProfile() before play() — usually
  //      after handle.settleImages() has awaited every img.decode() in the
  //      current section so layout is stable
  //
  // The build itself is a single querySelectorAll + bounded gBCR reads on
  // top-level block elements; it's well under one frame even for large
  // chapters. We mutate velocityProfileRef.current directly (no setState)
  // because the engines read it from a ref each tick — they pick up the
  // update on the very next rAF without any React re-render path.
  const rebuildProfileNow = () => {
    const container = containerRef.current
    if (!container) return
    if (!velocityProfileRef) return
    profileGenerationRef.current += 1
    velocityProfileRef.current = buildProfile(container, profileGenerationRef.current)
    // Tell the parent the section layout has settled (or shifted —
    // late image decode, font load, etc). The parent re-runs its
    // formatted-view auto-scroll + highlight band against the fresh
    // geometry.
    onLayoutChangeRef.current?.()
  }

  // ResizeObserver: watch every section for height changes and rebuild the
  // profile when one shifts by >2% from its last observed height. The 2%
  // threshold ignores sub-pixel jitter from font hinting / scrollbar
  // reflow. Debounced to one rAF so a burst of late image loads collapses
  // into a single rebuild.
  useEffect(() => {
    if (!velocityProfileRef) return
    const container = containerRef.current
    if (!container) return

    const lastHeights = new Map<HTMLElement, number>()
    let pendingRaf = 0
    const scheduleRebuild = () => {
      if (pendingRaf) return
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = 0
        rebuildProfileNow()
      })
    }

    const observer = new ResizeObserver((entries) => {
      // Skip profile rebuilds during playback — they cause layout
      // thrashing that manifests as scroll jitter.
      if (positionStore.getSnapshot().isPlaying) return
      let significant = false
      for (const entry of entries) {
        const el = entry.target as HTMLElement
        const newHeight = entry.contentRect.height
        const prev = lastHeights.get(el) ?? 0
        if (prev === 0 || Math.abs(newHeight - prev) / Math.max(prev, 1) > 0.02) {
          lastHeights.set(el, newHeight)
          significant = true
        }
      }
      if (significant) scheduleRebuild()
    })

    for (const el of sectionRefs.current.values()) {
      observer.observe(el)
    }

    return () => {
      if (pendingRaf) cancelAnimationFrame(pendingRaf)
      observer.disconnect()
    }
    // We intentionally re-run when chapters change so the observer attaches
    // to whatever sections currently exist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapters, velocityProfileRef])

  // Track the last section index we *reported* to the parent so the
  // IntersectionObserver doesn't re-emit it on every entry batch. The
  // parent (ReaderViewport) now no-ops duplicate values too, but this
  // local short-circuit avoids the dispatch entirely.
  const lastReportedIdxRef = useRef<number>(currentSectionIndex)

  // Stabilize the parent's onVisibleSectionChange callback in a ref so the
  // IntersectionObserver effect below doesn't re-create the observer every
  // time the parent re-renders (which happens on every scroll because
  // chapterIdx changes are part of the parent's useCallback deps).
  const onVisibleSectionChangeRef = useRef(onVisibleSectionChange)
  onVisibleSectionChangeRef.current = onVisibleSectionChange

  // NOTE: there used to be an effect here that called scrollIntoView()
  // whenever currentSectionIndex changed. It tangled with the
  // IntersectionObserver below — pause-time layout shifts could trip
  // the observer, the observer would update chapterIdx, the effect
  // would scrollIntoView and yank the view to the top of the section.
  // Section navigation now happens via the imperative
  // scrollSectionIntoView() handle, called explicitly by TOC clicks and
  // chapter-nav buttons. Visible-section changes from scrolling stay
  // observe-only.

  // Tracks the scrollTop value at the time of the last IO firing. The
  // IO can fire for two reasons: (1) the user (or programmatic code)
  // scrolled, OR (2) intersecting elements changed shape due to a
  // layout reflow (image decode, font load, late innerHTML write).
  // Only the first kind should commit a chapter change — the second
  // kind would clobber an in-flight TOC navigation by reporting "the
  // currently visible section is X" before the auto-scroll has a
  // chance to move to the new chapter.
  const lastIOSeenScrollTopRef = useRef(0)

  // Keep pip at the specific TEXT LINE at the reference line — not the
  // block's midpoint. Uses caretRangeFromPoint to find the exact line,
  // positions pip at that line's vertical midpoint. Also writes the
  // found block + line Y to pipBlockRef so detectAtViewportCenter can
  // reuse it, guaranteeing both systems reference the same line.
  //
  // Extracted into a ref-stable function so the scroll listener and the
  // imperative handle (refreshPipPosition) can both call it.
  const updatePipPositionRef = useRef<() => void>(() => {})
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const updatePipPosition = () => {
      // During playback the scroll engine drives position at 60 Hz.
      // Running caretRangeFromPoint + setPipTop every frame causes GC
      // churn and React re-renders that manifest as periodic jitter.
      // Skip pip updates while playing — the pip only matters visually
      // when paused.
      if (positionStore.getSnapshot().isPlaying) return

      const containerRect = container.getBoundingClientRect()
      const centerViewportY = containerRect.top + container.clientHeight * REFERENCE_LINE_RATIO
      const centerX = containerRect.left + containerRect.width / 2
      const el = container.ownerDocument.elementFromPoint(centerX, centerViewportY)
      if (!el) {
        pipBlockRef.current = null
        setPipTop(container.scrollTop + container.clientHeight * REFERENCE_LINE_RATIO - 10)
        return
      }
      // Walk up to the nearest block element inside a section body
      let block: HTMLElement | null = el as HTMLElement
      let bodyEl: HTMLElement | null = null
      while (block && block !== container) {
        const parent: HTMLElement | null = block.parentElement
        if (parent?.classList.contains('formatted-view__body')) {
          bodyEl = parent
          break
        }
        block = parent
      }
      if (block && block !== container && bodyEl) {
        // Line-level precision: probe the caret at the reference line to
        // find the exact text line, then position pip at that line.
        const doc = container.ownerDocument
        let lineViewportY = centerViewportY // fallback to reference line
        if ('caretRangeFromPoint' in doc) {
          const cr = (doc as unknown as { caretRangeFromPoint(x: number, y: number): Range | null })
            .caretRangeFromPoint(centerX, centerViewportY)
          if (cr) {
            // caretRangeFromPoint returns a collapsed range. Expand it
            // by one character so getClientRects returns the line box.
            // getBoundingClientRect on a collapsed range also works but
            // getClientRects on an expanded range is more reliable.
            const node = cr.startContainer
            const off = cr.startOffset
            if (node.nodeType === Node.TEXT_NODE && off < (node as Text).length) {
              cr.setEnd(node, off + 1)
            }
            const lineRect = cr.getClientRects()[0] ?? cr.getBoundingClientRect()
            if (lineRect && lineRect.height > 0) {
              lineViewportY = lineRect.top + lineRect.height / 2
            }
          }
        } else if ('caretPositionFromPoint' in doc) {
          const cp = (doc as unknown as { caretPositionFromPoint(x: number, y: number): { offsetNode: Node; offset: number } | null })
            .caretPositionFromPoint(centerX, centerViewportY)
          if (cp) {
            const r = container.ownerDocument.createRange()
            r.setStart(cp.offsetNode, cp.offset)
            const maxOff = cp.offsetNode.nodeType === Node.TEXT_NODE
              ? (cp.offsetNode as Text).length : 0
            r.setEnd(cp.offsetNode, Math.min(cp.offset + 1, maxOff))
            const lineRect = r.getClientRects()[0] ?? r.getBoundingClientRect()
            if (lineRect && lineRect.height > 0) {
              lineViewportY = lineRect.top + lineRect.height / 2
            }
          }
        }
        const pipScrollY = lineViewportY - containerRect.top + container.scrollTop
        setPipTop(pipScrollY - 10)

        // Extract section index from the body's section ancestor.
        let sectionIdx = -1
        let sec: HTMLElement | null = bodyEl.parentElement
        while (sec && sec !== container) {
          if (sec.classList.contains('formatted-view__section')) {
            sectionIdx = parseInt(sec.dataset.sectionIndex ?? '-1', 10)
            break
          }
          sec = sec.parentElement
        }
        pipBlockRef.current = { block, bodyEl, sectionIdx, centerX, pipViewportY: lineViewportY }
      } else {
        pipBlockRef.current = null
        setPipTop(container.scrollTop + container.clientHeight * REFERENCE_LINE_RATIO - 10)
      }
    }
    updatePipPositionRef.current = updatePipPosition
    container.addEventListener('scroll', updatePipPosition, { passive: true })
    // Set initial position
    updatePipPosition()
    return () => container.removeEventListener('scroll', updatePipPosition)
  }, [])

  // Watch which section is at the top of the viewport and report it.
  // Deps include only `chapters` so the observer is rebuilt when sections
  // change, not on every parent re-render.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Initialize the scroll-top baseline so the first IO firing doesn't
    // mistake "we're at the saved scroll position" for "the user just
    // scrolled here from somewhere else".
    lastIOSeenScrollTopRef.current = container.scrollTop

    const observer = new IntersectionObserver(
      (entries) => {
        // ALWAYS update the scroll baseline, even when bailing — that way
        // a programmatic scroll (which we bail on) leaves the baseline
        // at the new position, and the next layout-reflow IO firing
        // recognizes "no scroll happened since" and bails too.
        const currentScroll = container.scrollTop
        const scrollChanged = currentScroll !== lastIOSeenScrollTopRef.current
        lastIOSeenScrollTopRef.current = currentScroll

        if (isProgrammaticScrollRef.current) return
        // Don't dispatch chapter-nav while the formatted view is hidden
        // (the user is in phrase/RSVP play mode and the focus overlay
        // is showing). Otherwise stale layout shifts during play would
        // commit chapter changes the user can't see.
        if (!visibleRef.current) return
        // During scroll/track playback the engine drives scrollTop.
        // Let the engine's own segment detection handle position —
        // firing a chapter-nav here would trigger a full re-render
        // cascade mid-animation-frame and cause visible jitter.
        if (positionStore.getSnapshot().isPlaying) return
        // Layout reflow without an actual scroll. Image decodes, font
        // loads, and late innerHTML writes all fire intersection
        // changes; without this guard those firings would commit a
        // chapter change for whichever section is at scrollTop=0,
        // clobbering an in-flight TOC navigation.
        if (!scrollChanged) return

        let bestIdx = -1
        let bestTop = -Infinity
        // Also track the closest intersecting section if none has top<=0
        // (happens when the user scrolls to the very start of a new section
        // that hasn't fully crossed the viewport top edge yet).
        let closestPositiveIdx = -1
        let closestPositiveTop = Infinity
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const idx = parseInt(
            (entry.target as HTMLElement).dataset.sectionIndex ?? '-1',
            10,
          )
          if (Number.isNaN(idx)) continue
          const top = entry.boundingClientRect.top
          if (top <= 0 && top > bestTop) {
            bestTop = top
            bestIdx = idx
          } else if (top > 0 && top < closestPositiveTop) {
            closestPositiveTop = top
            closestPositiveIdx = idx
          }
        }
        // If no section has scrolled past the top edge but there's a
        // visible section near the top, use it. This handles the case
        // where the previous section is fully off-screen but the new
        // section's top hasn't quite reached pixel 0.
        if (bestIdx < 0 && closestPositiveIdx >= 0) {
          bestIdx = closestPositiveIdx
        }
        if (bestIdx >= 0 && bestIdx !== lastReportedIdxRef.current) {
          lastReportedIdxRef.current = bestIdx
          onVisibleSectionChangeRef.current(bestIdx)
        }
      },
      { root: container, threshold: [0, 0.01, 0.5, 1] },
    )

    for (const el of sectionRefs.current.values()) {
      observer.observe(el)
    }

    return () => observer.disconnect()
  }, [chapters])

  // ---- Imperative handle ---------------------------------------------------
  //
  // ReaderViewport reaches in for the things the engines and the formatted-mode
  // play adapter need. We expose only what the parent actually uses — no
  // generic "getRef" escape hatches. See FormattedViewHandle for field docs.
  useImperativeHandle(
    ref,
    () => ({
      getScrollContainer: () => containerRef.current,
      getSectionEl: (idx) => sectionRefs.current.get(idx) ?? null,
      isSectionReady: (idx) => getReadySectionContext(idx) != null,
      rebuildProfile: () => {
        rebuildProfileNow()
      },
      refreshPipPosition: () => {
        updatePipPositionRef.current()
      },
      beginProgrammaticScroll: () => {
        isProgrammaticScrollRef.current = true
      },
      endProgrammaticScroll: () => {
        isProgrammaticScrollRef.current = false
      },
      isProgrammaticScrollActive: () => isProgrammaticScrollRef.current,
      detectAtViewportCenter: (currentSectionIdx, segments) => {
        // Read the line the pip scroll listener found on the last
        // scroll frame. pipViewportY is the exact text line the pip
        // is drawn next to (viewport coordinates, line-level).
        const pip = pipBlockRef.current
        if (!pip) return null

        const { sectionIdx, pipViewportY } = pip
        if (sectionIdx < 0) return null
        if (sectionIdx !== currentSectionIdx) {
          return { sectionIdx, arrIdx: null }
        }
        if (segments.length === 0) {
          return { sectionIdx, arrIdx: null }
        }

        const container = containerRef.current
        if (!container) return { sectionIdx, arrIdx: null }
        const context = getReadySectionContext(currentSectionIdx)
        if (!context) return { sectionIdx, arrIdx: null }
        const { sectionEl } = context

        let index = segmentIndexRef.current.get(currentSectionIdx)
        if (!index) {
          index = buildSegmentRangeIndex(sectionEl, segments)
          segmentIndexRef.current.set(currentSectionIdx, index)
        }

        // Find the FIRST segment on the pip's line. Search ALL segments
        // in the section (not just those starting in the current block)
        // because a segment can start in one block and wrap onto the
        // pip's line in the next block. getClientRects() returns one
        // rect per visual line, all in viewport coordinates.
        const doc = container.ownerDocument
        const tempRange = doc.createRange()
        let firstOnLine: number | null = null

        for (let i = 0; i < index.length; i++) {
          const sr = index[i]
          if (!sr) continue
          try {
            tempRange.setStart(sr.startNode, sr.startOffset)
            tempRange.setEnd(sr.endNode, sr.endOffset)
            const rects = tempRange.getClientRects()
            for (let r = 0; r < rects.length; r++) {
              const rect = rects[r]
              if (rect.height > 0 && pipViewportY >= rect.top && pipViewportY <= rect.bottom) {
                firstOnLine = i
                break
              }
            }
            if (firstOnLine != null) break
          } catch {
            continue
          }
        }

        if (firstOnLine != null) {
          return { sectionIdx, arrIdx: firstOnLine }
        }

        // No segment rects overlap the pip line. Find the nearest
        // segment — check both above and below the pip, but cap the
        // search to one viewport height. Beyond that, the match is
        // unreliable and we'd rather return null than jump pages.
        const maxFallbackDist = container.clientHeight
        let closestIdx: number | null = null
        let closestDist = Infinity
        for (let i = 0; i < index.length; i++) {
          const sr = index[i]
          if (!sr) continue
          try {
            tempRange.setStart(sr.startNode, sr.startOffset)
            tempRange.setEnd(sr.endNode, sr.endOffset)
            const rect = tempRange.getBoundingClientRect()
            if (rect.height === 0) continue
            // Distance from pip to the nearest edge of the segment rect
            const dist = pipViewportY < rect.top
              ? rect.top - pipViewportY
              : pipViewportY > rect.bottom
                ? pipViewportY - rect.bottom
                : 0
            if (dist < closestDist) {
              closestDist = dist
              closestIdx = i
            }
          } catch { continue }
        }
        if (closestIdx != null && closestDist <= maxFallbackDist) {
          return { sectionIdx, arrIdx: closestIdx }
        }

        return { sectionIdx, arrIdx: null }
      },
      settleImages: async (sectionIdx) => {
        // Force every <img> in this section to fully decode before resolving.
        // HTMLImageElement.decode() resolves once the image is parsed AND
        // ready to paint, so layout is stable when we return. We swallow
        // errors (broken-image src) so the engine can still start.
        const sectionEl = sectionRefs.current.get(sectionIdx)
        if (!sectionEl) return
        const imgs = Array.from(sectionEl.querySelectorAll('img'))
        await Promise.all(
          imgs.map((img) => {
            if (img.complete && img.naturalWidth > 0) return Promise.resolve()
            return img.decode().catch(() => {
              /* broken image — proceed anyway */
            })
          }),
        )
      },
      setHighlightForSegment: (sectionIdx, arrIdx, segments) => {
        // Clear request: arrIdx === -1 OR segments empty.
        if (arrIdx < 0 || segments.length === 0) {
          return null
        }
        const context = getReadySectionContext(sectionIdx)
        if (!context) {
          return null
        }
        const { container, sectionEl } = context
        // Stale-chapter guard: when the loader hasn't finished switching
        // chapters (rapid chapter advance during phrase playback can leave
        // segments[] holding the previous chapter's data for a few frames),
        // refuse to match. The auto-scroll polling loop will keep retrying
        // until the loader catches up. Without this guard the matcher
        // produces 0 hits and the proportional fallback paints in the
        // wrong place.
        const targetChapterId = chapters[sectionIdx]?.id
        if (
          targetChapterId != null &&
          segments[0]?.chapter_id != null &&
          segments[0].chapter_id !== targetChapterId
        ) {
          return null
        }
        // Build (or hit cache) the per-section text→DOM-range index.
        let index = segmentIndexRef.current.get(sectionIdx)
        if (!index) {
          index = buildSegmentRangeIndex(sectionEl, segments)
          segmentIndexRef.current.set(sectionIdx, index)
        }

        const range = index[arrIdx]
        if (range) {
          // Word-accurate path: materialize per-line rects from the
          // live Range. The rects come from getClientRects() so they
          // reflect the current layout (font size, image decode).
          const rects = materializeRangeRects(range, container)
          if (rects.length > 0) {
            let topMin = Infinity
            let bottomMax = -Infinity
            for (const r of rects) {
              if (r.topPx < topMin) topMin = r.topPx
              if (r.topPx + r.heightPx > bottomMax) bottomMax = r.topPx + r.heightPx
            }
            const bandHeight = Math.max(2, bottomMax - topMin)
            return {
              topPx: topMin,
              heightPx: bandHeight,
              accurate: true,
            }
          }
        }

        // Fallback: text matcher couldn't find this segment (or the
        // Range produced no rects — image-only section, hidden via
        // CSS, etc). Use the proportional / velocity-profile estimate
        // so we still return a position for auto-scroll targeting.
        const fallback = computeProportionalBand(
          arrIdx,
          segments,
          sectionEl,
          container,
          velocityProfileRef?.current ?? null,
        )
        if (!fallback) {
          // Last-ditch scroll target: the section's own top. The auto-
          // scroll caller uses topPx + heightPx/2 as the centering
          // anchor; for an image-only chapter we want the section
          // top near the top of the viewport.
          const sectionRect = sectionEl.getBoundingClientRect()
          const containerRectFb = container.getBoundingClientRect()
          const sectionTopInScroll =
            sectionRect.top - containerRectFb.top + container.scrollTop
          return {
            topPx: sectionTopInScroll,
            heightPx: 0,
            accurate: false,
          }
        }
        return { ...fallback, accurate: false }
      },
      resolveTocTarget: (sectionIdx, htmlAnchor, segments) => {
        const context = getReadySectionContext(sectionIdx)
        if (!context) return null
        const { container, sectionEl, sectionRect } = context

        const anchor = normalizeHtmlAnchor(htmlAnchor)
        if (!anchor) {
          const sectionTop =
            sectionRect.top - container.getBoundingClientRect().top + container.scrollTop
          return { topPx: sectionTop, arrIdx: 0 }
        }

        const anchorEl = findAnchorElement(sectionEl, anchor)
        if (!anchorEl) return null

        const containerRect = container.getBoundingClientRect()
        const anchorRect = anchorEl.getBoundingClientRect()
        const anchorTop = anchorRect.top - containerRect.top + container.scrollTop

        let index = segmentIndexRef.current.get(sectionIdx)
        if (!index) {
          index = buildSegmentRangeIndex(sectionEl, segments)
          segmentIndexRef.current.set(sectionIdx, index)
        }

        let bestArrIdx: number | null = null
        let bestDistance = Infinity
        for (let i = 0; i < index.length; i++) {
          const range = index[i]
          if (!range) continue
          const rects = materializeRangeRects(range, container)
          if (rects.length === 0) continue
          let topMin = Infinity
          let bottomMax = -Infinity
          for (const r of rects) {
            if (r.topPx < topMin) topMin = r.topPx
            if (r.topPx + r.heightPx > bottomMax) bottomMax = r.topPx + r.heightPx
          }
          if (anchorTop <= bottomMax) {
            bestArrIdx = i
            break
          }
          const distance = Math.abs(anchorTop - topMin)
          if (distance < bestDistance) {
            bestDistance = distance
            bestArrIdx = i
          }
        }

        return { topPx: anchorTop, arrIdx: bestArrIdx }
      },
    }),
    // velocityProfileRef is stable across renders (it's a ref) so we don't
    // need to re-derive the handle when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const diagEnabled = isImageDiagEnabled()
  const uploadDiag = diagEnabled ? readUploadDiag(publicationId) : null

  return (
    <div
      className={visible ? 'formatted-view' : 'formatted-view formatted-view--hidden'}
      ref={containerRef}
      aria-hidden={!visible}
      {...tapHandlers}
    >
      {pipTop != null && showPip && (
        <div
          className="formatted-view__pip"
          aria-hidden="true"
          style={{ top: `${pipTop}px` }}
          onClick={(e) => {
            e.stopPropagation()
            onPipTap?.()
          }}
        />
      )}
      <FormattedViewDiagnostics
        enabled={diagEnabled}
        imageDiag={imageDiag}
        uploadDiag={uploadDiag}
      />
      <div className="formatted-view__column">
        {chapters.map((ch, idx) => (
          <article
            key={ch.id}
            id={`section-${idx}`}
            data-section-index={idx}
            ref={(el) => {
              if (el) sectionRefs.current.set(idx, el)
              else sectionRefs.current.delete(idx)
            }}
            className="formatted-view__section"
          >
            {!chapterTitleSuppression[idx] && (
              <h1 className="formatted-view__title">{ch.title || 'Untitled'}</h1>
            )}
            {ch.html ? (
              <div
                className="formatted-view__body"
                ref={(el) => {
                  if (el) bodyRefs.current.set(idx, el)
                  else bodyRefs.current.delete(idx)
                }}
              />
            ) : (
              <p className="formatted-view__empty">No formatted content available for this section.</p>
            )}
          </article>
        ))}
      </div>
    </div>
  )
})

FormattedViewInner.displayName = 'FormattedView'

const FormattedView = memo(FormattedViewInner)
FormattedView.displayName = 'FormattedView'

export default FormattedView

/* ------------------------------------------------------------------ */
/*  Proportional fallback                                              */
/* ------------------------------------------------------------------ */
//
// Used by setHighlightForSegment when the DOM-range matcher fails to
// locate a particular segment (whitespace mismatch, alt-text-only
// content, hidden elements, etc). Returns a single-band estimate
// derived from segment word counts and the velocity profile's
// per-block topPx/heightPx weights — significantly more accurate than
// pure proportional, but still approximate. The caller renders a
// single full-width rect from this output.
//
// This helper used to live in ReaderViewport; it moved here when
// FormattedView became the sole owner of highlight math. It is
// intentionally NOT exported — only the imperative handle's
// setHighlightForSegment uses it.

function computeProportionalBand(
  arrIdx: number,
  segments: ReadonlyArray<HighlightSegment>,
  sectionEl: HTMLElement,
  container: HTMLDivElement,
  profile: VelocityProfile | null,
): { topPx: number; heightPx: number } | null {
  const segCount = segments.length
  if (segCount === 0 || arrIdx < 0 || arrIdx >= segCount) return null

  const containerRect = container.getBoundingClientRect()
  const sectionRect = sectionEl.getBoundingClientRect()
  const sectionTop =
    sectionRect.top - containerRect.top + container.scrollTop
  const sectionH = sectionRect.height
  if (sectionH <= 0) return null

  let cumBefore = 0
  for (let i = 0; i < arrIdx; i++) {
    cumBefore += Math.max(1, segments[i].word_count ?? 1)
  }
  const segWords = Math.max(1, segments[arrIdx].word_count ?? 1)
  const cumAfter = cumBefore + segWords
  let totalWords = cumAfter
  for (let i = arrIdx + 1; i < segCount; i++) {
    totalWords += Math.max(1, segments[i].word_count ?? 1)
  }

  // Tier 1: velocity profile (block-accurate proportional).
  if (profile && profile.entries.length > 0) {
    const sectionBottom = sectionTop + sectionH
    const sectionEntries: { topPx: number; heightPx: number; weight: number }[] = []
    for (const e of profile.entries) {
      if (e.bottomPx <= sectionTop + 1) continue
      if (e.topPx >= sectionBottom - 1) break
      sectionEntries.push({
        topPx: e.topPx,
        heightPx: e.heightPx,
        weight: e.weight,
      })
    }
    if (sectionEntries.length > 0) {
      let sectionTotalWeight = 0
      for (const e of sectionEntries) sectionTotalWeight += e.weight
      if (sectionTotalWeight > 0) {
        const startWeight = (cumBefore / totalWords) * sectionTotalWeight
        const endWeight = (cumAfter / totalWords) * sectionTotalWeight
        const topPx = weightToPx(startWeight, sectionEntries)
        const bottomPx = weightToPx(endWeight, sectionEntries)
        return { topPx, heightPx: Math.max(2, bottomPx - topPx) }
      }
    }
  }

  // Tier 2: word-count weighted proportional within the section.
  if (totalWords > 0) {
    const startFrac = cumBefore / totalWords
    const endFrac = cumAfter / totalWords
    return {
      topPx: sectionTop + startFrac * sectionH,
      heightPx: Math.max(2, (endFrac - startFrac) * sectionH),
    }
  }

  // Tier 3: pure proportional.
  return {
    topPx: sectionTop + (arrIdx / segCount) * sectionH,
    heightPx: Math.max(2, sectionH / segCount),
  }
}

function weightToPx(
  targetWeight: number,
  entries: { topPx: number; heightPx: number; weight: number }[],
): number {
  let cum = 0
  for (const e of entries) {
    if (cum + e.weight >= targetWeight) {
      const frac = e.weight > 0 ? (targetWeight - cum) / e.weight : 0
      return e.topPx + Math.max(0, Math.min(1, frac)) * e.heightPx
    }
    cum += e.weight
  }
  const last = entries[entries.length - 1]
  return last.topPx + last.heightPx
}
