# Scroll architecture

This document describes how scrolling works in the reader, and the
invariants that keep it smooth at 60 Hz during engine-driven playback.

## The problem this architecture solves

The reader has several parties interested in scroll events:

- **The PIP** (the visual "you are reading here" indicator in the
  formatted view) wants to reposition itself at the reading reference
  line whenever the user scrolls.
- **The cursor-sync hook** wants to detect which segment is at the
  reference line and commit it to the position store so the saver can
  persist it.
- **Diagnostics / perf overlays** want to observe scroll motion.
- **The playback engine** drives the scroll container itself — it writes
  `scrollTop` every frame during scroll and track modes.
- **Programmatic scrolls** (auto-scroll to a segment, scroll-to-TOC-target,
  position restoration) move the container to a specific position.

Before the scroll-perf refactor, each listener attached its own scroll
handler, rAF throttle, and `getBoundingClientRect()` reads. Each one did
its own ad-hoc `if (isPlaying)` / `if (isProgrammaticScroll)` guard.
During 60 Hz engine playback this multiplied into dozens of redundant
calls per frame, producing visible jitter.

## The three primitives

### `FrameRectCache` (`src/lib/frameRectCache.ts`)

A per-rAF `WeakMap<Element, DOMRect>` cache. Any code that calls
`cache.rectOf(el)` inside a single animation frame gets the same cached
rect. The cache self-invalidates on the next rAF.

**Lifetime:** one instance per scrollable view. Held by the ScrollDriver.
Not global — avoids cross-view staleness and makes the lifetime
unambiguous.

**Consumers:** PIP updater, `segmentRangeIndex.materializeRangeRects`,
`detectAtViewportCenter`. Any hot path that reads the container rect
more than once per frame should read through the cache.

### `ScrollDriver` (`src/lib/scrollDriver.ts`)

The single `scroll` listener per scrollable view. Owns:
- One passive `scroll` DOM listener.
- One rAF throttle.
- One `FrameRectCache`.
- A set of named subscribers.
- A `ScrollSource` tag (see below).

Subscribers register by name (`'pip'`, `'cursor-sync'`, `'diagnostics'`,
`'engine'`). On each throttled frame, the driver invokes them in a
deterministic priority order with a `ScrollFrame` object containing
`scrollTop`, `source`, and `rectCache`.

**Invariant:** there should be exactly ONE `addEventListener('scroll', ...)`
call in the entire codebase — inside `scrollDriver.ts`. Anything else
(other than React synthetic `onScroll` props) is a regression.

Grep to verify:
```
rg "addEventListener\('scroll'" src/
```

### `ScrollSource` — the engine/user discrimination tag

Instead of every subscriber doing its own `if (positionStore.isPlaying)`
check, the `ScrollFrame` carries a tag:

- `'user'` — default; unknown or genuine user-initiated motion.
- `'engine'` — the playback engine is driving.
- `'programmatic'` — a one-shot `scrollTo` (auto-scroll, TOC jump).
- `'restore'` — position restoration from saved state.

Who sets what:
- **FormattedView** mirrors `positionStore.isPlaying` onto the driver —
  on play, `setSource('engine')`; on pause, `clearSource()` (returns to
  `'user'`). This is the one wire that propagates engine state to all
  scroll consumers.
- **`beginProgrammaticScroll()` / `endProgrammaticScroll()`** (auto-scroll
  wrapping scrollTo) flip the source to `'programmatic'` and restore on
  end.
- Subscribers gate on `frame.source` instead of reading
  `positionStore.isPlaying` or checking `isProgrammaticScrollActive()`.

## Data flow during playback

1. Engine's rAF tick writes `container.scrollTop = X`.
2. Browser fires a `scroll` event on the container.
3. `ScrollDriver.onScroll` records `pendingScrollTop` and schedules an
   rAF if one isn't already scheduled.
4. On the next rAF, the driver invalidates its `rectCache`, builds a
   `ScrollFrame` with `source: 'engine'`, and fans out to subscribers in
   order: `engine` → `pip` → `cursor-sync` → `diagnostics`.
5. The `'pip'` subscriber short-circuits because `frame.source === 'engine'`.
6. The `'cursor-sync'` subscriber short-circuits because
   `frame.source !== 'user'`.
7. Net JS work per scroll frame during playback: ~10 µs (iterate map,
   check source, return). Down from multi-millisecond caret probes +
   O(n) getClientRects loops before the refactor.

## Render-cascade containment

Separate from the scroll path, the render-cascade story:

- `FormattedView` and `FocusChunkOverlay` are wrapped in `React.memo`
  so parent (`ActiveReader`) re-renders on segment-boundary commits do
  not propagate into them.
- `ActiveReader` collapses 7 `usePositionSelector` calls into a single
  composite selector using `shallowEqual` (`src/lib/shallowEqual.ts`).
- The `data-playing` attribute on the formatted-view container is
  toggled via direct `positionStore.subscribe()` — no React state, no
  re-render. CSS uses it to disable pointer-events and switch
  scroll-behavior to `auto` during playback.

## CSS

- `.formatted-view` has `contain: content` always (paint/layout/style
  containment).
- `.formatted-view[data-playing="true"]` adds `will-change: transform,
  scroll-position` + `pointer-events: none` + `scroll-behavior: auto`.
  The `pointer-events: none` lets the browser skip hit-testing on the
  subtree during playback.

## Profile-rebuild policy

`VelocityProfile` (the cognitive-load-weighted scroll-speed model) is
rebuilt when a `ResizeObserver` detects a significant section-height
change (image decode, font load, theme flip). Two rules:

1. **During playback:** rebuilds are deferred. A flag records that a
   rebuild is pending; when `positionStore.isPlaying` flips to `false`,
   the rebuild fires.
2. **Scheduling:** rebuilds use `requestIdleCallback` (timeout: 500ms)
   with `requestAnimationFrame` fallback. Rebuilds affect speed on the
   NEXT frame, not the current one, so slotting them into idle time
   avoids competing with paint.

## Adding a new scroll consumer

Do NOT add `container.addEventListener('scroll', ...)`. Instead:

```ts
const unsub = formattedViewRef.current?.subscribeToScroll(
  'my-consumer',
  (frame) => {
    if (frame.source !== 'user') return // gate appropriately
    // ... use frame.scrollTop, frame.rectCache
  },
)
```

If you need to do a one-shot programmatic scroll from new code, wrap it
in `beginProgrammaticScroll()` / `endProgrammaticScroll()` so the other
subscribers (PIP, cursor-sync) correctly bypass the frame.
