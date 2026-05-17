import { useEffect, useRef, useState } from 'react'

const HITCH_MS = 33
const LOG_HISTORY = 8

interface LogEntry {
  atMs: number
  dtMs: number
  source: string
}

/**
 * Tiny always-visible diagnostic badge for mobile-first perf work.
 *
 * Shows two numbers:
 *   LINE 1 — max rAF frame delta in the last ~1 s (ms). Color:
 *       green  < 20 ms   yellow 20–33 ms   red > 33 ms
 *   LINE 2 — seconds since the last hitch (>33 ms). Tells us the
 *       cadence between hitches precisely.
 *
 * Tap to expand into a scrollable mini-log of the last 8 hitches with
 * the Long Task source when available (mobile Safari often supports
 * PerformanceObserver({type:'longtask'}), which reports the containing
 * script file/frame for each long task — useful for attribution).
 *
 * Tap again to collapse. Long-press (500 ms) to hide entirely for
 * the session (sessionStorage.frameTimeBadgeHidden=1 to restore).
 */
export function FrameTimeBadge() {
  const [hidden, setHidden] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.sessionStorage?.getItem('frameTimeBadgeHidden') === '1'
    } catch {
      return false
    }
  })
  const [expanded, setExpanded] = useState(false)
  const [maxMs, setMaxMs] = useState(0)
  const [sinceHitchS, setSinceHitchS] = useState<number | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])

  const deltasRef = useRef<number[]>([])
  const lastTsRef = useRef(0)
  const lastHitchMsRef = useRef<number | null>(null)
  const pendingLongTaskRef = useRef<string>('')

  useEffect(() => {
    if (hidden) return
    let raf = 0
    let accum = 0
    const tick = (ts: number) => {
      if (lastTsRef.current > 0) {
        const dt = ts - lastTsRef.current
        const buf = deltasRef.current
        buf.push(dt)
        if (buf.length > 60) buf.shift()

        if (dt > HITCH_MS) {
          const src = pendingLongTaskRef.current || '(no longtask info)'
          pendingLongTaskRef.current = ''
          lastHitchMsRef.current = ts
          setLog((prev) => {
            const next: LogEntry[] = [
              { atMs: ts, dtMs: dt, source: src },
              ...prev,
            ]
            if (next.length > LOG_HISTORY) next.length = LOG_HISTORY
            return next
          })
        }

        accum += dt
        if (accum >= 250) {
          accum = 0
          let max = 0
          for (const d of buf) if (d > max) max = d
          setMaxMs(max)
          setSinceHitchS(
            lastHitchMsRef.current != null
              ? (ts - lastHitchMsRef.current) / 1000
              : null,
          )
        }
      }
      lastTsRef.current = ts
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      lastTsRef.current = 0
    }
  }, [hidden])

  // PerformanceObserver: capture Long Task entries and their attribution,
  // so when a hitch rAF-frame is recorded we can label where the block
  // came from. Attribution is browser-best-effort; may be a cross-origin
  // opaque label on iOS, but a present label is still diagnostic.
  useEffect(() => {
    if (hidden) return
    if (typeof PerformanceObserver === 'undefined') return
    let observer: PerformanceObserver | null = null
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const e = entry as PerformanceEntry & {
            attribution?: Array<{
              name?: string
              containerType?: string
              containerName?: string
              containerSrc?: string
            }>
          }
          const a = e.attribution?.[0]
          const label =
            a?.containerSrc || a?.containerName || a?.name || e.name || 'unknown'
          // Keep only the last segment of any URL / path for compactness.
          const shortLabel = label.split('/').pop() || label
          pendingLongTaskRef.current = `${shortLabel} ${entry.duration.toFixed(0)}ms`
        }
      })
      observer.observe({ type: 'longtask', buffered: true })
    } catch {
      observer = null
    }
    return () => {
      try {
        observer?.disconnect()
      } catch {
        /* ignore */
      }
    }
  }, [hidden])

  if (hidden) return null

  const color =
    maxMs > HITCH_MS ? '#ef4444' : maxMs > 20 ? '#f59e0b' : '#22c55e'

  return (
    <div
      style={{
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top, 0px) + 6px)',
        right: 'calc(env(safe-area-inset-right, 0px) + 6px)',
        zIndex: 999999,
        background: 'rgba(0, 0, 0, 0.82)',
        color: '#e0e0e0',
        font: '600 11px ui-monospace, "SF Mono", Menlo, monospace',
        padding: expanded ? '6px 8px' : '4px 7px',
        borderRadius: 6,
        border: '1px solid rgba(255,255,255,0.15)',
        pointerEvents: 'auto',
        maxWidth: expanded ? 240 : 68,
        textAlign: expanded ? 'left' : 'center',
        boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        onContextMenu={(e) => {
          e.preventDefault()
          try {
            window.sessionStorage?.setItem('frameTimeBadgeHidden', '1')
          } catch {
            /* ignore */
          }
          setHidden(true)
        }}
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          margin: 0,
          color,
          font: 'inherit',
          cursor: 'pointer',
          display: 'block',
          width: '100%',
          textAlign: expanded ? 'left' : 'center',
        }}
        aria-label="Frame-time diagnostic"
      >
        <div>{maxMs.toFixed(0)}ms</div>
        <div style={{ color: '#888', fontWeight: 400, fontSize: 10 }}>
          {sinceHitchS == null ? 'no hitch' : `L${sinceHitchS.toFixed(1)}s`}
        </div>
      </button>
      {expanded && log.length > 0 && (
        <div
          style={{
            marginTop: 6,
            paddingTop: 6,
            borderTop: '1px solid rgba(255,255,255,0.1)',
            fontSize: 10,
            color: '#ccc',
            fontWeight: 400,
          }}
        >
          {log.map((e, i) => (
            <div
              key={`${e.atMs}-${i}`}
              style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              <span style={{ color: '#ef4444' }}>{e.dtMs.toFixed(0)}ms</span>{' '}
              <span style={{ color: '#888' }}>{e.source}</span>
            </div>
          ))}
        </div>
      )}
      {expanded && log.length === 0 && (
        <div
          style={{
            marginTop: 6,
            paddingTop: 6,
            borderTop: '1px solid rgba(255,255,255,0.1)',
            fontSize: 10,
            color: '#888',
            fontWeight: 400,
          }}
        >
          No hitches yet
        </div>
      )}
    </div>
  )
}
