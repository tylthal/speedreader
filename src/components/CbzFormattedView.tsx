import { useEffect, useRef, useState } from 'react'
import { getImagePages, getImageUrl } from '../api/client'
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

interface ResolvedImagePage extends ImagePage {
  src: string
}

/**
 * Continuous-scroll comic page viewer (PRD §4.5). All pages are loaded
 * upfront and resolved to fresh object URLs at render time so stored page
 * references remain valid across reloads.
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
  const [pages, setPages] = useState<ResolvedImagePage[]>([])

  useEffect(() => {
    let cancelled = false
    const objectUrls: string[] = []

    getImagePages(publicationId, chapterId, 0, totalPages)
      .then(async (batch) => {
        const results = await Promise.allSettled(
          batch.pages.map(async (page) => {
            const src = await getImageUrl(publicationId, page.image_path)
            if (src?.startsWith('blob:')) objectUrls.push(src)
            return src ? { ...page, src } : null
          }),
        )
        if (cancelled) {
          objectUrls.forEach((url) => {
            if (url.startsWith('blob:')) URL.revokeObjectURL(url)
          })
          return
        }
        const resolved = results
          .filter((r): r is PromiseFulfilledResult<ResolvedImagePage | null> => r.status === 'fulfilled')
          .map((r) => r.value)
          .filter((page): page is ResolvedImagePage => page !== null)
        setPages(resolved)
      })
      .catch(() => {
        if (!cancelled) setPages([])
      })
    return () => {
      cancelled = true
      objectUrls.forEach((url) => {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url)
      })
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
              src={p.src}
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
