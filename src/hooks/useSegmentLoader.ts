import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
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
  /**
   * Resolve when the loaded window covers the given absolute segment
   * index. Used by RestoreCoordinator to gate the pending → applied
   * transition until the saved target segment actually lives in the
   * loaded array. Today the loader fetches the entire chapter on the
   * first batch, so this resolves on the very next render in practice;
   * the contract is here so RestoreCoordinator stays right when we
   * eventually cap chapter prefetch.
   */
  ensureWindowFor: (absoluteIdx: number) => Promise<void>;
}

/**
 * Coordinate-system translators. Engines and consumers work in the
 * canonical absolute segment_index space (matches the column on the
 * segments table); the loader exposes a partial array. These helpers
 * are how everyone crosses the boundary without each engine carrying
 * its own trackedSegmentIndexRef.
 *
 * Both directions are stable across array shifts caused by backward
 * prefetch — `arrayToAbsolute` reads segment_index from the segment
 * row, and `absoluteToArrayIndex` searches the current array.
 */
export interface SegmentLoaderTranslators {
  arrayToAbsolute: (arrayIdx: number) => number | null;
  absoluteToArrayIndex: (absoluteIdx: number) => number | null;
  hasAbsoluteIndex: (absoluteIdx: number) => boolean;
  loadedAbsoluteRange: () => { start: number; end: number };
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_PREFETCH_THRESHOLD = 20;
const DATA_SAVER_BATCH_SIZE = 20;
const DATA_SAVER_PREFETCH_THRESHOLD = 5;

export function useSegmentLoader(
  options: UseSegmentLoaderOptions
): [SegmentLoaderState, SegmentLoaderActions, SegmentLoaderTranslators] {
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
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  // Pending ensureWindowFor() resolvers — one per outstanding caller.
  // The fetch loop checks this set after every successful batch and
  // resolves callers whose target index is now covered.
  type PendingEnsure = {
    abs: number;
    resolve: () => void;
    reject: (err: Error) => void;
  };
  const pendingEnsureRef = useRef<PendingEnsure[]>([]);

  const flushEnsurers = useCallback(() => {
    if (pendingEnsureRef.current.length === 0) return;
    const segs = segmentsRef.current;
    const total = totalSegmentsRef.current;
    const loaded = loadedRangeRef.current;
    const stillPending: PendingEnsure[] = [];
    for (const p of pendingEnsureRef.current) {
      // Covered by the current array?
      const found = segs.some((s) => s.segment_index === p.abs);
      if (found) {
        p.resolve();
        continue;
      }
      // Past end of chapter (saved index out of bounds) — also resolve;
      // the engine will clamp on its own.
      if (total > 0 && p.abs >= total) {
        p.resolve();
        continue;
      }
      // No more segments coming for this range and we never landed on it.
      if (loaded.end >= total && total > 0) {
        p.reject(new Error('absolute index not in loaded chapter'));
        continue;
      }
      stillPending.push(p);
    }
    pendingEnsureRef.current = stillPending;
  }, []);

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
          let next: Segment[];
          if (!append) {
            next = batch.segments;
          } else {
            // Merge and deduplicate by segment_index
            const existing = new Map(prev.map((s) => [s.segment_index, s]));
            for (const seg of batch.segments) {
              existing.set(seg.segment_index, seg);
            }
            // Sort by segment_index to maintain order
            next = Array.from(existing.values()).sort(
              (a, b) => a.segment_index - b.segment_index
            );
          }
          segmentsRef.current = next;
          return next;
        });

        // Use the actual end of returned data, not the requested end.
        const actualEnd = batch.segments.length > 0
          ? Math.max(...batch.segments.map((s) => s.segment_index)) + 1
          : end;
        const newEnd = Math.max(loadedRangeRef.current.end, actualEnd);
        const newStart = append ? Math.min(loadedRangeRef.current.start, start) : start;
        setLoadedRange({ start: newStart, end: newEnd });
        loadedRangeRef.current = { start: newStart, end: newEnd };

        // Resolve any ensureWindowFor() callers whose target is now in.
        flushEnsurers();
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
    [publicationId, chapterId, flushEnsurers]
  );

  // Initial load when chapterId changes
  const initialFetchedRef = useRef(false);
  useEffect(() => {
    setSegments([]);
    segmentsRef.current = [];
    setLoadedRange({ start: 0, end: 0 });
    loadedRangeRef.current = { start: 0, end: 0 };
    setTotalSegments(0);
    totalSegmentsRef.current = 0;
    setError(null);
    pendingPrefetchRef.current = null;

    // Reject any in-flight ensurers from the previous chapter — their
    // absolute index is meaningless in the new chapter's coordinate space.
    for (const p of pendingEnsureRef.current) {
      p.reject(new Error('chapter changed before window could be ensured'));
    }
    pendingEnsureRef.current = [];

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
    segmentsRef.current = [];
    setLoadedRange({ start: 0, end: 0 });
    loadedRangeRef.current = { start: 0, end: 0 };
    setError(null);
    pendingPrefetchRef.current = null;
    fetchBatch(0, batchSize, false);
  }, [batchSize, fetchBatch]);

  const ensureWindowFor = useCallback(
    (absoluteIdx: number): Promise<void> => {
      const segs = segmentsRef.current;
      // Already covered?
      if (segs.some((s) => s.segment_index === absoluteIdx)) {
        return Promise.resolve();
      }
      const total = totalSegmentsRef.current;
      if (total > 0 && absoluteIdx >= total) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        pendingEnsureRef.current.push({ abs: absoluteIdx, resolve, reject });
        // If we're not currently fetching and the target is outside the
        // loaded range, trigger a forward batch toward it. The default
        // initial fetch already covers the entire chapter so this branch
        // is mostly future-proofing.
        const range = loadedRangeRef.current;
        if (
          !fetchingRef.current &&
          absoluteIdx >= range.end &&
          (total === 0 || absoluteIdx < total)
        ) {
          const start = range.end;
          const end = Math.min(absoluteIdx + batchSize, total > 0 ? total : 999999);
          fetchBatch(start, end, true);
        }
      });
    },
    [batchSize, fetchBatch]
  );

  // Translators. Wrapped in a memo so the object reference is stable
  // across renders that don't change segments — engines and effects
  // depend on it via useEffect/useMemo deps.
  const translators = useMemo<SegmentLoaderTranslators>(() => {
    return {
      arrayToAbsolute: (arrayIdx: number) => {
        const segs = segmentsRef.current;
        if (arrayIdx < 0 || arrayIdx >= segs.length) return null;
        return segs[arrayIdx].segment_index;
      },
      absoluteToArrayIndex: (absoluteIdx: number) => {
        const segs = segmentsRef.current;
        if (segs.length === 0) return null;
        // Binary search by segment_index — segments[] is kept sorted by
        // segment_index on insert (see fetchBatch merge path).
        let lo = 0;
        let hi = segs.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const v = segs[mid].segment_index;
          if (v === absoluteIdx) return mid;
          if (v < absoluteIdx) lo = mid + 1;
          else hi = mid - 1;
        }
        return null;
      },
      hasAbsoluteIndex: (absoluteIdx: number) => {
        const segs = segmentsRef.current;
        if (segs.length === 0) return false;
        // Same binary search as above; reuse via inline copy to avoid
        // an extra function call hop.
        let lo = 0;
        let hi = segs.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const v = segs[mid].segment_index;
          if (v === absoluteIdx) return true;
          if (v < absoluteIdx) lo = mid + 1;
          else hi = mid - 1;
        }
        return false;
      },
      loadedAbsoluteRange: () => ({ ...loadedRangeRef.current }),
    };
    // Re-emit when segments[] changes so consumers that read translators
    // inside an effect dep array re-run correctly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments]);

  const state: SegmentLoaderState = {
    segments,
    isLoading,
    error,
    totalSegments,
    loadedRange,
  };

  return [
    state,
    { checkPrefetch, loadBackward, reload, ensureWindowFor },
    translators,
  ];
}
