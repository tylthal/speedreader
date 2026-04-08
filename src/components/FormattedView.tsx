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
   * When true, render a subtle horizontal line at the vertical center of
   * the visible viewport. This is the "playback will start here" indicator
   * shown while paused — the engine reads container.scrollTop + clientHeight/2
   * as the start point in scroll/track formatted modes, and the segment-
   * proportional cursor mapping uses the same position for the other modes.
   * Caller passes !isPlaying.
   */
  showPauseCursor?: boolean
}

/**
 * Imperative handle exposed via forwardRef. After the cursor refactor
 * the surface shrunk significantly:
 *   - Scroll container + section element for the cursor mapping math
 *   - rebuildProfile / settleImages for the play-time layout settle
 *   - scrollSectionIntoView for explicit nav (TOC click, chapter buttons)
 *
 * setEngineDriving and markReported are gone — the IntersectionObserver
 * no longer fights an engine-driving feedback loop because alignment is
 * gated on cursor.origin upstream in ReaderViewport.
 */
export interface FormattedViewHandle {
  getScrollContainer: () => HTMLDivElement | null
  getSectionEl: (idx: number) => HTMLElement | null
  rebuildProfile: () => void
  settleImages: (sectionIdx: number) => Promise<void>
  scrollSectionIntoView: (idx: number) => void
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
    showPauseCursor,
  },
  ref,
) {
  const tapHandlers = useContentTap(onTap)
  const containerRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Map<number, HTMLElement>>(new Map())
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
    }),
    // velocityProfileRef is stable across renders (it's a ref) so we don't
    // need to re-derive the handle when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const diagEnabled = isImageDiagEnabled()
  const uploadDiag = diagEnabled ? readUploadDiag(publicationId) : null

  // Pause-mode "playback will start here" indicator. Position is the
  // vertical center of the formatted-view container's visible area —
  // matches centerY = scrollTop + clientHeight/2 used by the engine and
  // the cursor mapping. We track it via state so it follows window
  // resizes; scroll events don't change it because the line stays at
  // the viewport center, not at a content position.
  const [pauseCursorRect, setPauseCursorRect] = useState<{
    top: number
    left: number
    width: number
  } | null>(null)
  useEffect(() => {
    if (!showPauseCursor) {
      setPauseCursorRect(null)
      return
    }
    const update = () => {
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      setPauseCursorRect({
        top: rect.top + rect.height / 2,
        left: rect.left,
        width: rect.width,
      })
    }
    update()
    window.addEventListener('resize', update)
    // Layout shifts inside the formatted view (e.g. images decoding) can
    // change container.clientHeight if the container has flex sizing.
    // ResizeObserver catches that without polling.
    const ro = new ResizeObserver(update)
    if (containerRef.current) ro.observe(containerRef.current)
    return () => {
      window.removeEventListener('resize', update)
      ro.disconnect()
    }
  }, [showPauseCursor])

  return (
    <div className="formatted-view" ref={containerRef} {...tapHandlers}>
      {pauseCursorRect && (
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            top: pauseCursorRect.top,
            left: pauseCursorRect.left,
            width: pauseCursorRect.width,
            height: 2,
            marginTop: -1,
            background: 'currentColor',
            opacity: 0.18,
            pointerEvents: 'none',
            zIndex: 40,
            // Soft glow on either side so the line reads as "current
            // reading position" rather than "page divider".
            boxShadow: '0 0 8px 1px currentColor',
          }}
        />
      )}
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
