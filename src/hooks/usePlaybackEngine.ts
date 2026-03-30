import { useState, useRef, useCallback, useEffect } from 'react';
import type { Segment } from '../types';
import { useVisibilityPause } from './useVisibilityPause';

interface PlaybackState {
  currentIndex: number;
  isPlaying: boolean;
  wpm: number;
  progress: number; // 0-1 progress through loaded segments
}

interface PlaybackActions {
  play: () => void;
  pause: () => void;
  togglePlayPause: () => void;
  seekTo: (index: number) => void;
  setWpm: (wpm: number) => void;
  adjustWpm: (delta: number) => void;
}

interface UsePlaybackEngineOptions {
  segments: Segment[];
  totalSegments: number;
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

export function usePlaybackEngine(
  options: UsePlaybackEngineOptions
): [PlaybackState, PlaybackActions] {
  const { segments, totalSegments, initialWpm = DEFAULT_WPM, onSegmentChange, onComplete } = options;

  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [wpm, setWpmState] = useState(() => clampWpm(initialWpm));

  const rafRef = useRef<number>(0);
  const elapsedRef = useRef(0);
  const lastTimestampRef = useRef(0);

  // Keep latest callbacks in refs to avoid stale closures in rAF loop
  const onSegmentChangeRef = useRef(onSegmentChange);
  onSegmentChangeRef.current = onSegmentChange;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Store current values in refs for the rAF loop
  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;
  const wpmRef = useRef(wpm);
  wpmRef.current = wpm;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const totalSegmentsRef = useRef(totalSegments);
  totalSegmentsRef.current = totalSegments;
  const waitingForSegmentsRef = useRef(false);

  const getSegmentDuration = useCallback((segment: Segment, currentWpm: number): number => {
    // duration_ms was calculated at 250 WPM. Scale proportionally.
    return segment.duration_ms * (DEFAULT_WPM / currentWpm);
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  const tick = useCallback((timestamp: number) => {
    const segs = segmentsRef.current;
    const idx = currentIndexRef.current;
    const total = totalSegmentsRef.current;

    if (idx >= segs.length) {
      // Out of loaded segments — check if more exist
      if (total > 0 && segs.length < total) {
        // More segments to come; pause and wait for prefetch
        waitingForSegmentsRef.current = true;
        setIsPlaying(false);
        stopLoop();
        return;
      }
      setIsPlaying(false);
      stopLoop();
      onCompleteRef.current?.();
      return;
    }

    if (lastTimestampRef.current > 0) {
      const delta = timestamp - lastTimestampRef.current;
      elapsedRef.current += delta;
    }
    lastTimestampRef.current = timestamp;

    const segment = segs[idx];
    const duration = getSegmentDuration(segment, wpmRef.current);

    if (elapsedRef.current >= duration) {
      const nextIndex = idx + 1;
      elapsedRef.current = 0;

      if (nextIndex >= segs.length) {
        if (total > 0 && segs.length < total) {
          // More segments to come; stay at current and wait
          waitingForSegmentsRef.current = true;
          setIsPlaying(false);
          stopLoop();
          // Trigger prefetch for upcoming segments
          onSegmentChangeRef.current?.(nextIndex);
          return;
        }
        setCurrentIndex(nextIndex - 1);
        setIsPlaying(false);
        stopLoop();
        onCompleteRef.current?.();
        return;
      }

      setCurrentIndex(nextIndex);
      currentIndexRef.current = nextIndex;
      onSegmentChangeRef.current?.(nextIndex);
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [getSegmentDuration, stopLoop]);

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
    elapsedRef.current = 0;
    lastTimestampRef.current = 0;
    // Clear waiting state — the user explicitly moved to a valid position
    waitingForSegmentsRef.current = false;
    onSegmentChangeRef.current?.(clamped);
  }, []);

  const setWpm = useCallback((value: number) => {
    setWpmState(clampWpm(value));
  }, []);

  const adjustWpm = useCallback((delta: number) => {
    setWpmState((prev) => clampWpm(prev + delta));
  }, []);

  // Auto-resume when new segments arrive after waiting for prefetch
  useEffect(() => {
    if (waitingForSegmentsRef.current && segments.length > currentIndexRef.current) {
      waitingForSegmentsRef.current = false;
      play();
    }
  }, [segments, play]);

  // Reset waiting state when segments are cleared (e.g. chapter change)
  useEffect(() => {
    if (segments.length === 0) {
      waitingForSegmentsRef.current = false;
    }
  }, [segments.length]);

  // Auto-pause on visibility change
  useVisibilityPause(isPlaying, pause, play);

  // Clean up rAF on unmount
  useEffect(() => {
    return () => {
      stopLoop();
    };
  }, [stopLoop]);

  const effectiveTotal = totalSegments > 0 ? totalSegments : segments.length;
  const progress = effectiveTotal > 0 ? currentIndex / effectiveTotal : 0;

  const state: PlaybackState = {
    currentIndex,
    isPlaying,
    wpm,
    progress,
  };

  const actions: PlaybackActions = {
    play,
    pause,
    togglePlayPause,
    seekTo,
    setWpm,
    adjustWpm,
  };

  return [state, actions];
}
