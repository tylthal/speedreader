import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { Segment } from '../types';
import type { ReadingMode } from '../types';
import RsvpDisplay from './RsvpDisplay';

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

  // Scroll to current index when it changes (from external seek or initial mount)
  useEffect(() => {
    const el = itemRefs.current.get(currentIndex);
    if (el && !isUserScrolling.current) {
      programmaticScroll.current = true;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // Reset programmatic flag after scroll completes
      setTimeout(() => { programmaticScroll.current = false; }, 500);
    }
  }, [currentIndex]);

  // Initial scroll (instant, no animation)
  useEffect(() => {
    const el = itemRefs.current.get(currentIndex);
    if (el) {
      programmaticScroll.current = true;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      setTimeout(() => { programmaticScroll.current = false; }, 100);
    }
    // Only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Detect which segment is closest to center on scroll.
  // Throttled via rAF to run at most once per frame, and onSeek is
  // debounced to avoid re-rendering the entire tree on every scroll frame.
  const rafPending = useRef(false);
  const pendingSeekIdx = useRef(currentIndex);
  const seekDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleScroll = useCallback(() => {
    if (programmaticScroll.current) return;

    isUserScrolling.current = true;
    clearTimeout(scrollTimeout.current);

    // Throttle to one layout read per frame
    if (!rafPending.current) {
      rafPending.current = true;
      requestAnimationFrame(() => {
        rafPending.current = false;
        const container = containerRef.current;
        if (!container) return;

        // Use scrollTop + cached positions instead of getBoundingClientRect
        // for each item. Fall back to a sampling approach — check only items
        // near the current index rather than all items.
        const containerRect = container.getBoundingClientRect();
        const centerY = containerRect.top + containerRect.height / 2;

        const items = itemRefs.current;
        const searchRadius = 10; // only check nearby items
        let closestIdx = pendingSeekIdx.current;
        let closestDist = Infinity;

        const lo = Math.max(0, closestIdx - searchRadius);
        const hi = Math.min(segments.length - 1, closestIdx + searchRadius);

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

        pendingSeekIdx.current = closestIdx;

        // Debounce the actual seek to avoid constant re-renders
        clearTimeout(seekDebounceRef.current);
        seekDebounceRef.current = setTimeout(() => {
          if (pendingSeekIdx.current !== currentIndex) {
            onSeek(pendingSeekIdx.current);
          }
        }, 100);
      });
    }

    scrollTimeout.current = setTimeout(() => {
      isUserScrolling.current = false;
    }, 150);
  }, [currentIndex, onSeek, segments.length]);

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
          {seg.text}
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

  // Scroll to the current segment on mount so playback starts from the right position
  const didInitialScroll = useRef(false);
  useEffect(() => {
    if (didInitialScroll.current) return;
    const el = itemRefsOut.current?.get(currentIndex);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      didInitialScroll.current = true;
    }
    // Only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            {seg.text}
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

  // --- Scroll / Eye track mode playing: auto-scrolling teleprompter ---
  if ((mode === 'scroll' || mode === 'eyetrack') && isPlaying && segments && segments.length > 0 && currentIndex != null && scrollContainerRef && scrollItemRefs) {
    return (
      <div className="focus-overlay" role="region" aria-label={mode === 'eyetrack' ? 'Eye track reading display' : 'Scroll reading display'}>
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
