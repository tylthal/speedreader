import { useState, useRef, useCallback, useEffect } from 'react';
import type { Segment } from '../types';
import { useVisibilityPause } from './useVisibilityPause';
import {
  createLookupCache,
  getPxPerWeight,
  type VelocityProfile,
} from '../lib/velocityProfile';

interface ScrollState {
  currentIndex: number;
  isPlaying: boolean;
  wpm: number;
  progress: number;
}

interface ScrollActions {
  play: () => void;
  pause: () => void;
  togglePlayPause: () => void;
  seekTo: (index: number) => void;
  setWpm: (wpm: number) => void;
  adjustWpm: (delta: number) => void;
}

interface UseScrollEngineOptions {
  segments: Segment[];
  totalSegments: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  itemOffsetsRef: React.RefObject<Map<number, HTMLDivElement>>;
  /**
   * Optional per-element velocity profile. When present and non-empty, the
   * tick loop reads pxPerWeight from the profile at each scroll center
   * instead of using the constant `pxPerSecPerWpm` model. This is how the
   * formatted-view scroll mode varies speed across paragraphs / code blocks
   * / images. Focus-mode call sites omit this option and keep the original
   * behavior unchanged.
   */
  velocityProfileRef?: React.RefObject<VelocityProfile | null>;
  /**
   * Optional cursor mapping callback. When supplied, the engine calls this
   * each tick with the current scroll center; if it returns an array index
   * different from the engine's currentIndex, the engine adopts the new
   * index and fires onSegmentChange. This is how the formatted-view path
   * derives "which segment is the user looking at" from a scroll position
   * in a DOM that doesn't have per-segment elements. Focus-mode call sites
   * omit this and keep the existing item-rect-based mapping.
   */
  onScrollTick?: (centerY: number) => number | null;
  initialWpm?: number;
  onSegmentChange?: (index: number) => void;
  onComplete?: () => void;
}

const MIN_WPM = 60;
const MAX_WPM = 1200;
const DEFAULT_WPM = 250;

function clampWpm(value: number): number {
  return Math.max(MIN_WPM, Math.min(MAX_WPM, value));
}

