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

/**
 * Walk every section's html, extract every unique `opfs:NAME` marker, and
 * return the deduped list of names.
 */
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

  // Resolved name → blob URL.
  const [imageMap, setImageMap] = useState<Map<string, string>>(new Map())
  const createdUrlsRef = useRef<string[]>([])

  // Load every OPFS image once when the publication mounts.
  useEffect(() => {
    let cancelled = false
    const names = collectOpfsNames(chapters)
    if (!names.length) {
      setImageMap(new Map())
      return
    }
    ;(async () => {
      const next = new Map<string, string>()
      const created: string[] = []
      for (const name of names) {
        if (cancelled) break
        try {
          const blob = await getImageBlob(publicationId, name)
          if (blob) {
            const url = URL.createObjectURL(blob)
            next.set(name, url)
            created.push(url)
          } else {
            console.warn('[formatted] image not found in OPFS', { publicationId, name })
          }
        } catch (err) {
          console.warn('[formatted] image resolve failed', { name, err })
        }
      }
      if (!cancelled) {
        // Stash the created URLs so we can revoke on unmount.
        createdUrlsRef.current = created
        setImageMap(next)
      } else {
        // We were cancelled before commit; clean up our handles.
        for (const url of created) URL.revokeObjectURL(url)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [publicationId, chapters])

  // Revoke blob URLs only when the publication itself changes or on true
  // unmount. We never revoke between cleanup-and-resetup of the same mount,
  // so scrolling / chapter prop changes never invalidate the visible images.
  useEffect(() => {
    return () => {
      for (const url of createdUrlsRef.current) URL.revokeObjectURL(url)
      createdUrlsRef.current = []
    }
  }, [publicationId])

  // Pre-rewrite each section's HTML by string-replacing every `opfs:NAME`
  // src with its resolved blob URL. Memoized on (chapters, imageMap) so
  // we don't re-build on every parent re-render.
  const rewrittenSections = useMemo(() => {
    return chapters.map((ch) => {
      const html = ch.html ?? ''
      if (!html || imageMap.size === 0) return { ch, html }
      const rewritten = html.replace(
        /(<img\s[^>]*?src=["'])opfs:([^"']+)(["'])/gi,
        (match, head: string, name: string, tail: string) => {
          const url = imageMap.get(name)
          if (!url) return match // leave the marker; the broken-img icon
          return `${head}${url}${tail}`
        },
      )
      return { ch, html: rewritten }
    })
  }, [chapters, imageMap])

  // Scroll the current section into view whenever the cursor changes
  // externally (e.g. user toggled from plain → formatted).
  useEffect(() => {
    const el = sectionRefs.current.get(currentSectionIndex)
    if (!el) return
    isProgrammaticScrollRef.current = true
    el.scrollIntoView({ block: 'start', behavior: 'auto' })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        isProgrammaticScrollRef.current = false
      })
    })
  }, [currentSectionIndex])

  // Watch which section is at the top of the viewport and report it.
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
        if (bestIdx >= 0) onVisibleSectionChange(bestIdx)
      },
      { root: container, threshold: [0, 0.01, 0.5, 1] },
    )

    for (const el of sectionRefs.current.values()) {
      observer.observe(el)
    }

    return () => observer.disconnect()
  }, [chapters, onVisibleSectionChange])

  return (
    <div className="formatted-view" ref={containerRef}>
      <div className="formatted-view__column">
        {rewrittenSections.map(({ ch, html }, idx) => (
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
            <h1 className="formatted-view__title">{ch.title || 'Untitled'}</h1>
            {html ? (
              <div
                className="formatted-view__body"
                // The HTML was sanitized at parse time (src/lib/sanitize.ts)
                // and image opfs: markers have been pre-resolved to blob URLs.
                dangerouslySetInnerHTML={{ __html: html }}
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
