import { useEffect, useRef } from 'react'
import type { Chapter } from '../api/client'

interface FormattedViewProps {
  chapters: Chapter[]
  /** Index of the section the reader cursor is currently in. */
  currentSectionIndex: number
  /** Called when scrolling causes a different section to become visible. */
  onVisibleSectionChange: (sectionIndex: number) => void
}

/**
 * Continuous-scroll formatted view (PRD §4.3) for HTML-derived books.
 *
 * Renders every section's sanitized HTML stacked vertically inside a centered
 * column. Each section is wrapped in `<article id="section-{N}">` so the
 * reader can scroll-into-view by anchor (PRD §5.3).
 *
 * Anchor mapping is currently section-level: switching back to plain view
 * lands the cursor at the topmost visible section. Per-paragraph precision
 * is PRD §10 future work.
 */
export default function FormattedView({
  chapters,
  currentSectionIndex,
  onVisibleSectionChange,
}: FormattedViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Map<number, HTMLElement>>(new Map())
  const isProgrammaticScrollRef = useRef(false)

  // Scroll the current section into view whenever the cursor changes
  // externally (e.g. user toggled from plain → formatted).
  useEffect(() => {
    const el = sectionRefs.current.get(currentSectionIndex)
    if (!el) return
    isProgrammaticScrollRef.current = true
    el.scrollIntoView({ block: 'start', behavior: 'auto' })
    // Wait one frame for the scroll to settle before re-enabling
    // intersection-observer-driven section reporting.
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
        // Pick the entry whose top is closest to (but not below) the
        // container's top edge.
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
            <h1 className="formatted-view__title">{ch.title || 'Untitled'}</h1>
            {ch.html ? (
              <div
                className="formatted-view__body"
                // The HTML was sanitized at parse time (src/lib/sanitize.ts).
                dangerouslySetInnerHTML={{ __html: ch.html }}
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
