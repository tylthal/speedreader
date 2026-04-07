import { useEffect, useRef, useState } from 'react'
import { getImagePages } from '../api/client'
import type { ImagePage } from '../api/client'
import { useContentTap } from '../hooks/useContentTap'

interface CbzFormattedViewProps {
  publicationId: number
  /** The single CBZ section's chapter id. */
  chapterId: number
  totalPages: number
  /** Index of the page the reader is currently on. */
  currentPageIndex: number
  onVisiblePageChange: (pageIndex: number) => void
  /** Tap-to-toggle-playback. */
  onTap?: () => void
}

/**
 * Continuous-scroll comic page viewer (PRD §4.5). All pages are loaded
 * upfront — they're already URL.createObjectURL'd at upload time and we
 * lean on lazy <img loading="lazy"> for paint-time efficiency.
 */
export default function CbzFormattedView({
  publicationId,
  chapterId,
  totalPages,
  currentPageIndex,
  onVisiblePageChange,
  onTap,
}: CbzFormattedViewProps) {
  const tapHandlers = useContentTap(onTap)
  const containerRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const isProgrammaticScrollRef = useRef(false)
  const [pages, setPages] = useState<ImagePage[]>([])

  useEffect(() => {
    let cancelled = false
    getImagePages(publicationId, chapterId, 0, totalPages)
      .then((batch) => {
        if (!cancelled) setPages(batch.pages)
      })
      .catch(() => {
        if (!cancelled) setPages([])
      })
    return () => {
      cancelled = true
    }
  }, [publicationId, chapterId, totalPages])

  // Track topmost visible page and report it.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !pages.length) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (isProgrammaticScrollRef.current) return
        let bestIdx = -1
        let bestTop = -Infinity
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const idx = parseInt(
            (entry.target as HTMLElement).dataset.pageIdx ?? '-1',
            10,
          )
          const top = entry.boundingClientRect.top
          if (top <= 50 && top > bestTop) {
            bestTop = top
            bestIdx = idx
          }
        }
        if (bestIdx >= 0) onVisiblePageChange(bestIdx)
      },
      { root: container, threshold: [0, 0.1] },
    )
    for (const el of pageRefs.current.values()) observer.observe(el)
    return () => observer.disconnect()
  }, [pages, onVisiblePageChange])

  // Scroll to current page when it changes externally.
  useEffect(() => {
    const el = pageRefs.current.get(currentPageIndex)
    if (!el) return
    isProgrammaticScrollRef.current = true
    el.scrollIntoView({ block: 'start', behavior: 'auto' })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { isProgrammaticScrollRef.current = false })
    })
  }, [currentPageIndex, pages.length])

  return (
    <div className="formatted-view formatted-view--cbz" ref={containerRef} {...tapHandlers}>
      <div className="formatted-view__column formatted-view__column--cbz">
        {pages.map((p) => (
          <div
            key={p.id}
            ref={(el) => {
              if (el) pageRefs.current.set(p.page_index, el)
              else pageRefs.current.delete(p.page_index)
            }}
            data-page-idx={p.page_index}
            className="formatted-view__cbz-page"
          >
            <img
              src={p.image_path}
              alt=""
              loading="lazy"
              decoding="async"
              className="formatted-view__cbz-img"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
