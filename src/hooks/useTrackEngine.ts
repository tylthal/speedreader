import { useState, useRef, useCallback, useEffect } from 'react';
import type { Segment } from '../types';
import type { GazeDirection } from '../lib/gazeProcessor';
import { useVisibilityPause } from './useVisibilityPause';
import {
  createLookupCache,
  getPxPerWeight,
  type VelocityProfile,
} from '../lib/velocityProfile';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TrackState {
  currentIndex: number;
  isPlaying: boolean;
  wpm: number;
  progress: number;
}

interface TrackActions {
  play: () => void;
  pause: () => void;
  togglePlayPause: () => void;
  seekTo: (index: number) => void;
  setWpm: (wpm: number) => void;
  adjustWpm: (delta: number) => void;
}

interface UseTrackEngineOptions {
  segments: Segment[];
  totalSegments: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  itemOffsetsRef: React.RefObject<Map<number, HTMLDivElement>>;
  gazeRef: React.RefObject<{ direction: GazeDirection; intensity: number }>;
  /**
   * Optional per-element velocity profile. See useScrollEngine for the
   * full design notes — when present, the tick loop reads pxPerWeight
   * from the profile each frame and the gaze multiplier composes on top.
   * Reverse playback (negative multiplier) works naturally because
   * pxPerWeight is direction-agnostic.
   */
  velocityProfileRef?: React.RefObject<VelocityProfile | null>;
  /**
   * Optional cursor mapping callback. Same contract as useScrollEngine —
   * when supplied, the engine hands the parent the container-relative
   * scroll center each segment-detection tick and adopts the returned
   * array index. Used by the formatted-view path where there are no
   * per-segment DOM elements to walk.
   */
  onScrollTick?: (centerY: number) => number | null;
  initialWpm?: number;
  onSegmentChange?: (index: number) => void;
  /** Tick-only cursor publish; see useScrollEngine for the contract. */
  onCursorTick?: (arrayIdx: number) => void;
  onComplete?: () => void;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MIN_WPM = 60;
const MAX_WPM = 1200;
const DEFAULT_WPM = 250;

/** Speed multiplier bounds */
const MIN_MULTIPLIER = -0.6; // reverse at 60% WPM speed (gentler reverse)
const MAX_MULTIPLIER = 2.5;  // 2.5x WPM

/**
 * When tilting up, intensity below this threshold = hold (speed 0).
 * Above this threshold = reverse scroll. Creates a wide "pause" band
 * between neutral and reverse for comfortable reading control.
 */
const HOLD_THRESHOLD = 0.55;

/**
 * Grace period (ms) after pressing play during which gaze input is
 * ignored and scroll runs at base WPM. Gives the user time to settle
 * into reading position after tapping play (which often involves a
 * head tilt that would otherwise trigger reverse scrolling).
 */
const PLAY_GRACE_MS = 800;

function clampWpm(value: number): number {
  return Math.max(MIN_WPM, Math.min(MAX_WPM, value));
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useTrackEngine(
  options: UseTrackEngineOptions,
): [TrackState, TrackActions] {
  const {
    segments,
    totalSegments,
    containerRef,
    itemOffsetsRef,
    gazeRef,
    velocityProfileRef,
    onScrollTick,
    initialWpm = DEFAULT_WPM,
    onSegmentChange,
    onCursorTick,
    onComplete,
  } = options;

  // See useScrollEngine for the rationale behind these refs.
  const profileLookupCacheRef = useRef(createLookupCache());
  const lastProfileGenerationRef = useRef(-1);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [wpm, setWpmState] = useState(() => clampWpm(initialWpm));

  const rafRef = useRef<number>(0);
  const lastTimestampRef = useRef(0);
  const speedMultiplierRef = useRef(1.0);
  const scrollPositionRef = useRef(0);    // high-precision scroll accumulator
  const segCheckCounterRef = useRef(0);   // throttle segment detection
  const playStartTimeRef = useRef(0);     // timestamp when play started (for grace period)
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
  const onCursorTickRef = useRef(onCursorTick);
  onCursorTickRef.current = onCursorTick;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const stopLoop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  // Stable ref to onScrollTick so the rAF loop never captures a stale closure.
  const onScrollTickRef = useRef(onScrollTick);
  onScrollTickRef.current = onScrollTick;

  /**
   * Determine which segment is closest to the vertical center of the
   * scroll container and update currentIndex if it changed. See
   * useScrollEngine.updateCurrentIndexFromScroll for the two-path design.
   */
  const updateCurrentIndexFromScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (onScrollTickRef.current) {
      const centerY = container.scrollTop + container.clientHeight / 2;
      const newIdx = onScrollTickRef.current(centerY);
      if (newIdx != null && newIdx !== currentIndexRef.current) {
        setCurrentIndex(newIdx);
        currentIndexRef.current = newIdx;
        onSegmentChangeRef.current?.(newIdx);
        onCursorTickRef.current?.(newIdx);
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
      onCursorTickRef.current?.(closestIdx);
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

    // Pick velocity model — see useScrollEngine for the design.
    const profile = velocityProfileRef?.current ?? null;
    const useProfile = profile !== null && profile.entries.length > 0;
    if (useProfile && profile.generation !== lastProfileGenerationRef.current) {
      profileLookupCacheRef.current.lastIdx = 0;
      lastProfileGenerationRef.current = profile.generation;
    }

    if (!useProfile && pxPerSecPerWpmRef.current === 0) {
      computeAverageSpeed();
      scrollPositionRef.current = container.scrollTop;
    }

    const haveModel = useProfile || pxPerSecPerWpmRef.current > 0;
    if (lastTimestampRef.current > 0 && haveModel) {
      const dt = (timestamp - lastTimestampRef.current) / 1000;
      const gaze = gazeRef.current;

      // During grace period after play, ignore gaze and scroll at base speed.
      // This prevents accidental reverse from head movement while tapping play.
      const elapsed = Date.now() - playStartTimeRef.current;
      const inGracePeriod = elapsed < PLAY_GRACE_MS;

      // Compute target multiplier directly from gaze
      // neutral → 1.0x, down → up to 3x, up → down to -0.5x
      let targetMultiplier = 1.0;
      if (inGracePeriod) {
        // Stay at 1.0x during grace period
      } else if (gaze.direction === 'down') {
        targetMultiplier = 1.0 + 1.5 * gaze.intensity; // 1x → 2.5x
      } else if (gaze.direction === 'up') {
        if (gaze.intensity <= HOLD_THRESHOLD) {
          // Hold zone: gentle tilt up = smoothly decelerate to stop.
          // Wide hold band (55% of intensity range) so pausing is easy.
          const holdProgress = gaze.intensity / HOLD_THRESHOLD; // 0→1 within hold band
          targetMultiplier = 1.0 - holdProgress; // 1x → 0x (stopped)
        } else {
          // Reverse zone: beyond hold threshold = scroll backwards (gentle)
          const reverseProgress = (gaze.intensity - HOLD_THRESHOLD) / (1 - HOLD_THRESHOLD);
          targetMultiplier = MIN_MULTIPLIER * reverseProgress; // 0x → -0.6x
        }
      }
      targetMultiplier = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, targetMultiplier));

      // Smooth the multiplier at 60fps for fluid transitions.
      // Use a longer time constant when transitioning toward reverse
      // to prevent accidental backwards scrolling from brief tilts.
      const isDecelerating = targetMultiplier < speedMultiplierRef.current;
      const tau = isDecelerating ? 0.45 : 0.30; // 450ms to slow/reverse, 300ms to speed up
      const lerpRate = 1 - Math.exp(-dt / tau);
      speedMultiplierRef.current += (targetMultiplier - speedMultiplierRef.current) * lerpRate;

      // Base speed from WPM. With a velocity profile, the per-element
      // pxPerWeight varies across the page; without one, fall back to the
      // chapter-average constant. The gaze multiplier composes on top of
      // either model, so a 2.5× speed-up still means 2.5× regardless of
      // whether we're inside a code block or a paragraph.
      let basePxPerSec = 0;
      if (useProfile) {
        const centerY = container.scrollTop + container.clientHeight / 2;
        const pxPerWeight = getPxPerWeight(
          profile,
          centerY,
          profileLookupCacheRef.current,
        );
        if (pxPerWeight > 0) {
          basePxPerSec = pxPerWeight * (wpmRef.current / 60);
        }
      } else {
        basePxPerSec = pxPerSecPerWpmRef.current * wpmRef.current;
      }

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
  }, [containerRef, gazeRef, velocityProfileRef, stopLoop, updateCurrentIndexFromScroll, computeAverageSpeed, dpr]);

  /* ---- Actions ---- */
  const play = useCallback(() => {
    if (segmentsRef.current.length === 0) return;
    setIsPlaying(true);
    lastTimestampRef.current = 0;
    speedMultiplierRef.current = 1.0;
    segCheckCounterRef.current = 0;
    playStartTimeRef.current = Date.now();
    // Force re-sync on first tick: the tick loop will read container.scrollTop
    // when pxPerSecPerWpmRef is 0, ensuring scrollPositionRef matches the
    // actual DOM scroll position set by ScrollPlayingView's useLayoutEffect.
    pxPerSecPerWpmRef.current = 0;

    // Single rAF: ScrollPlayingView's useLayoutEffect scrolls synchronously
    // during React commit (before paint), so by the next animation frame
    // the container's scrollTop is already at the correct position.
    requestAnimationFrame(() => {
      scrollPositionRef.current = containerRef.current?.scrollTop ?? 0;
      rafRef.current = requestAnimationFrame(tick);
    });
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

    const items = itemOffsetsRef.current;
    if (items) {
      const el = items.get(clamped);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        // Sync the float accumulator so the rAF loop doesn't jump back
        // to the old scroll position on the next tick.
        const container = containerRef.current;
        if (container) {
          scrollPositionRef.current = container.scrollTop;
        }
      }
    }
  }, [itemOffsetsRef, containerRef]);

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

  const state: TrackState = {
    currentIndex,
    isPlaying,
    wpm,
    progress,
  };

  const actions: TrackActions = {
    play,
    pause,
    togglePlayPause,
    seekTo,
    setWpm,
    adjustWpm,
  };

  return [state, actions];
}