export function useScrollEngine(
  options: UseScrollEngineOptions
): [ScrollState, ScrollActions] {
  const {
    segments,
    totalSegments,
    containerRef,
    itemOffsetsRef,
    velocityProfileRef,
    onScrollTick,
    initialWpm = DEFAULT_WPM,
    onSegmentChange,
    onComplete,
  } = options;

  // Adjacency cache for the velocity-profile lookup. One per engine instance
  // so consecutive ticks usually resolve in O(1). Reset when the profile
  // generation bumps so we don't carry a stale index across rebuilds.
  const profileLookupCacheRef = useRef(createLookupCache());
  const lastProfileGenerationRef = useRef(-1);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [wpm, setWpmState] = useState(() => clampWpm(initialWpm));

  const rafRef = useRef<number>(0);
  const lastTimestampRef = useRef(0);

  // High-precision float accumulator for the scroll position. We must NOT
  // do `container.scrollTop += scrollDelta` directly: browsers round
  // scrollTop to integer pixels (or to the device-pixel grid) on assignment,
  // and any per-frame delta below 1 px is silently dropped on the read-back.
  // For dense prose in formatted view, pxPerSec at typical wpm is in the
  // 10–30 range — that's 0.16–0.5 px/frame at 60fps, all sub-pixel. Without
  // an external accumulator the scroll appears to slow and freeze as soon
  // as it leaves a high-pxPerWeight entry (heading, image) and enters
  // normal prose. Mirrors the same fix already in useTrackEngine.
  const scrollPositionRef = useRef(0);
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;

  // Refs for rAF loop
  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;
  const wpmRef = useRef(wpm);
  wpmRef.current = wpm;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const totalSegmentsRef = useRef(totalSegments);
  totalSegmentsRef.current = totalSegments;
  const onSegmentChangeRef = useRef(onSegmentChange);
  onSegmentChangeRef.current = onSegmentChange;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const stopLoop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  // Stable ref to onScrollTick so the rAF loop doesn't capture a stale
  // closure when the parent re-renders.
  const onScrollTickRef = useRef(onScrollTick);
  onScrollTickRef.current = onScrollTick;

  /**
   * Determine which segment is closest to the vertical center of the
   * scroll container and update currentIndex if it changed.
   *
   * Two paths:
   *   - Formatted-view path (onScrollTick supplied): the parent owns the
   *     mapping from scroll position to segment index, since the formatted
   *     DOM doesn't have per-segment elements. We just hand the parent the
   *     scroll center in container-relative coordinates and let it return
   *     an array index.
   *   - Focus-view path (itemOffsetsRef populated): walk the segment item
   *     refs and pick the one whose center is nearest the viewport center.
   */
  const updateCurrentIndexFromScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (onScrollTickRef.current) {
      // Formatted-view path: container-relative scroll center.
      const centerY = container.scrollTop + container.clientHeight / 2;
      const newIdx = onScrollTickRef.current(centerY);
      if (newIdx != null && newIdx !== currentIndexRef.current) {
        setCurrentIndex(newIdx);
        currentIndexRef.current = newIdx;
        onSegmentChangeRef.current?.(newIdx);
      }
      return;
    }

    const items = itemOffsetsRef.current;
    if (!items || items.size === 0) return;

    const containerRect = container.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height / 2;

    let closestIdx = currentIndexRef.current;
    let closestDist = Infinity;

    items.forEach((el, idx) => {
      const rect = el.getBoundingClientRect();
      const itemCenter = rect.top + rect.height / 2;
      const dist = Math.abs(itemCenter - centerY);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = idx;
      }
    });

    if (closestIdx !== currentIndexRef.current) {
      setCurrentIndex(closestIdx);
      currentIndexRef.current = closestIdx;
      onSegmentChangeRef.current?.(closestIdx);
    }
  }, [containerRef, itemOffsetsRef]);

  // Cached average scroll speed (px/sec at 1 WPM) — recomputed when segments change
  const pxPerSecPerWpmRef = useRef(0);

  const computeAverageSpeed = useCallback(() => {
    const items = itemOffsetsRef.current;
    const segs = segmentsRef.current;
    if (!items || items.size === 0 || segs.length === 0) return;

    let totalWords = 0;
    let totalHeight = 0;
    for (let i = 0; i < segs.length; i++) {
      const el = items.get(i);
      if (el) {
        totalWords += segs[i].word_count || segs[i].text.split(/\s+/).length;
        totalHeight += el.getBoundingClientRect().height;
      }
    }

    if (totalWords > 0 && totalHeight > 0) {
      // At 1 WPM the whole chapter takes totalWords minutes = totalWords * 60 seconds
      // Speed = totalHeight / (totalWords * 60) px/sec/wpm
      pxPerSecPerWpmRef.current = totalHeight / (totalWords * 60);
    }
  }, [itemOffsetsRef]);

  const tick = useCallback((timestamp: number) => {
    const container = containerRef.current;
    if (!container) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }

    // Pick a velocity model:
    //   - Profile present and non-empty → per-element pxPerWeight (formatted view)
    //   - Otherwise → constant pxPerSecPerWpm averaged across the chapter (focus view)
    // The profile is read from a ref so rebuilds picked up between frames
    // require zero React renders. We reset the lookup adjacency cache when
    // the profile generation bumps so a stale lastIdx can't outlive a rebuild.
    const profile = velocityProfileRef?.current ?? null;
    const useProfile = profile !== null && profile.entries.length > 0;
    if (useProfile && profile.generation !== lastProfileGenerationRef.current) {
      profileLookupCacheRef.current.lastIdx = 0;
      lastProfileGenerationRef.current = profile.generation;
    }

    // Constant-model first-tick warmup is only meaningful when we're NOT
    // using a profile.
    if (!useProfile && pxPerSecPerWpmRef.current === 0) {
      computeAverageSpeed();
    }

    if (lastTimestampRef.current > 0) {
      const delta = timestamp - lastTimestampRef.current;
      let pxPerSec = 0;
      if (useProfile) {
        const centerY = container.scrollTop + container.clientHeight / 2;
        const pxPerWeight = getPxPerWeight(
          profile,
          centerY,
          profileLookupCacheRef.current,
        );
        if (pxPerWeight > 0) {
          pxPerSec = pxPerWeight * (wpmRef.current / 60);
        }
      } else if (pxPerSecPerWpmRef.current > 0) {
        pxPerSec = pxPerSecPerWpmRef.current * wpmRef.current;
      }

      if (pxPerSec > 0) {
        // Accumulate the delta into the float scrollPositionRef instead of
        // hitting container.scrollTop directly. The browser quantizes
        // scrollTop on assignment, so direct +=  loses any sub-pixel
        // remainder every frame and the scroll stalls at low pxPerSec.
        // The float ref preserves the remainder across frames; we snap to
        // the device-pixel grid only when writing to the DOM.
        scrollPositionRef.current += pxPerSec * (delta / 1000);
        if (scrollPositionRef.current < 0) scrollPositionRef.current = 0;
        container.scrollTop = Math.floor(scrollPositionRef.current * dpr) / dpr;

        // Check if we've hit the bottom
        const maxScroll = container.scrollHeight - container.clientHeight;
        if (container.scrollTop >= maxScroll - 1) {
          setIsPlaying(false);
          stopLoop();
          onCompleteRef.current?.();
          return;
        }
      }
    }
    lastTimestampRef.current = timestamp;

    // Update which segment is centered
    updateCurrentIndexFromScroll();

    rafRef.current = requestAnimationFrame(tick);
  }, [containerRef, velocityProfileRef, stopLoop, updateCurrentIndexFromScroll, computeAverageSpeed, dpr]);

  const play = useCallback(() => {
    if (segmentsRef.current.length === 0) return;
    setIsPlaying(true);
    lastTimestampRef.current = 0;
    // Sync the float accumulator to wherever the container actually is
    // right now. Without this the next tick would write 0 + delta and yank
    // the user's scroll position back to the top.
    scrollPositionRef.current = containerRef.current?.scrollTop ?? 0;
    rafRef.current = requestAnimationFrame(tick);
  }, [tick, containerRef]);

  const pause = useCallback(() => {
    setIsPlaying(false);
    stopLoop();
  }, [stopLoop]);

  const togglePlayPause = useCallback(() => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  }, [isPlaying, play, pause]);

  const seekTo = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(index, segmentsRef.current.length - 1));
    setCurrentIndex(clamped);
    currentIndexRef.current = clamped;
    lastTimestampRef.current = 0;
    onSegmentChangeRef.current?.(clamped);

    // Scroll the container to center this segment
    const items = itemOffsetsRef.current;
    if (items) {
      const el = items.get(clamped);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
    }
    // Re-sync the float accumulator after the seek so the next tick doesn't
    // jump back to the pre-seek position.
    if (containerRef.current) {
      scrollPositionRef.current = containerRef.current.scrollTop;
    }
  }, [itemOffsetsRef, containerRef]);

  const setWpm = useCallback((value: number) => {
    setWpmState(clampWpm(value));
  }, []);

  const adjustWpm = useCallback((delta: number) => {
    setWpmState((prev) => clampWpm(prev + delta));
  }, []);

  // Invalidate cached speed when segments change (new chapter, etc.)
  useEffect(() => {
    pxPerSecPerWpmRef.current = 0;
  }, [segments]);

  // Auto-pause on visibility change
  useVisibilityPause(isPlaying, pause, play);

  // Clean up rAF on unmount
  useEffect(() => {
    return () => {
      stopLoop();
    };
  }, [stopLoop]);

  const effectiveTotal = totalSegments > 0 ? totalSegments : segments.length;
  const absoluteIndex = segments[currentIndex]?.segment_index ?? currentIndex;
  const progress = effectiveTotal > 0 ? absoluteIndex / effectiveTotal : 0;

  const state: ScrollState = {
    currentIndex,
    isPlaying,
    wpm,
    progress,
  };

  const actions: ScrollActions = {
    play,
    pause,
    togglePlayPause,
    seekTo,
    setWpm,
    adjustWpm,
  };

  return [state, actions];
}
