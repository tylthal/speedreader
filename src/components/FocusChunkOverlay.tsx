import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import type { Segment, InlineImage } from '../types';
import type { ReadingMode } from '../types';
import RsvpDisplay from './RsvpDisplay';

/** Renders segment text with optional inline images above it. */
function SegmentContent({ segment }: { segment: Segment }) {
  const images = segment.inline_images;
  if (!images || images.length === 0) {
    return <>{segment.text}</>;
  }
  return (
    <>
      {images.map((img, i) => (
        <img
          key={i}
          className="segment__inline-image"
          src={img.image_url}
          alt={img.alt || ''}
          loading="lazy"
        />
      ))}
      {segment.text}
    </>
  );
}

interface FocusChunkOverlayProps {
  segment: Segment | null;
  isPlaying: boolean;
  progress: number;
  mode: ReadingMode;
  rsvpWord?: string;
  rsvpOrpIndex?: number;
  rsvpWpm?: number;
  segments?: Segment[];
  currentIndex?: number;
  onSeek?: (index: number) => void;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  scrollItemRefs?: React.RefObject<Map<number, HTMLDivElement>>;
  suppressPausedView?: boolean;
}

const WING_COUNT = 3;

function getWingOpacity(distFromCenter: number, total: number): number {
  if (total <= 1) return 0.4;
  return 0.6 - (distFromCenter / total) * 0.4;
}

/* ------------------------------------------------------------------ */
/*  Paused scroll view — all segments in a scrollable list             */
/* ------------------------------------------------------------------ */

