import { useState, useRef, useCallback, useEffect } from 'react';
import type { Segment } from '../types';
import { getSegments } from '../api/client';

interface UseSegmentLoaderOptions {
  publicationId: number;
  chapterId: number;
  batchSize?: number; // default 50
  prefetchThreshold?: number; // segments remaining before prefetch, default 20
  dataSaver?: boolean; // reduce prefetch aggressiveness
  initialSegmentIndex?: number; // start loading from this segment
}

interface SegmentLoaderState {
  segments: Segment[];
  isLoading: boolean;
  error: string | null;
  totalSegments: number;
  loadedRange: { start: number; end: number };
}

interface SegmentLoaderActions {
  checkPrefetch: (index: number) => void;
  loadBackward: () => void;
  reload: () => void;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_PREFETCH_THRESHOLD = 20;
const DATA_SAVER_BATCH_SIZE = 20;
const DATA_SAVER_PREFETCH_THRESHOLD = 5;

export function useSegmentLoader(
  options: UseSegmentLoaderOptions
): [SegmentLoaderState, SegmentLoaderActions] {
  const {
    publicationId,
    chapterId,
    dataSaver = false,
    batchSize = dataSaver ? DATA_SAVER_BATCH_SIZE : DEFAULT_BATCH_SIZE,
    prefetchThreshold = dataSaver ? DATA_SAVER_PREFETCH_THRESHOLD : DEFAULT_PREFETCH_THRESHOLD,
    initialSegmentIndex = 0,
  } = options;

  const [segments, setSegments] = useState<Segment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalSegments, setTotalSegments] = useState(0);
  const [loadedRange, setLoadedRange] = useState<{ start: number; end: number }>({
    start: 0,
    end: 0,
  });

  const fetchingRef = useRef(false);
  const pendingPrefetchRef = useRef<{ start: number; end: number } | null>(null);
  const loadedRangeRef = useRef(loadedRange);
  loadedRangeRef.current = loadedRange;
  const totalSegmentsRef = useRef(totalSegments);
  totalSegmentsRef.current = totalSegments;

  const fetchBatch = useCallback(
    async (start: number, end: number, append: boolean) => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      setIsLoading(true);
      setError(null);

      try {
        const batch = await getSegments(publicationId, chapterId, start, end);
        setTotalSegments(batch.total_segments);
        totalSegmentsRef.current = batch.total_segments;

        setSegments((prev) => {
          if (!append) return batch.segments;

          // Merge and deduplicate by segment_index
          const existing = new Map(prev.map((s) => [s.segment_index, s]));
          for (const seg of batch.segments) {
            existing.set(seg.segment_index, seg);
          }
          // Sort by segment_index to maintain order
          return Array.from(existing.values()).sort(
            (a, b) => a.segment_index - b.segment_index
          );
        });

        // Use the actual end of returned data, not the requested end.
        // Near the end of a chapter the API may return fewer segments than
        // requested; using the requested `end` would overshoot and prevent
        // further prefetch from being triggered.
        const actualEnd = batch.segments.length > 0
          ? Math.max(...batch.segments.map((s) => s.segment_index)) + 1
          : end;
        const newEnd = Math.max(loadedRangeRef.current.end, actualEnd);
        const newStart = append ? Math.min(loadedRangeRef.current.start, start) : start;
        setLoadedRange({ start: newStart, end: newEnd });
        loadedRangeRef.current = { start: newStart, end: newEnd };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load segments';
        setError(message);
      } finally {
        fetchingRef.current = false;
        setIsLoading(false);

        // If a prefetch was requested while we were fetching, flush it now
        const pending = pendingPrefetchRef.current;
        if (pending) {
          pendingPrefetchRef.current = null;
          // Re-check: skip if the completed fetch already covered this range
          const range = loadedRangeRef.current;
          if (pending.start >= range.start && pending.end <= range.end) {
            // Already covered — no fetch needed
          } else {
            // Clamp to avoid re-fetching already-loaded portions
            const clampedStart = Math.max(pending.start, range.end);
            if (clampedStart < pending.end) {
              fetchBatch(clampedStart, pending.end, true);
            }
          }
        }
      }
    },
    [publicationId, chapterId]
  );

  // Initial load when chapterId changes
  const initialFetchedRef = useRef(false);
  useEffect(() => {
    setSegments([]);
    setLoadedRange({ start: 0, end: 0 });
    loadedRangeRef.current = { start: 0, end: 0 };
    setTotalSegments(0);
    totalSegmentsRef.current = 0;
    setError(null);
    pendingPrefetchRef.current = null;

    // Load the entire chapter from the start. Chapters are small enough
    // (avg ~500 segments, max ~1600) that loading everything up front is
    // simpler and avoids complex prefetch/scroll-preservation logic.
    initialFetchedRef.current = true;
    fetchBatch(0, 999999, false);
  }, [chapterId, batchSize, fetchBatch, initialSegmentIndex]);

  const checkPrefetch = useCallback(
    (currentIndex: number) => {
      const range = loadedRangeRef.current;
      const total = totalSegmentsRef.current;

      // Convert array index to absolute segment position so the comparison
      // against range.end (an absolute position) is correct even when
      // segments were loaded starting from a non-zero offset.
      const segmentPosition = range.start + currentIndex;

      // Forward prefetch: approaching the end of loaded segments
      if (
        segmentPosition + prefetchThreshold >= range.end &&
        range.end < total
      ) {
        const nextStart = range.end;
        const nextEnd = Math.min(range.end + batchSize, total);
        if (fetchingRef.current) {
          pendingPrefetchRef.current = { start: nextStart, end: nextEnd };
        } else {
          fetchBatch(nextStart, nextEnd, true);
        }
        return;
      }

      // Backward prefetch: approaching the start of loaded segments
      // (e.g. user resumed mid-chapter and scrolled back).
      // Only trigger when actually moving backward (currentIndex > 0),
      // not on the initial position which is already at the right spot.
      if (
        currentIndex > 0 &&
        range.start > 0 &&
        segmentPosition - prefetchThreshold <= range.start
      ) {
        const prevEnd = range.start;
        const prevStart = Math.max(0, range.start - batchSize);
        if (fetchingRef.current) {
          pendingPrefetchRef.current = { start: prevStart, end: prevEnd };
        } else {
          fetchBatch(prevStart, prevEnd, true);
        }
      }
    },
    [batchSize, prefetchThreshold, fetchBatch]
  );

  const loadBackward = useCallback(() => {
    const range = loadedRangeRef.current;
    if (range.start <= 0) return;
    const prevEnd = range.start;
    const prevStart = Math.max(0, range.start - batchSize);
    if (fetchingRef.current) {
      pendingPrefetchRef.current = { start: prevStart, end: prevEnd };
    } else {
      fetchBatch(prevStart, prevEnd, true);
    }
  }, [batchSize, fetchBatch]);

  const reload = useCallback(() => {
    setSegments([]);
    setLoadedRange({ start: 0, end: 0 });
    loadedRangeRef.current = { start: 0, end: 0 };
    setError(null);
    pendingPrefetchRef.current = null;
    fetchBatch(0, batchSize, false);
  }, [batchSize, fetchBatch]);

  const state: SegmentLoaderState = {
    segments,
    isLoading,
    error,
    totalSegments,
    loadedRange,
  };

  return [state, { checkPrefetch, loadBackward, reload }];
}
