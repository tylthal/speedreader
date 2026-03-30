import { useState, useRef, useCallback, useEffect } from 'react';
import type { Segment } from '../types';
import { useVisibilityPause } from './useVisibilityPause';

interface RsvpState {
  currentWord: string;
  orpIndex: number;
  currentSegmentIndex: number;
  currentWordIndex: number;
  isPlaying: boolean;
  wpm: number;
  progress: number;
}

interface RsvpActions {
  play: () => void;
  pause: () => void;
  togglePlayPause: () => void;
  setWpm: (wpm: number) => void;
  adjustWpm: (delta: number) => void;
  seekToSegment: (index: number) => void;
}

interface UseRsvpEngineOptions {
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

function computeOrpIndex(word: string): number {
  const len = word.length;
  if (len <= 3) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  return 3;
}

function getWordsFromSegment(segment: Segment): string[] {
  return segment.text.split(/\s+/).filter((w) => w.length > 0);
}

function getWordDuration(word: string, wpm: number): number {
  let duration = (1 / wpm) * 60000;

  // Longer words: add 20% more time
  if (word.length > 8) {
    duration *= 1.2;
  }

  // Punctuation pauses
  const lastChar = word[word.length - 1];
  if (lastChar === '.' || lastChar === '!' || lastChar === '?') {
    duration += 150;
  } else if (lastChar === ',' || lastChar === ';' || lastChar === ':') {
    duration += 80;
  }

  return duration;
}

export function useRsvpEngine(
  options: UseRsvpEngineOptions
): [RsvpState, RsvpActions] {
  const { segments, totalSegments, initialWpm = DEFAULT_WPM, onSegmentChange, onComplete } = options;

  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(0);
  const [currentWordIndex, setCurrentWordIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [wpm, setWpmState] = useState(() => clampWpm(initialWpm));

  const rafRef = useRef<number>(0);
  const elapsedRef = useRef(0);
  const lastTimestampRef = useRef(0);

  // Refs for rAF loop
  const currentSegmentIndexRef = useRef(currentSegmentIndex);
  currentSegmentIndexRef.current = currentSegmentIndex;
  const currentWordIndexRef = useRef(currentWordIndex);
  currentWordIndexRef.current = currentWordIndex;
  const wpmRef = useRef(wpm);
  wpmRef.current = wpm;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const totalSegmentsRef = useRef(totalSegments);
  totalSegmentsRef.current = totalSegments;
  const waitingForSegmentsRef = useRef(false);
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

  const tick = useCallback((timestamp: number) => {
    const segs = segmentsRef.current;
    const segIdx = currentSegmentIndexRef.current;
    const wordIdx = currentWordIndexRef.current;
    const total = totalSegmentsRef.current;

    if (segIdx >= segs.length) {
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

    const words = getWordsFromSegment(segs[segIdx]);
    const currentWord = words[wordIdx] ?? '';
    const duration = getWordDuration(currentWord, wpmRef.current);

    if (elapsedRef.current >= duration) {
      elapsedRef.current = 0;
      const nextWordIdx = wordIdx + 1;

      if (nextWordIdx >= words.length) {
        // Move to next segment
        const nextSegIdx = segIdx + 1;
        if (nextSegIdx >= segs.length) {
          if (total > 0 && segs.length < total) {
            // More segments to come; stay at current and wait
            waitingForSegmentsRef.current = true;
            setIsPlaying(false);
            stopLoop();
            // Trigger prefetch for upcoming segments
            onSegmentChangeRef.current?.(nextSegIdx);
            return;
          }
          setIsPlaying(false);
          stopLoop();
          onCompleteRef.current?.();
          return;
        }
        setCurrentSegmentIndex(nextSegIdx);
        currentSegmentIndexRef.current = nextSegIdx;
        setCurrentWordIndex(0);
        currentWordIndexRef.current = 0;
        onSegmentChangeRef.current?.(nextSegIdx);
      } else {
        setCurrentWordIndex(nextWordIdx);
        currentWordIndexRef.current = nextWordIdx;
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [stopLoop]);

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

  const seekToSegment = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(index, segmentsRef.current.length - 1));
    setCurrentSegmentIndex(clamped);
    currentSegmentIndexRef.current = clamped;
    setCurrentWordIndex(0);
    currentWordIndexRef.current = 0;
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
    if (waitingForSegmentsRef.current && segments.length > currentSegmentIndexRef.current) {
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

  // Derive current word and ORP
  const currentSegment = segments[currentSegmentIndex];
  const words = currentSegment ? getWordsFromSegment(currentSegment) : [];
  const currentWord = words[currentWordIndex] ?? '';
  const orpIndex = computeOrpIndex(currentWord);

  // Compute progress using totalSegments for a stable denominator.
  // We use segment-based progress (not word-based) to avoid jumps as new batches load.
  const effectiveTotal = totalSegments > 0 ? totalSegments : segments.length;
  const progress = effectiveTotal > 0 ? currentSegmentIndex / effectiveTotal : 0;

  const state: RsvpState = {
    currentWord,
    orpIndex,
    currentSegmentIndex,
    currentWordIndex,
    isPlaying,
    wpm,
    progress,
  };

  const actions: RsvpActions = {
    play,
    pause,
    togglePlayPause,
    setWpm,
    adjustWpm,
    seekToSegment,
  };

  return [state, actions];
}
