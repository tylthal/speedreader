import { useState, useRef, useCallback, useEffect } from 'react';
import type { Segment } from '../types';
import { useVisibilityPause } from './useVisibilityPause';

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
    initialWpm = DEFAULT_WPM,
    onSegmentChange,
    onComplete,
  } = options;

  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [wpm, setWpmState] = useState(() => clampWpm(initialWpm));

  const rafRef = useRef<number>(0);
  const lastTimestampRef = useRef(0);

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

  /**
   * Determine which segment is closest to the vertical center of the
   * scroll container and update currentIndex if it changed.
   */
  const updateCurrentIndexFromScroll = useCallback(() => {
    const container = containerRef.current;
    const items = itemOffsetsRef.current;
    if (!container || !items || items.size === 0) return;

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

    // Compute average speed once on first tick (elements are rendered by then)
    if (pxPerSecPerWpmRef.current === 0) {
      computeAverageSpeed();
    }

    if (lastTimestampRef.current > 0 && pxPerSecPerWpmRef.current > 0) {
      const delta = timestamp - lastTimestampRef.current;
      const pxPerSec = pxPerSecPerWpmRef.current * wpmRef.current;
      const scrollDelta = pxPerSec * (delta / 1000);
      container.scrollTop += scrollDelta;

      // Check if we've hit the bottom
      const maxScroll = container.scrollHeight - container.clientHeight;
      if (container.scrollTop >= maxScroll - 1) {
        setIsPlaying(false);
        stopLoop();
        onCompleteRef.current?.();
        return;
      }
    }
    lastTimestampRef.current = timestamp;

    // Update which segment is centered
    updateCurrentIndexFromScroll();

    rafRef.current = requestAnimationFrame(tick);
  }, [containerRef, stopLoop, updateCurrentIndexFromScroll, computeAverageSpeed]);

  const play = useCallback(() => {
    if (segmentsRef.current.length === 0) return;
    setIsPlaying(true);
    lastTimestampRef.current = 0;
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

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
  }, [itemOffsetsRef]);

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
