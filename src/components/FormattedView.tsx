import {
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
}

/**
 * Minimal segment shape the highlight system needs from the parent.
 * Decoupled from the full Segment type so this component doesn't pull
 * in db/parser types just for highlighting.
 */
export interface HighlightSegment {
  text: string
  word_count?: number
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

/**
 * Imperative handle exposed via forwardRef. The surface stays minimal —
 * ReaderViewport reaches in for the things that can't be expressed as
 * props without forcing a re-render of the section innerHTML write path.
 *
 *   - Scroll container + section element for legacy callers
 *   - rebuildProfile / settleImages for the play-time layout settle
 *   - scrollSectionIntoView for explicit nav (TOC click, chapter buttons)
 *   - setHighlightForSegment is the ONLY highlight entry point. It
 *     looks up (or builds, if needed) the per-section text→DOM-range
 *     index, materializes per-line rects via Range.getClientRects(),
 *     and renders multi-line bands that hug the actual words. Falls
 *     back to a proportional / velocity-profile estimate when the
 *     text matcher can't locate a particular segment. Pass arrIdx=-1
 *     to clear the highlight.
 */
export interface FormattedViewHandle {
  getScrollContainer: () => HTMLDivElement | null
  getSectionEl: (idx: number) => HTMLElement | null
  rebuildProfile: () => void
  settleImages: (sectionIdx: number) => Promise<void>
  scrollSectionIntoView: (idx: number) => void
  setHighlightForSegment: (
    sectionIdx: number,
    arrIdx: number,
    segments: ReadonlyArray<HighlightSegment>,
  ) => HighlightInfo | null
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
}

const imageCache = new Map<number, ImageCacheEntry>()

function loadPublicationImages(
  publicationId: number,
  chapters: Chapter[],
): Promise<ImageLoadResult> {
  const cached = imageCache.get(publicationId)
  if (cached) return cached.promise

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

  imageCache.set(publicationId, { promise })
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

interface UploadDiag {
  parsedCount: number
  fileStorageAvailable: boolean
  attempted: number
  opfsCount: number
  dexieCount: number
  nativeCount: number
  failedCount: number
  firstError: string | null
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
const FormattedView = forwardRef<FormattedViewHandle, FormattedViewProps>(function FormattedView(
  {
    publicationId,
    chapters,
    currentSectionIndex,
    onVisibleSectionChange,
    onTap,
    velocityProfileRef,
    onLayoutChange,
  },
  ref,
) {
  // Stabilize the parent's onLayoutChange in a ref so rebuildProfileNow
  // doesn't need to re-create itself when the parent re-renders.
  const onLayoutChangeRef = useRef(onLayoutChange)
  onLayoutChangeRef.current = onLayoutChange
  const tapHandlers = useContentTap(onTap)
  const containerRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Map<number, HTMLElement>>(new Map())
  // Multi-line highlight rects for the current segment. Each entry
  // represents one visual line of the segment, in scroll-container
  // coordinates. The renderer maps each rect to an absolute-positioned
  // div so the highlight hugs the actual text instead of spanning the
  // full container width.
  const [highlightRects, setHighlightRects] = useState<RectInContainer[] | null>(null)
  // Per-section text→DOM-range cache. Built lazily on the first
  // setHighlightForSegment call for a section, invalidated inline in
  // the innerHTML-write effect when the body content changes. Stores
  // node+offset pairs (not rects), so the cache survives layout-only
  // shifts (font size, image decode, theme toggles); only the derived
  // rects are recomputed via Range.getClientRects() per cursor change.
  const segmentIndexRef = useRef<Map<number, SegmentRangeIndex>>(new Map())
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
  const [imageDiag, setImageDiag] = useState<{
    expected: number
    opfsCount: number
    dexieCount: number
    missingCount: number
  } | null>(null)
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
    imageLoadResolved || collectOpfsNames(chapters).length === 0
  const rewrittenSections = useMemo(() => {
    if (!imagesReady) return null
    return chapters.map((ch) => {
      const html = ch.html ?? ''
      if (!html) return { ch, html }
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
      return { ch, html: out }
    })
  }, [chapters, imageMap, imagesReady])

  // We set the section body innerHTML *imperatively* via a ref, NOT through
  // dangerouslySetInnerHTML. React 19's reconciler appears to track img
  // elements inside dangerouslySetInnerHTML and "fix" their src attributes
  // back to the original (unresolved) opfs: markers during commit, which
  // breaks the images on every re-render. Setting innerHTML imperatively
  // takes the inner DOM out of React's hands entirely.
  const bodyRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  useEffect(() => {
    if (!rewrittenSections) return
    let didWrite = false
    for (const { ch, html } of rewrittenSections) {
      const idx = chapters.indexOf(ch)
      const el = bodyRefs.current.get(idx)
      if (!el) continue
      if (el.dataset.lastHtml === html) continue
      el.innerHTML = html
      el.dataset.lastHtml = html
      // Invalidate the segment-range cache for this section — the
      // text nodes the cached ranges referenced have just been
      // replaced. The cache is rebuilt on the next
      // setHighlightForSegment call for this section.
      segmentIndexRef.current.delete(idx)
      didWrite = true
    }
    if (didWrite) {
      // Wait one frame for the browser to lay out the new HTML, then rebuild
      // the velocity profile. Layout might not be final (images still
      // decoding), but the ResizeObserver below will catch any subsequent
      // shifts and rebuild again — and the play-time settleImages() path
      // will force a rebuild before the engine starts.
      requestAnimationFrame(() => {
        rebuildProfileNow()
      })
    }
  }, [rewrittenSections, chapters])

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

  // Watch which section is at the top of the viewport and report it.
  // Deps include only `chapters` so the observer is rebuilt when sections
  // change, not on every parent re-render.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (isProgrammaticScrollRef.current) return
        let bestIdx = -1
        let bestTop = -Infinity
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
          }
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
      rebuildProfile: () => {
        rebuildProfileNow()
      },
      scrollSectionIntoView: (idx) => {
        const el = sectionRefs.current.get(idx)
        if (!el) return
        // Mark the index as "last reported" so the IntersectionObserver
        // doesn't echo a redundant onVisibleSectionChange after the
        // programmatic scroll lands.
        lastReportedIdxRef.current = idx
        // Suppress the IntersectionObserver while the programmatic
        // scroll is in flight. The flag is cleared when scrollend
        // fires (or after a 400ms timer fallback for browsers that
        // don't support scrollend).
        isProgrammaticScrollRef.current = true
        const container = containerRef.current
        const cleanup = () => {
          isProgrammaticScrollRef.current = false
          container?.removeEventListener('scrollend', cleanup as EventListener)
        }
        container?.addEventListener('scrollend', cleanup as EventListener, { once: true })
        // Fallback for Safari < 18.2 and others without scrollend.
        setTimeout(cleanup, 400)
        el.scrollIntoView({ block: 'start', behavior: 'auto' })
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
          setHighlightRects(null)
          return null
        }
        const container = containerRef.current
        const sectionEl = sectionRefs.current.get(sectionIdx)
        if (!container || !sectionEl) {
          setHighlightRects(null)
          return null
        }
        // Section must actually be laid out — body innerHTML lands
        // async after the image loader resolves.
        if (sectionEl.getBoundingClientRect().height < 80) {
          setHighlightRects(null)
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
            setHighlightRects(rects)
            let topMin = Infinity
            let bottomMax = -Infinity
            for (const r of rects) {
              if (r.topPx < topMin) topMin = r.topPx
              if (r.topPx + r.heightPx > bottomMax) bottomMax = r.topPx + r.heightPx
            }
            return {
              topPx: topMin,
              heightPx: Math.max(2, bottomMax - topMin),
              accurate: true,
            }
          }
        }

        // Fallback: text matcher couldn't find this segment (or the
        // Range produced no rects — hidden via CSS, etc). Use the
        // proportional / velocity-profile estimate so we still show
        // SOMETHING for that one segment.
        const fallback = computeProportionalBand(
          arrIdx,
          segments,
          sectionEl,
          container,
          velocityProfileRef?.current ?? null,
        )
        if (!fallback) {
          setHighlightRects(null)
          return null
        }
        // Render the fallback as a single full-width rect.
        const containerRect = container.getBoundingClientRect()
        const fallbackRect: RectInContainer = {
          topPx: fallback.topPx,
          leftPx: 0,
          widthPx: containerRect.width,
          heightPx: fallback.heightPx,
        }
        setHighlightRects([fallbackRect])
        return { ...fallback, accurate: false }
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
    <div className="formatted-view" ref={containerRef} {...tapHandlers}>
      {highlightRects?.map((r, i) => (
        <div
          key={i}
          className="formatted-view__highlight"
          aria-hidden="true"
          style={{
            top: `${r.topPx}px`,
            left: `${r.leftPx}px`,
            width: `${r.widthPx}px`,
            height: `${r.heightPx}px`,
          }}
        />
      ))}
      {diagEnabled && imageDiag && (
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 50,
            padding: '8px 12px',
            background: 'rgba(0,0,0,0.85)',
            color: '#9ef',
            font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
            borderBottom: '1px solid rgba(150,200,255,0.3)',
            textAlign: 'center',
          }}
        >
          <div style={{ color: '#fff', fontWeight: 'bold' }}>
            read: {imageDiag.opfsCount + imageDiag.dexieCount}/{imageDiag.expected} loaded
          </div>
          <div>
            opfs: {imageDiag.opfsCount} · dexie: {imageDiag.dexieCount} · missing: {imageDiag.missingCount}
          </div>
          {uploadDiag && (
            <>
              <div style={{ marginTop: 4, color: '#fff', fontWeight: 'bold' }}>
                upload: parsed {uploadDiag.parsedCount}, attempted {uploadDiag.attempted}
              </div>
              <div>
                opfs: {uploadDiag.opfsCount} · dexie: {uploadDiag.dexieCount} · native: {uploadDiag.nativeCount} · failed: {uploadDiag.failedCount}
              </div>
              {!uploadDiag.fileStorageAvailable && (
                <div style={{ color: '#fc8' }}>file storage was unavailable at upload time</div>
              )}
              {uploadDiag.firstError && (
                <div style={{ color: '#fc8' }}>first err: {uploadDiag.firstError}</div>
              )}
            </>
          )}
          {!uploadDiag && (
            <div style={{ color: '#fc8', marginTop: 4 }}>
              no upload-diag in localStorage — pub uploaded before this build
            </div>
          )}
          {imageDiag.expected === 0 && (
            <div style={{ color: '#fc8' }}>parser produced no opfs: markers — book has no images</div>
          )}
        </div>
      )}
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
            {!bodyHasLeadingHeading(ch.html) && (
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