function PausedScrollView({
  segments,
  currentIndex,
  onSeek,
}: {
  segments: Segment[];
  currentIndex: number;
  onSeek: (index: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Suppression flag for handleScroll while a programmatic scroll
  // (initial mount or external currentIndex change) is in flight.
  // Cleared on the real scrollend event, with a 1500ms fallback for
  // browsers that don't fire scrollend.
  const programmaticScroll = useRef(false);
  const initialScrollDoneRef = useRef(false);

  const armProgrammaticGuard = useCallback(() => {
    const container = containerRef.current;
    programmaticScroll.current = true;
    const cleanup = () => {
      programmaticScroll.current = false;
      container?.removeEventListener('scrollend', cleanup as EventListener);
    };
    container?.addEventListener('scrollend', cleanup as EventListener, { once: true });
    setTimeout(cleanup, 1500);
  }, []);

  // Initial scroll (instant). Runs once on mount.
  useEffect(() => {
    const el = itemRefs.current.get(currentIndex);
    if (el) {
      armProgrammaticGuard();
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    initialScrollDoneRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll to current index when it changes from an external seek
  // (keyboard, scrubber, etc). Skips the first render — the initial
  // mount effect above owns it. After mount we use smooth for visual
  // continuity.
  useEffect(() => {
    if (!initialScrollDoneRef.current) return;
    const el = itemRefs.current.get(currentIndex);
    if (el) {
      armProgrammaticGuard();
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [currentIndex, armProgrammaticGuard]);

  // Detect which segment is closest to viewport center on user scroll.
  // rAF-throttled to one layout read per frame; calls onSeek directly
  // (no debounce) — positionStore.setPosition dedupes on equal values
  // so a stable scroll doesn't churn re-renders. The store is the
  // source of truth, so there's no need for an unmount flush.
  const rafPending = useRef(false);
  const rafHandleRef = useRef<number>(0);

  const handleScroll = useCallback(() => {
    if (programmaticScroll.current) return;
    if (rafPending.current) return;
    rafPending.current = true;
    rafHandleRef.current = requestAnimationFrame(() => {
      rafPending.current = false;
      rafHandleRef.current = 0;
      if (programmaticScroll.current) return;
      const container = containerRef.current;
      if (!container) return;

      const containerRect = container.getBoundingClientRect();
      const centerY = containerRect.top + containerRect.height / 2;

      const items = itemRefs.current;
      // Adaptive search: start near currentIndex, widen if best match
      // is at the edge of the search window.
      let closestIdx = currentIndex;
      let closestDist = Infinity;
      let radius = 15;
      for (let attempt = 0; attempt < 3; attempt++) {
        const lo = Math.max(0, closestIdx - radius);
        const hi = Math.min(segments.length - 1, closestIdx + radius);
        for (let idx = lo; idx <= hi; idx++) {
          const el = items.get(idx);
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          const dist = Math.abs(rect.top + rect.height / 2 - centerY);
          if (dist < closestDist) {
            closestDist = dist;
            closestIdx = idx;
          }
        }
        if (closestIdx === lo || closestIdx === hi) {
          radius *= 3;
        } else {
          break;
        }
      }

      if (closestIdx !== currentIndex) {
        onSeek(closestIdx);
      }
    });
  }, [segments.length, currentIndex, onSeek]);

  // Cancel any pending rAF on unmount. No flush needed: the store
  // already holds the latest scroll position because handleScroll
  // calls onSeek synchronously inside the rAF body.
  useEffect(() => {
    return () => {
      if (rafHandleRef.current) {
        cancelAnimationFrame(rafHandleRef.current);
        rafHandleRef.current = 0;
      }
    };
  }, []);

  const setItemRef = useCallback((idx: number, el: HTMLDivElement | null) => {
    if (el) {
      itemRefs.current.set(idx, el);
    } else {
      itemRefs.current.delete(idx);
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className="focus-scroll"
      onScroll={handleScroll}
    >
      {/* Spacer so first item can be centered */}
      <div className="focus-scroll__spacer" />

      {segments.map((seg, idx) => (
        <div
          key={seg.id}
          ref={(el) => setItemRef(idx, el)}
          className={
            idx === currentIndex
              ? 'focus-scroll__item focus-scroll__item--current'
              : 'focus-scroll__item'
          }
          onClick={() => onSeek(idx)}
        >
          <SegmentContent segment={seg} />
        </div>
      ))}

      {/* Spacer so last item can be centered */}
      <div className="focus-scroll__spacer" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Scroll mode playing view — auto-scrolled by engine                 */
/* ------------------------------------------------------------------ */

function ScrollPlayingView({
  segments,
  currentIndex,
  containerRef,
  itemRefsOut,
}: {
  segments: Segment[];
  currentIndex: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  itemRefsOut: React.RefObject<Map<number, HTMLDivElement>>;
}) {
  const setItemRef = useCallback((idx: number, el: HTMLDivElement | null) => {
    if (itemRefsOut.current) {
      if (el) {
        itemRefsOut.current.set(idx, el);
      } else {
        itemRefsOut.current.delete(idx);
      }
    }
  }, [itemRefsOut]);

  // Scroll to the current segment on mount so playback starts from the right position.
  // useLayoutEffect ensures this runs synchronously before paint, so the scroll
  // position is settled before any rAF tick in the engine captures scrollTop.
  //
  // We allow a brief mount window (2 renders) to also accept a late currentIndex
  // update from PausedScrollView's unmount cleanup flush, but stop after that
  // to avoid fighting with the engine's tick-driven scroll updates.
  const mountRenderCount = useRef(0);
  const lastScrolledIdx = useRef(-1);
  useLayoutEffect(() => {
    mountRenderCount.current++;
    // Only auto-scroll during the first 2 renders (mount + possible flush)
    if (mountRenderCount.current > 2) return;
    if (currentIndex === lastScrolledIdx.current) return;
    const el = itemRefsOut.current?.get(currentIndex);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      lastScrolledIdx.current = currentIndex;
    }
  }, [currentIndex, itemRefsOut]);

  return (
    <div
      ref={containerRef}
      className="focus-scroll focus-scroll--playing"
    >
      {/* Spacer so first item can be centered */}
      <div className="focus-scroll__spacer" />

      {segments.map((seg, idx) => (
          <div
            key={seg.id}
            ref={(el) => setItemRef(idx, el)}
            className="focus-scroll__item"
          >
            <SegmentContent segment={seg} />
          </div>
      ))}

      {/* Spacer so last item can be centered */}
      <div className="focus-scroll__spacer" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main overlay                                                       */
/* ------------------------------------------------------------------ */

export default function FocusChunkOverlay({
  segment,
  isPlaying,
  progress,
  mode,
  rsvpWord = '',
  rsvpOrpIndex = 0,
  rsvpWpm = 250,
  segments,
  currentIndex,
  onSeek,
  scrollContainerRef,
  scrollItemRefs,
  suppressPausedView,
}: FocusChunkOverlayProps) {
  const [displayText, setDisplayText] = useState('');
  const [animClass, setAnimClass] = useState('focus-overlay__text--visible');
  const prevTextRef = useRef('');
  const [wingsVisible, setWingsVisible] = useState(false);

  useEffect(() => {
    const newText = segment?.text ?? '';
    if (newText !== prevTextRef.current) {
      if (isPlaying) {
        // During playback, swap text instantly — no animation flash.
        setDisplayText(newText);
        prevTextRef.current = newText;
        setAnimClass('focus-overlay__text--visible');
      } else {
        // On pause or initial load, animate the transition.
        setAnimClass('focus-overlay__text--entering');
        const timer = setTimeout(() => {
          setDisplayText(newText);
          prevTextRef.current = newText;
          setAnimClass('focus-overlay__text--visible');
        }, 80);
        return () => clearTimeout(timer);
      }
    }
  }, [segment, isPlaying]);

  useEffect(() => {
    if (!isPlaying) {
      const timer = setTimeout(() => setWingsVisible(true), 120);
      return () => clearTimeout(timer);
    } else {
      setWingsVisible(false);
    }
  }, [isPlaying]);

  const wings = useMemo(() => {
    if (!segments || currentIndex == null) return { before: [], after: [] };
    const before: Segment[] = [];
    const after: Segment[] = [];
    for (let i = Math.max(0, currentIndex - WING_COUNT); i < currentIndex; i++) {
      before.push(segments[i]);
    }
    for (let i = currentIndex + 1; i <= Math.min(segments.length - 1, currentIndex + WING_COUNT); i++) {
      after.push(segments[i]);
    }
    return { before, after };
  }, [segments, currentIndex]);

  const showPrompt = !isPlaying && !segment;

  // --- Scroll / Track mode playing: auto-scrolling teleprompter ---
  if ((mode === 'scroll' || mode === 'track') && isPlaying && segments && segments.length > 0 && currentIndex != null && scrollContainerRef && scrollItemRefs) {
    return (
      <div className="focus-overlay" role="region" aria-label={mode === 'track' ? 'Track reading display' : 'Scroll reading display'}>
        <ScrollPlayingView
          segments={segments}
          currentIndex={currentIndex}
          containerRef={scrollContainerRef}
          itemRefsOut={scrollItemRefs}
        />
        <div className="focus-scroll__gradient focus-scroll__gradient--top" />
        <div className="focus-scroll__gradient focus-scroll__gradient--bottom" />
      </div>
    );
  }

  // --- Paused: show scrollable list ---
  if (!isPlaying && !suppressPausedView && segments && segments.length > 0 && currentIndex != null && onSeek) {
    return (
      <div className="focus-overlay" role="region" aria-label="Reading position">
        <PausedScrollView
          segments={segments}
          currentIndex={currentIndex}
          onSeek={onSeek}
        />
      </div>
    );
  }

  // --- Playing: existing focus/RSVP view ---

  const renderWings = (items: Segment[], direction: 'before' | 'after') => (
    <div
      className={`focus-overlay__wings focus-overlay__wings--${direction} ${wingsVisible ? 'focus-overlay__wings--visible' : ''}`}
      aria-hidden="true"
    >
      {items.map((seg, i) => {
        const dist = direction === 'before'
          ? items.length - i
          : i + 1;
        return (
          <span
            key={seg.id}
            className="focus-overlay__wing-segment"
            style={{ opacity: getWingOpacity(dist, items.length + 1) }}
          >
            {seg.text}
          </span>
        );
      })}
    </div>
  );

  if (mode === 'rsvp') {
    return (
      <div
        className="focus-overlay focus-overlay--playing"
        role="region"
        aria-roledescription="RSVP speed reading display"
        aria-label="RSVP reading display"
      >
        {renderWings(wings.before, 'before')}
        <div className="focus-overlay__center">
          <RsvpDisplay
            currentWord={rsvpWord}
            orpIndex={rsvpOrpIndex}
            isPlaying={isPlaying}
            wpm={rsvpWpm}
            progress={progress}
          />
        </div>
        {renderWings(wings.after, 'after')}
      </div>
    );
  }

  return (
    <div
      className="focus-overlay focus-overlay--playing"
      role="region"
      aria-roledescription="speed reading display"
      aria-label="Current reading segment"
    >
      {renderWings(wings.before, 'before')}

      <div className="focus-overlay__center">
        {showPrompt ? (
          <span className="focus-overlay__prompt">Tap to start</span>
        ) : (
          <span className={`focus-overlay__text ${animClass}`}>{displayText}</span>
        )}
      </div>

      {renderWings(wings.after, 'after')}
    </div>
  );
}
