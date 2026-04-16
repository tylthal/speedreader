import { useState, useEffect, useMemo } from 'react';
import type { Segment } from '../types';
import { getSegments } from '../db/localClient';

interface UseSegmentLoaderOptions {
  publicationId: number;
  chapterId: number;
}

interface SegmentLoaderState {
  segments: Segment[];
  isLoading: boolean;
  error: string | null;
  totalSegments: number;
}

/**
 * Coordinate-system translators. The reader cursor uses absolute
 * chapter segment indices and the loaded array exposes the same
 * coordinate space directly because the loader now fetches a whole
 * chapter at once.
 */
export interface SegmentLoaderTranslators {
  arrayToAbsolute: (arrayIdx: number) => number | null;
  absoluteToArrayIndex: (absoluteIdx: number) => number | null;
  hasAbsoluteIndex: (absoluteIdx: number) => boolean;
  loadedAbsoluteRange: () => { start: number; end: number };
}

function findSegmentIndex(
  segments: ReadonlyArray<Segment>,
  absoluteIdx: number,
): number | null {
  if (segments.length === 0) return null;

  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = segments[mid].segment_index;
    if (value === absoluteIdx) return mid;
    if (value < absoluteIdx) lo = mid + 1;
    else hi = mid - 1;
  }

  return null;
}

export function useSegmentLoader(
  options: UseSegmentLoaderOptions
): [SegmentLoaderState, SegmentLoaderTranslators] {
  const { publicationId, chapterId } = options;

  const [segments, setSegments] = useState<Segment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalSegments, setTotalSegments] = useState(0);

  useEffect(() => {
    let cancelled = false;

    setSegments([]);
    setTotalSegments(0);
    setError(null);
    setIsLoading(true);

    getSegments(publicationId, chapterId, 0, 999999)
      .then((batch) => {
        if (cancelled) return;
        setSegments(batch.segments);
        setTotalSegments(batch.total_segments);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load segments');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [publicationId, chapterId]);

  const translators = useMemo<SegmentLoaderTranslators>(() => {
    return {
      arrayToAbsolute: (arrayIdx: number) => {
        if (arrayIdx < 0 || arrayIdx >= segments.length) return null;
        return segments[arrayIdx].segment_index;
      },
      absoluteToArrayIndex: (absoluteIdx: number) =>
        findSegmentIndex(segments, absoluteIdx),
      hasAbsoluteIndex: (absoluteIdx: number) =>
        findSegmentIndex(segments, absoluteIdx) != null,
      loadedAbsoluteRange: () => {
        if (segments.length === 0) return { start: 0, end: 0 };
        return {
          start: segments[0].segment_index,
          end: segments[segments.length - 1].segment_index + 1,
        };
      },
    };
  }, [segments]);

  return [
    {
      segments,
      isLoading,
      error,
      totalSegments,
    },
    translators,
  ];
}
