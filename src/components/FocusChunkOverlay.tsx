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
  const isUserScrolling = useRef(false);
  const scrollTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const programmaticScroll = useRef(false);
  // Tracks whether the initial mount scroll has run. The "scroll on
  // currentIndex change" effect must skip the first render — otherwise
  // it races the initial-mount instant scroll with a smooth scroll
  // whose animation outlasts the programmatic-scroll cooldown, and
  // handleScroll's mid-animation snapshot fires onSeek with the wrong
  // index. That was the "stops in the wrong place" bug.
  const initialScrollDoneRef = useRef(false);

  // Helper: clear programmaticScroll on the real scrollend event (with
  // a generous fallback for browsers without scrollend support). The
  // earlier 100/500ms timeouts were both shorter than the in-flight
  // smooth-scroll animation, so handleScroll could fire mid-animation
  // with the flag already cleared.
  const clearProgrammaticOn = useCallback((container: HTMLDivElement | null) => {
    const cleanup = () => {
      programmaticScroll.current = false;
      container?.removeEventListener('scrollend', cleanup as EventListener);
    };
    container?.addEventListener('scrollend', cleanup as EventListener, { once: true });
    // Fallback: 1500ms is longer than any reasonable smooth scroll animation.
    setTimeout(cleanup, 1500);
  }, []);

  // Initial scroll (instant, no animation). Runs once on mount.
  useEffect(() => {
    const el = itemRefs.current.get(currentIndex);
    if (el) {
      programmaticScroll.current = true;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      clearProgrammaticOn(containerRef.current);
    }
    initialScrollDoneRef.current = true;
    // Only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll to current index when it changes from an external seek.
  // Skips the very first render — the initial-mount effect above owns
  // that. After mount we use smooth scroll for visual continuity.
  useEffect(() => {
    if (!initialScrollDoneRef.current) return;
    const el = itemRefs.current.get(currentIndex);
    if (el && !isUserScrolling.current) {
      programmaticScroll.current = true;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      clearProgrammaticOn(containerRef.current);
    }
  }, [currentIndex, clearProgrammaticOn]);

  // Detect which segment is closest to center on scroll.
  // Throttled via rAF to run at most once per frame, and onSeek is
  // debounced to avoid re-rendering the entire tree on every scroll frame.
  const rafPending = useRef(false);
  const pendingSeekIdx = useRef(currentIndex);
  const seekDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Keep refs to current values so the unmount cleanup isn't stale
  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  const handleScroll = useCallback(() => {
    if (programmaticScroll.current) return;

    isUserScrolling.current = true;
    clearTimeout(scrollTimeout.current);

    // Throttle to one layout read per frame
    if (!rafPending.current) {
      rafPending.current = true;
      requestAnimationFrame(() => {
        rafPending.current = false;
        // Re-check the programmatic-scroll flag inside the rAF too:
        // a programmatic scroll started after handleScroll's outer
        // check but before the rAF body would otherwise run, racing
        // the same way the cooldown-timeout fix is meant to prevent.
        if (programmaticScroll.current) return;
        const container = containerRef.current;
        if (!container) return;

        const containerRect = container.getBoundingClientRect();
        const centerY = containerRect.top + containerRect.height / 2;

        const items = itemRefs.current;
        // Adaptive search: start near last known position, widen if
        // the best match is at the edge (user scrolled fast/far).
        let closestIdx = pendingSeekIdx.current;
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

          // If best match is at the edge, widen the search and retry
          // centered on the new best match
          if (closestIdx === lo || closestIdx === hi) {
            radius *= 3;
          } else {
            break; // found a match that's not at the boundary
          }
        }

        pendingSeekIdx.current = closestIdx;

        // Debounce the actual seek to avoid constant re-renders
        clearTimeout(seekDebounceRef.current);
        seekDebounceRef.current = setTimeout(() => {
          if (pendingSeekIdx.current !== currentIndexRef.current) {
            onSeekRef.current(pendingSeekIdx.current);
          }
        }, 100);
      });
    }

    scrollTimeout.current = setTimeout(() => {
      isUserScrolling.current = false;
    }, 150);
  }, [segments.length]);

  // Flush any pending debounced seek on unmount so currentIndex is up-to-date
  // before ScrollPlayingView mounts (e.g. user scrolled then immediately hit Play).
  useEffect(() => {
    return () => {
      clearTimeout(seekDebounceRef.current);
      if (pendingSeekIdx.current !== currentIndexRef.current) {
        onSeekRef.current(pendingSeekIdx.current);
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
          className="focus-scroll__item"
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
}: FocusChunkOverlayProps) {
  const [displayText, setDisplayText] = useState('');
  const [animClass, setAnimClass] = useState('focus-overlay__text--visible');
  const prevTextRef = useRef('');
  const [wingsVisible, setWingsVisible] = useState(false);

  useEffect(() => {
    const newText = segment?.text ?? '';
    if (newText !== prevTextRef.current) {
      setAnimClass('focus-overlay__text--entering');
      const timer = setTimeout(() => {
        setDisplayText(newText);
        prevTextRef.current = newText;
        setAnimClass('focus-overlay__text--visible');
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [segment]);

  useEffect(() => {
    if (!isPlaying && segment) {
      const timer = setTimeout(() => setWingsVisible(true), 120);
      return () => clearTimeout(timer);
    } else {
      setWingsVisible(false);
    }
  }, [isPlaying, segment]);

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
  if (!isPlaying && segments && segments.length > 0 && currentIndex != null && onSeek) {
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
