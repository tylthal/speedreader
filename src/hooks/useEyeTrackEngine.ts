import { useState, useRef, useCallback, useEffect } from 'react';
import type { Segment } from '../types';
import type { GazeDirection } from '../lib/gazeProcessor';
import { useVisibilityPause } from './useVisibilityPause';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface EyeTrackState {
  currentIndex: number;
  isPlaying: boolean;
  wpm: number;
  progress: number;
}

interface EyeTrackActions {
  play: () => void;
  pause: () => void;
  togglePlayPause: () => void;
  seekTo: (index: number) => void;
  setWpm: (wpm: number) => void;
  adjustWpm: (delta: number) => void;
}

interface UseEyeTrackEngineOptions {
  segments: Segment[];
  totalSegments: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  itemOffsetsRef: React.RefObject<Map<number, HTMLDivElement>>;
  gazeRef: React.RefObject<{ direction: GazeDirection; intensity: number }>;
  initialWpm?: number;
  onSegmentChange?: (index: number) => void;
  onComplete?: () => void;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MIN_WPM = 60;
const MAX_WPM = 1200;
const DEFAULT_WPM = 250;

/** Speed multiplier bounds */
const MIN_MULTIPLIER = -1.0; // reverse at full WPM speed
const MAX_MULTIPLIER = 2.5;  // 2.5x WPM

/**
 * When tilting up, intensity below this threshold = hold (speed 0).
 * Above this threshold = reverse scroll. Creates a "pause" band
 * between neutral and reverse for comfortable reading control.
 */
const HOLD_THRESHOLD = 0.4;

function clampWpm(value: number): number {
  return Math.max(MIN_WPM, Math.min(MAX_WPM, value));
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useEyeTrackEngine(
  options: UseEyeTrackEngineOptions,
): [EyeTrackState, EyeTrackActions] {
  const {
    segments,
    totalSegments,
    containerRef,
    itemOffsetsRef,
    gazeRef,
    initialWpm = DEFAULT_WPM,
    onSegmentChange,
    onComplete,
  } = options;

  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [wpm, setWpmState] = useState(() => clampWpm(initialWpm));

  const rafRef = useRef<number>(0);
  const lastTimestampRef = useRef(0);
  const speedMultiplierRef = useRef(1.0);
  const scrollPositionRef = useRef(0);    // high-precision scroll accumulator
  const savedScrollTopRef = useRef(0);   // preserves position across pause/resume
  const segCheckCounterRef = useRef(0);   // throttle segment detection
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

  // Cached average scroll speed (px/sec at 1 WPM)
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
      pxPerSecPerWpmRef.current = totalHeight / (totalWords * 60);
    }
  }, [itemOffsetsRef]);

  /* ---- rAF tick — tilt temporarily offsets from base WPM ---- */
  /*
   * Neutral = scroll at WPM base speed (1.0x multiplier).
   * Tilt down = temporarily speed up (up to 3x).
   * Tilt up = temporarily slow down / reverse (down to -0.5x).
   * Returning to neutral smoothly returns to base speed.
   */
  const tick = useCallback((timestamp: number) => {
    const container = containerRef.current;
    if (!container) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }

    if (pxPerSecPerWpmRef.current === 0) {
      computeAverageSpeed();
      scrollPositionRef.current = container.scrollTop;
    }

    if (lastTimestampRef.current > 0 && pxPerSecPerWpmRef.current > 0) {
      const dt = (timestamp - lastTimestampRef.current) / 1000;
      const gaze = gazeRef.current;

      // Compute target multiplier directly from gaze
      // neutral → 1.0x, down → up to 3x, up → down to -0.5x
      let targetMultiplier = 1.0;
      if (gaze.direction === 'down') {
        targetMultiplier = 1.0 + 1.5 * gaze.intensity; // 1x → 2.5x
      } else if (gaze.direction === 'up') {
        if (gaze.intensity <= HOLD_THRESHOLD) {
          // Hold zone: gentle tilt up = smoothly decelerate to stop
          const holdProgress = gaze.intensity / HOLD_THRESHOLD; // 0→1 within hold band
          targetMultiplier = 1.0 - holdProgress; // 1x → 0x (stopped)
        } else {
          // Reverse zone: beyond hold threshold = scroll backwards
          const reverseProgress = (gaze.intensity - HOLD_THRESHOLD) / (1 - HOLD_THRESHOLD);
          targetMultiplier = -1.0 * reverseProgress; // 0x → -1.0x
        }
      }
      targetMultiplier = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, targetMultiplier));

      // Smooth the multiplier at 60fps for fluid transitions.
      // τ=300ms: very gradual transitions, filters out micro-fluctuations.
      const lerpRate = 1 - Math.exp(-dt / 0.30);
      speedMultiplierRef.current += (targetMultiplier - speedMultiplierRef.current) * lerpRate;

      // Base speed from WPM
      const basePxPerSec = pxPerSecPerWpmRef.current * wpmRef.current;

      // Accumulate in high-precision float, snap to physical pixel grid
      scrollPositionRef.current += basePxPerSec * speedMultiplierRef.current * dt;
      scrollPositionRef.current = Math.max(0, scrollPositionRef.current);
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
    lastTimestampRef.current = timestamp;

    // Throttle segment detection to every 10 frames (~6 Hz)
    if (++segCheckCounterRef.current >= 10) {
      segCheckCounterRef.current = 0;
      updateCurrentIndexFromScroll();
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [containerRef, gazeRef, stopLoop, updateCurrentIndexFromScroll, computeAverageSpeed, dpr]);

  /* ---- Actions ---- */
  const play = useCallback(() => {
    if (segmentsRef.current.length === 0) return;
    setIsPlaying(true);
    lastTimestampRef.current = 0;
    speedMultiplierRef.current = 1.0;
    segCheckCounterRef.current = 0;

    // Wait for ScrollPlayingView to mount and do its initial scroll,
    // then sync our scroll position tracker and start the rAF loop.
    const savedPos = savedScrollTopRef.current;
    // Double-rAF: first for React render, second for ScrollPlayingView's mount effect
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const container = containerRef.current;
        if (container && savedPos > 0) {
          // Resume from pause — restore exact position
          container.scrollTop = savedPos;
        }
        // Sync our tracker to wherever the container actually is
        scrollPositionRef.current = container?.scrollTop ?? 0;
        rafRef.current = requestAnimationFrame(tick);
      });
    });
  }, [tick, containerRef]);

  const pause = useCallback(() => {
    // Save scroll position before pausing so resume can restore it
    savedScrollTopRef.current = containerRef.current?.scrollTop ?? scrollPositionRef.current;
    setIsPlaying(false);
    stopLoop();
  }, [stopLoop, containerRef]);

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
    savedScrollTopRef.current = 0; // reset so play() scrolls to the seeked segment
    onSegmentChangeRef.current?.(clamped);

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

  // Invalidate cached speed when segments change
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

  /* ---- Derived state ---- */
  const effectiveTotal = totalSegments > 0 ? totalSegments : segments.length;
  const absoluteIndex = segments[currentIndex]?.segment_index ?? currentIndex;
  const progress = effectiveTotal > 0 ? absoluteIndex / effectiveTotal : 0;

  const state: EyeTrackState = {
    currentIndex,
    isPlaying,
    wpm,
    progress,
  };

  const actions: EyeTrackActions = {
    play,
    pause,
    togglePlayPause,
    seekTo,
    setWpm,
    adjustWpm,
  };

  return [state, actions];
}
