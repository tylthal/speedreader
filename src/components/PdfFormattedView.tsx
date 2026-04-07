import { useEffect, useRef, useState } from 'react'
import { getBookFile } from '../lib/fileStorage'
import type { Chapter } from '../api/client'

interface PdfFormattedViewProps {
  publicationId: number
  chapters: Chapter[]
  currentSectionIndex: number
  onVisibleSectionChange: (sectionIndex: number) => void
}

interface PdfSectionMeta {
  startPage: number
  endPage: number
}

interface PageBox {
  pageNum: number
  sectionIdx: number
  /** Estimated height (px) before the page is rendered, for layout stability. */
  estimatedHeight: number
}

const VIRT_WINDOW = 5 // pages above and below the viewport to keep mounted

/**
 * Continuous PDF formatted view (PRD §4.3).
 *
 * Loads the original PDF from OPFS via getBookFile() and renders every page
 * stacked vertically. To avoid OOM on large books we render only a sliding
 * window of pages around the current viewport using an IntersectionObserver
 * over placeholder containers.
 */
export default function PdfFormattedView({
  publicationId,
  chapters,
  currentSectionIndex,
  onVisibleSectionChange,
}: PdfFormattedViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const sectionFirstPageRef = useRef<Map<number, number>>(new Map())
  const docRef = useRef<any>(null)
  const isProgrammaticScrollRef = useRef(false)
  const [pages, setPages] = useState<PageBox[]>([])
  const [renderedPages, setRenderedPages] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)

  // Open the PDF + compute page list.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const file = await getBookFile(publicationId)
        if (!file) {
          setError('Original PDF file is no longer available.')
          return
        }
        const data = await file.arrayBuffer()
        const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
        const PdfWorker = (await import('../workers/pdfWorker.ts?worker')).default
        if (!pdfjsLib.GlobalWorkerOptions.workerPort) {
          pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()
        }
        const doc = await pdfjsLib.getDocument({ data }).promise
        if (cancelled) {
          doc.destroy()
          return
        }
        docRef.current = doc

        // Build the flat page list, tagging each with its containing section.
        const list: PageBox[] = []
        const firstPage = new Map<number, number>()
        for (let s = 0; s < chapters.length; s++) {
          const meta = (chapters[s].meta as PdfSectionMeta | null) ?? null
          const startPage = meta?.startPage ?? 0
          const endPage = meta?.endPage ?? doc.numPages
          firstPage.set(s, startPage)
          for (let p = startPage; p < endPage && p < doc.numPages; p++) {
            list.push({ pageNum: p + 1, sectionIdx: s, estimatedHeight: 800 })
          }
        }
        sectionFirstPageRef.current = firstPage
        setPages(list)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to open PDF')
        }
      }
    })()
    return () => {
      cancelled = true
      try { docRef.current?.destroy() } catch { /* ignore */ }
      docRef.current = null
    }
  }, [publicationId, chapters])

  // Render-on-demand within the visible window.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !pages.length) return

    const observer = new IntersectionObserver(
      (entries) => {
        const newlyVisible = new Set<number>(renderedPages)
        for (const entry of entries) {
          const pageNum = parseInt(
            (entry.target as HTMLElement).dataset.pageNum ?? '-1',
            10,
          )
          if (Number.isNaN(pageNum) || pageNum < 0) continue
          if (entry.isIntersecting) {
            // Mount this page and ±VIRT_WINDOW around it.
            for (let p = pageNum - VIRT_WINDOW; p <= pageNum + VIRT_WINDOW; p++) {
              if (p >= 1 && p <= pages.length) newlyVisible.add(p)
            }
          }
        }
        if (newlyVisible.size !== renderedPages.size) {
          setRenderedPages(newlyVisible)
        }
      },
      { root: container, rootMargin: '200px 0px' },
    )
    for (const el of pageRefs.current.values()) observer.observe(el)
    return () => observer.disconnect()
  }, [pages, renderedPages])

  // Render newly-visible pages onto their canvases.
  useEffect(() => {
    const doc = docRef.current
    if (!doc) return
    let cancelled = false
    ;(async () => {
      for (const pageNum of renderedPages) {
        const el = pageRefs.current.get(pageNum)
        if (!el || el.dataset.rendered === '1') continue
        try {
          const page = await doc.getPage(pageNum)
          if (cancelled) return
          const baseViewport = page.getViewport({ scale: 1 })
          const containerWidth = el.clientWidth || 680
          const scale = Math.min(containerWidth / baseViewport.width, 2)
          const viewport = page.getViewport({ scale })
          const canvas = document.createElement('canvas')
          canvas.width = Math.ceil(viewport.width)
          canvas.height = Math.ceil(viewport.height)
          canvas.style.width = '100%'
          canvas.style.height = 'auto'
          const ctx = canvas.getContext('2d')
          if (!ctx) continue
          await page.render({ canvasContext: ctx, viewport, canvas } as any).promise
          if (cancelled) return
          // Replace placeholder with the canvas
          el.innerHTML = ''
          el.appendChild(canvas)
          el.dataset.rendered = '1'
          el.style.minHeight = `${canvas.height}px`
        } catch {
          /* skip pages that fail to render */
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [renderedPages])

  // Section visibility tracking — when a page from a different section
  // becomes the topmost visible page, report its section index.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !pages.length) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (isProgrammaticScrollRef.current) return
        let bestSection = -1
        let bestTop = -Infinity
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const sectionIdx = parseInt(
            (entry.target as HTMLElement).dataset.sectionIdx ?? '-1',
            10,
          )
          const top = entry.boundingClientRect.top
          if (top <= 50 && top > bestTop) {
            bestTop = top
            bestSection = sectionIdx
          }
        }
        if (bestSection >= 0) onVisibleSectionChange(bestSection)
      },
      { root: container, threshold: [0, 0.1] },
    )
    for (const el of pageRefs.current.values()) observer.observe(el)
    return () => observer.disconnect()
  }, [pages, onVisibleSectionChange])

  // Scroll to current section when it changes externally.
  useEffect(() => {
    const firstPage = sectionFirstPageRef.current.get(currentSectionIndex)
    if (firstPage == null) return
    const el = pageRefs.current.get(firstPage + 1)
    if (!el) return
    isProgrammaticScrollRef.current = true
    el.scrollIntoView({ block: 'start', behavior: 'auto' })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { isProgrammaticScrollRef.current = false })
    })
  }, [currentSectionIndex])

  if (error) {
    return (
      <div className="formatted-view formatted-view--error">
        <p>{error}</p>
      </div>
    )
  }

  return (
    <div className="formatted-view formatted-view--pdf" ref={containerRef}>
      <div className="formatted-view__column">
        {pages.map((p) => (
          <div
            key={p.pageNum}
            ref={(el) => {
              if (el) pageRefs.current.set(p.pageNum, el)
              else pageRefs.current.delete(p.pageNum)
            }}
            data-page-num={p.pageNum}
            data-section-idx={p.sectionIdx}
            className="formatted-view__pdf-page"
            style={{ minHeight: `${p.estimatedHeight}px` }}
          />
        ))}
      </div>
    </div>
  )
}
