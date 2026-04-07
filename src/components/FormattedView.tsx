import { useEffect, useMemo, useRef, useState } from 'react'
import type { Chapter } from '../api/client'
import { getImageBlob } from '../lib/fileStorage'

interface FormattedViewProps {
  publicationId: number
  chapters: Chapter[]
  /** Index of the section the reader cursor is currently in. */
  currentSectionIndex: number
  /** Called when scrolling causes a different section to become visible. */
  onVisibleSectionChange: (sectionIndex: number) => void
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
export default function FormattedView({
  publicationId,
  chapters,
  currentSectionIndex,
  onVisibleSectionChange,
}: FormattedViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Map<number, HTMLElement>>(new Map())
  const isProgrammaticScrollRef = useRef(false)

  // Resolved name → blob URL. Pulled from a module-level cache so the URLs
  // persist across mounts/unmounts (StrictMode, HMR, conditional rendering).
  const [imageMap, setImageMap] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false
    loadPublicationImages(publicationId, chapters).then((map) => {
      if (!cancelled) setImageMap(map)
    })
    return () => {
      cancelled = true
    }
  }, [publicationId, chapters])

  // Pre-rewrite each section's HTML by string-replacing every `opfs:NAME`
  // src with its resolved blob URL. We DELAY the rewrite until imageMap is
  // populated so the unresolved HTML never reaches the DOM (otherwise the
  // browser would briefly fire ERR_UNKNOWN_URL_SCHEME for every opfs: src
  // and the user would see broken-image icons until the load completes).
  // Memoized on (chapters, imageMap).
  const imagesReady = imageMap.size > 0 || collectOpfsNames(chapters).length === 0
  const rewrittenSections = useMemo(() => {
    if (!imagesReady) return null
    return chapters.map((ch) => {
      const html = ch.html ?? ''
      if (!html) return { ch, html }
      const rewritten = imageMap.size === 0
        ? html
        : html.replace(
            /(<img\s[^>]*?src=["'])opfs:([^"']+)(["'])/gi,
            (match, head: string, name: string, tail: string) => {
              const url = imageMap.get(name)
              if (!url) return match
              return `${head}${url}${tail}`
            },
          )
      return { ch, html: rewritten }
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
    for (const { ch, html } of rewrittenSections) {
      const idx = chapters.indexOf(ch)
      const el = bodyRefs.current.get(idx)
      if (!el) continue
      if (el.dataset.lastHtml === html) continue
      el.innerHTML = html
      el.dataset.lastHtml = html
    }
  }, [rewrittenSections, chapters])

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

  return (
    <div className="formatted-view" ref={containerRef}>
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
}
