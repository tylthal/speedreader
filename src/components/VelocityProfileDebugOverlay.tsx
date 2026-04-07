import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  createLookupCache,
  findEntryAt,
  type VelocityProfile,
} from '../lib/velocityProfile'
import type { FormattedViewHandle } from './FormattedView'

/**
 * Debug overlay for the formatted-view velocity profile.
 *
 * Enabled by appending `?debugProfile=1` to the URL. When active:
 *
 *   - Draws a translucent box at every ProfileEntry's pixel range,
 *     portaled into the formatted-view scroll container so the boxes
 *     scroll with the content. The currently-centered entry is
 *     highlighted in red.
 *   - A fixed-position stats panel in the bottom-left shows: which
 *     entry the scroll center is in, the live pxPerSec applied to it,
 *     pxPerWeight, current wpm, profile generation, total entries.
 *
 * The overlay re-reads via rAF rather than React state so the displayed
 * numbers update at engine tick rate. It uses a separate lookup-cache
 * instance from the engine so the two don't interfere.
 *
 * Strictly opt-in — for tuning the weight constants in velocityProfile.ts
 * against real books. Not shown to end users.
 */
interface VelocityProfileDebugOverlayProps {
  formattedViewRef: RefObject<FormattedViewHandle | null>
  velocityProfileRef: RefObject<VelocityProfile | null>
  wpm: number
}

function isDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).has('debugProfile')
  } catch {
    return false
  }
}

export default function VelocityProfileDebugOverlay({
  formattedViewRef,
  velocityProfileRef,
  wpm,
}: VelocityProfileDebugOverlayProps) {
  const enabled = isDebugEnabled()
  const [, forceRender] = useState(0)
  const cacheRef = useRef(createLookupCache())

  // Drive a rAF loop that simply forces a re-render on every frame. The
  // overlay is cheap (a few hundred absolutely-positioned divs at most)
  // and the user is expected to be tuning constants while watching this,
  // so smoothness matters more than CPU.
  useEffect(() => {
    if (!enabled) return
    let raf = 0
    const tick = () => {
      forceRender((n) => (n + 1) & 0xffff)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [enabled])

  if (!enabled) return null

  const profile = velocityProfileRef.current
  const container = formattedViewRef.current?.getScrollContainer() ?? null

  // Stats panel — always shown so the user can see whether a profile is
  // even built yet.
  const panel = (
    <div
      style={{
        position: 'fixed',
        bottom: 8,
        left: 8,
        zIndex: 9999,
        padding: '8px 10px',
        background: 'rgba(0,0,0,0.78)',
        color: '#9ef',
        font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
        borderRadius: 6,
        pointerEvents: 'none',
        maxWidth: 280,
      }}
    >
      <div style={{ fontWeight: 'bold', color: '#fff', marginBottom: 4 }}>
        velocity profile (debug)
      </div>
      {!profile && <div>profile: none</div>}
      {!container && <div>container: none</div>}
      {profile && container && renderStats(profile, container, cacheRef.current, wpm)}
    </div>
  )

  if (!profile || !container) return panel

  // Inline boundary boxes — portaled into the scroll container so they
  // share its scroll position naturally. Wrap in an absolutely-positioned
  // host that spans the full scroll height so each box can be placed
  // with `top: entry.topPx`.
  const centerY = container.scrollTop + container.clientHeight / 2
  const currentIdx = findEntryAt(profile, centerY, cacheRef.current)

  const lines = (
    <div
      data-debug="velocity-profile-overlay"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: Math.max(profile.totalHeight, container.scrollHeight),
        pointerEvents: 'none',
        zIndex: 100,
      }}
    >
      {profile.entries.map((e, i) => {
        const isCurrent = i === currentIdx
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: e.topPx,
              height: e.heightPx,
              border: isCurrent
                ? '2px solid rgba(255,40,80,0.85)'
                : '1px dashed rgba(0,200,255,0.35)',
              background: isCurrent
                ? 'rgba(255,40,80,0.06)'
                : 'transparent',
              boxSizing: 'border-box',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                background: 'rgba(0,0,0,0.7)',
                color: isCurrent ? '#fff' : '#9ef',
                padding: '1px 4px',
                font: '10px/1 ui-monospace, monospace',
                borderRadius: '0 0 0 4px',
              }}
            >
              {e.tag} w={e.weight.toFixed(1)} ppw={e.pxPerWeight.toFixed(2)}
            </span>
          </div>
        )
      })}
    </div>
  )

  return (
    <>
      {createPortal(lines, container)}
      {panel}
    </>
  )
}

function renderStats(
  profile: VelocityProfile,
  container: HTMLElement,
  cache: { lastIdx: number },
  wpm: number,
) {
  const centerY = container.scrollTop + container.clientHeight / 2
  const idx = findEntryAt(profile, centerY, cache)
  if (idx < 0) {
    return (
      <>
        <div>entries: {profile.entries.length}</div>
        <div>centerY: {centerY.toFixed(0)} (outside)</div>
        <div>generation: {profile.generation}</div>
      </>
    )
  }
  const e = profile.entries[idx]
  const pxPerSec = e.pxPerWeight * (wpm / 60)
  return (
    <>
      <div>
        entry {idx}/{profile.entries.length}: <b>{e.tag}</b>
      </div>
      <div>weight: {e.weight.toFixed(2)}</div>
      <div>pxPerWeight: {e.pxPerWeight.toFixed(2)}</div>
      <div>
        pxPerSec @ {wpm}wpm: <b>{pxPerSec.toFixed(1)}</b>
      </div>
      <div>
        center {centerY.toFixed(0)} ∈ [{e.topPx.toFixed(0)}, {e.bottomPx.toFixed(0)}]
      </div>
      <div>
        totals: w={profile.totalWeight.toFixed(0)} h=
        {profile.totalHeight.toFixed(0)} gen={profile.generation}
      </div>
    </>
  )
}
