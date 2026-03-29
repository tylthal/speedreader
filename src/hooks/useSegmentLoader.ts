import { useState, useRef, useCallback, useEffect } from 'react';
import type { Segment } from '../types';
import { getSegments } from '../api/client';

interface UseSegmentLoaderOptions {
  publicationId: number;
  chapterId: number;
  batchSize?: number; // default 50
  prefetchThreshold?: number; // segments remaining before prefetch, default 20
  dataSaver?: boolean; // reduce prefetch aggressiveness
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

        const newEnd = Math.max(loadedRangeRef.current.end, end);
        const newStart = append ? loadedRangeRef.current.start : start;
        setLoadedRange({ start: newStart, end: newEnd });
        loadedRangeRef.current = { start: newStart, end: newEnd };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load segments';
        setError(message);
      } finally {
        fetchingRef.current = false;
        setIsLoading(false);
      }
    },
    [publicationId, chapterId]
  );

  // Initial load when chapterId changes
  useEffect(() => {
    setSegments([]);
    setLoadedRange({ start: 0, end: 0 });
    loadedRangeRef.current = { start: 0, end: 0 };
    setTotalSegments(0);
    totalSegmentsRef.current = 0;
    setError(null);
    fetchBatch(0, batchSize, false);
  }, [chapterId, batchSize, fetchBatch]);

  const checkPrefetch = useCallback(
    (currentIndex: number) => {
      const range = loadedRangeRef.current;
      const total = totalSegmentsRef.current;

      if (
        currentIndex + prefetchThreshold >= range.end &&
        range.end < total &&
        !fetchingRef.current
      ) {
        const nextStart = range.end;
        const nextEnd = Math.min(range.end + batchSize, total);
        fetchBatch(nextStart, nextEnd, true);
      }
    },
    [batchSize, prefetchThreshold, fetchBatch]
  );

  const reload = useCallback(() => {
    setSegments([]);
    setLoadedRange({ start: 0, end: 0 });
    loadedRangeRef.current = { start: 0, end: 0 };
    setError(null);
    fetchBatch(0, batchSize, false);
  }, [batchSize, fetchBatch]);

  const state: SegmentLoaderState = {
    segments,
    isLoading,
    error,
    totalSegments,
    loadedRange,
  };

  return [state, { checkPrefetch, reload }];
}
