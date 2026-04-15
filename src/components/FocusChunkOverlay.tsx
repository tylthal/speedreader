import { memo, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import type { Segment, InlineImage } from '../types';
import type { ReadingMode } from '../types';
import type { ChapterSegments } from '../hooks/useAllChapterSegments';
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
  /** All chapters' segments for the paused all-book scroll view. When
   *  provided (plain mode, paused) PausedScrollView renders every
   *  chapter's segments so users can scroll the whole book. When empty
   *  (playing, or still loading) the view falls back to single-chapter
   *  behavior. Playing mode uses ScrollPlayingView and its per-chapter
   *  segments as before. */
  allChapters?: ChapterSegments[];
  currentChapterIdx?: number;
  currentAbsoluteIndex?: number;
  onCrossChapterSeek?: (chapterIdx: number, absoluteIndex: number) => void;
}

const WING_COUNT = 3;

function getWingOpacity(distFromCenter: number, total: number): number {
  if (total <= 1) return 0.4;
  return 0.6 - (distFromCenter / total) * 0.4;
}

/* ------------------------------------------------------------------ */
/*  Paused scroll view — all segments in a scrollable list             */
/* ------------------------------------------------------------------ */

interface FlatItem {
  chapterIdx: number;
  absoluteIndex: number;
  key: string;
  seg: Segment;
}

function PausedScrollView({
  segments,
  currentIndex,
  onSeek,
  allChapters,
  currentChapterIdx,
  currentAbsoluteIndex,
  onCrossChapterSeek,
}: {
  segments: Segment[];
  currentIndex: number;
  onSeek: (index: number) => void;
  allChapters?: ChapterSegments[];
  currentChapterIdx?: number;
  currentAbsoluteIndex?: number;
  onCrossChapterSeek?: (chapterIdx: number, absoluteIndex: number) => void;
}) {
  // When allChapters is provided we render the flat multi-chapter list;
  // otherwise we fall back to the original single-chapter behavior using
  // `segments` / `currentIndex` / `onSeek`.
  const useMulti =
    !!allChapters &&
    allChapters.length > 0 &&
    currentChapterIdx != null &&
    currentAbsoluteIndex != null &&
    !!onCrossChapterSeek;

  const flatItems = useMemo<FlatItem[]>(() => {
    if (!useMulti) return [];
    const out: FlatItem[] = [];
    for (const ch of allChapters!) {
      for (const seg of ch.segments) {
        out.push({
          chapterIdx: ch.chapterIdx,
          absoluteIndex: seg.segment_index,
          key: `${ch.chapterIdx}:${seg.segment_index}`,
          seg,
        });
      }
    }
    return out;
  }, [useMulti, allChapters]);

  const currentFlatIndex = useMemo(() => {
    if (!useMulti) return currentIndex;
    const idx = flatItems.findIndex(
      (it) =>
        it.chapterIdx === currentChapterIdx &&
        it.absoluteIndex === currentAbsoluteIndex,
    );
    return idx >= 0 ? idx : 0;
  }, [useMulti, flatItems, currentChapterIdx, currentAbsoluteIndex, currentIndex]);

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

  // Initial scroll (instant). Runs once the first time the target item
  // ref is populated (in multi-chapter mode the list may not be
  // available on the first render because allChapters loads async).
  useEffect(() => {
    if (initialScrollDoneRef.current) return;
    const el = itemRefs.current.get(currentFlatIndex);
    if (!el) return;
    armProgrammaticGuard();
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    initialScrollDoneRef.current = true;
  }, [currentFlatIndex, armProgrammaticGuard]);

  // Scroll to current index when it changes from an external seek
  // (keyboard, scrubber, etc). Skips the first render — the initial
  // mount effect above owns it. After mount we use smooth for visual
  // continuity.
  useEffect(() => {
    if (!initialScrollDoneRef.current) return;
    const el = itemRefs.current.get(currentFlatIndex);
    if (el) {
      armProgrammaticGuard();
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [currentFlatIndex, armProgrammaticGuard]);

  // Detect which segment is closest to viewport center on user scroll.
  // rAF-throttled to one layout read per frame; calls onSeek directly
  // (no debounce) — positionStore.setPosition dedupes on equal values
  // so a stable scroll doesn't churn re-renders. The store is the
  // source of truth, so there's no need for an unmount flush.
  const rafPending = useRef(false);
  const rafHandleRef = useRef<number>(0);

  const totalCount = useMulti ? flatItems.length : segments.length;

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
      // Adaptive search: start near the current flat index, widen if
      // the best match is at the edge of the search window.
      let closestIdx = currentFlatIndex;
      let closestDist = Infinity;
      let radius = 15;
      for (let attempt = 0; attempt < 3; attempt++) {
        const lo = Math.max(0, closestIdx - radius);
        const hi = Math.min(totalCount - 1, closestIdx + radius);
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

      if (closestIdx !== currentFlatIndex) {
        if (useMulti) {
          const item = flatItems[closestIdx];
          if (item) onCrossChapterSeek!(item.chapterIdx, item.absoluteIndex);
        } else {
          onSeek(closestIdx);
        }
      }
    });
  }, [totalCount, currentFlatIndex, onSeek, useMulti, flatItems, onCrossChapterSeek]);

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

  if (useMulti) {
    // Multi-chapter: flat index across all chapters. We render each
    // chapter's items sequentially and insert a lightweight title
    // divider between chapters so the user can see where they are.
    let runningIdx = 0;
    return (
      <div
        ref={containerRef}
        className="focus-scroll"
        onScroll={handleScroll}
      >
        <div className="focus-scroll__spacer" />
        {allChapters!.map((ch, chPosition) => (
          <div key={`ch-${ch.chapterIdx}`} className="focus-scroll__chapter">
            {chPosition > 0 && (
              <div
                className="focus-scroll__chapter-title"
                aria-hidden="true"
              >
                {ch.title}
              </div>
            )}
            {ch.segments.map((seg) => {
              const flatIdx = runningIdx++;
              return (
                <div
                  key={`${ch.chapterIdx}:${seg.id}`}
                  ref={(el) => setItemRef(flatIdx, el)}
                  className={
                    flatIdx === currentFlatIndex
                      ? 'focus-scroll__item focus-scroll__item--current'
                      : 'focus-scroll__item'
                  }
                  onClick={() =>
                    onCrossChapterSeek!(ch.chapterIdx, seg.segment_index)
                  }
                >
                  <SegmentContent segment={seg} />
                </div>
              );
            })}
          </div>
        ))}
        <div className="focus-scroll__spacer" />
      </div>
    );
  }

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

function FocusChunkOverlayInner({
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
  allChapters,
  currentChapterIdx,
  currentAbsoluteIndex,
  onCrossChapterSeek,
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
  if (!isPlaying && segments && segments.length > 0 && currentIndex != null && onSeek) {
    return (
      <div className="focus-overlay" role="region" aria-label="Reading position">
        <PausedScrollView
          segments={segments}
          currentIndex={currentIndex}
          onSeek={onSeek}
          allChapters={allChapters}
          currentChapterIdx={currentChapterIdx}
          currentAbsoluteIndex={currentAbsoluteIndex}
          onCrossChapterSeek={onCrossChapterSeek}
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

// Memoized to stop the re-render cascade from ActiveReader. ActiveReader
// subscribes to several positionStore slices and re-renders on every
// segment-boundary commit (~every 1–2s during scroll/track playback); the
// overlay itself only needs to update when its own props actually change.
const FocusChunkOverlay = memo(FocusChunkOverlayInner);
export default FocusChunkOverlay;
