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
import { getImageBlob } from '../lib/fileStorage'
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
}

/**
 * Imperative handle exposed via forwardRef. ReaderViewport reaches in for
 * the things the engines and the formatted-mode play adapter need:
 *   - Scroll container, for the engines' containerRef
 *   - Section element, for the section-proportional cursor mapping
 *   - setEngineDriving — flips isProgrammaticScrollRef so the IntersectionObserver
 *     doesn't fight engine-driven scrollTop writes (the same defense the
 *     internal section-jump effect uses)
 *   - markReported — keeps lastReportedIdxRef in sync so the section-jump
 *     effect doesn't yank the user's position
 *   - rebuildProfile — synchronous rebuild, used by ResizeObserver and the
 *     play adapter after image decode settles
 *   - settleImages — async, awaits HTMLImageElement.decode() for every img
 *     in the given section so layout is stable before the engine starts
 */
export interface FormattedViewHandle {
  getScrollContainer: () => HTMLDivElement | null
  getSectionEl: (idx: number) => HTMLElement | null
  setEngineDriving: (driving: boolean) => void
  markReported: (idx: number) => void
  rebuildProfile: () => void
  settleImages: (sectionIdx: number) => Promise<void>
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

interface ImageCacheEntry {
  promise: Promise<Map<string, string>>
}

const imageCache = new Map<number, ImageCacheEntry>()

function loadPublicationImages(
  publicationId: number,
  chapters: Chapter[],
): Promise<Map<string, string>> {
  const cached = imageCache.get(publicationId)
  if (cached) return cached.promise

  const promise = (async () => {
    const names = collectOpfsNames(chapters)
    const map = new Map<string, string>()
    for (const name of names) {
      try {
        const blob = await getImageBlob(publicationId, name)
        if (blob) {
          map.set(name, URL.createObjectURL(blob))
        } else {
          console.warn('[formatted] image not found in OPFS', { publicationId, name })
        }
      } catch (err) {
        console.warn('[formatted] image resolve failed', { name, err })
      }
    }
    return map
  })()

  imageCache.set(publicationId, { promise })
  return promise
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
  },
  ref,
) {
  const tapHandlers = useContentTap(onTap)
  const containerRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Map<number, HTMLElement>>(new Map())
  const isProgrammaticScrollRef = useRef(false)

  // Generation counter bumped on every profile rebuild — engines compare
  // against their cached value to know when to reset the lookup adjacency
  // cache after a layout change.
  const profileGenerationRef = useRef(0)

  // Resolved name → blob URL. Pulled from a module-level cache so the URLs
  // persist across mounts/unmounts (StrictMode, HMR, conditional rendering).
  const [imageMap, setImageMap] = useState<Map<string, string>>(new Map())
  // Flips true once loadPublicationImages has resolved (success OR failure).
  // The gate below uses this instead of `imageMap.size > 0` because on
  // mobile browsers where OPFS writes silently failed at upload time, the
  // map will legitimately be empty — and we still need text to render.
  const [imageLoadResolved, setImageLoadResolved] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadPublicationImages(publicationId, chapters)
      .then((map) => {
        if (cancelled) return
        setImageMap(map)
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

  // Track the last section index we *reported* to the parent. The parent
  // will then call setChapterIdx with this same value, propagate it back
  // through the currentSectionIndex prop, and the scroll-into-view effect
  // below would otherwise yank the user's scroll position back to the top
  // of the section. Skipping the scroll when currentSectionIndex matches
  // what we just reported breaks that feedback loop.
  const lastReportedIdxRef = useRef<number>(currentSectionIndex)

  // Stabilize the parent's onVisibleSectionChange callback in a ref so the
  // IntersectionObserver effect below doesn't re-create the observer every
  // time the parent re-renders (which happens on every scroll because
  // chapterIdx changes are part of the parent's useCallback deps).
  const onVisibleSectionChangeRef = useRef(onVisibleSectionChange)
  onVisibleSectionChangeRef.current = onVisibleSectionChange

  // Scroll the current section into view ONLY when the cursor change came
  // from outside this component (TOC click, plain↔formatted toggle, etc.),
  // not when the user is scrolling and the IntersectionObserver fed the
  // change back to us.
  useEffect(() => {
    if (currentSectionIndex === lastReportedIdxRef.current) return
    const el = sectionRefs.current.get(currentSectionIndex)
    if (!el) return
    isProgrammaticScrollRef.current = true
    el.scrollIntoView({ block: 'start', behavior: 'auto' })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        isProgrammaticScrollRef.current = false
      })
    })
    // Mark the new index as the "last reported" baseline so the next scroll
    // event from the user starts comparing against the right value.
    lastReportedIdxRef.current = currentSectionIndex
  }, [currentSectionIndex])

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
      setEngineDriving: (driving) => {
        // Reuse the same flag the section-jump effect uses to suppress the
        // IntersectionObserver — when the engine is writing scrollTop on
        // every rAF, we MUST NOT feed those programmatic scrolls back through
        // onVisibleSectionChange or we'd loop. The flag is read inside the
        // observer callback at the top of this file.
        isProgrammaticScrollRef.current = driving
      },
      markReported: (idx) => {
        // Lets the formatted-mode cursor advance update lastReportedIdxRef
        // so the section-jump effect doesn't try to scrollIntoView when
        // chapterIdx changes from inside the engine.
        lastReportedIdxRef.current = idx
      },
      rebuildProfile: () => {
        rebuildProfileNow()
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

  return (
    <div className="formatted-view" ref={containerRef} {...tapHandlers}>
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
