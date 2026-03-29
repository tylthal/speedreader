import { useState, useEffect, useCallback } from 'react';
import {
  getHighlights,
  createHighlight,
  deleteHighlight,
  type Highlight,
} from '../api/client';

export function useHighlights(publicationId: number) {
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    getHighlights(publicationId)
      .then((data) => {
        if (!cancelled) setHighlights(data);
      })
      .catch(() => {
        // silently fail – highlights are non-critical
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [publicationId]);

  const addHighlight = useCallback(
    async (
      chapterId: number,
      segmentIndex: number,
      text: string,
      color?: string,
      note?: string,
    ) => {
      const highlight = await createHighlight(publicationId, {
        chapter_id: chapterId,
        segment_index: segmentIndex,
        text,
        color,
        note,
      });
      setHighlights((prev) => [highlight, ...prev]);
      return highlight;
    },
    [publicationId],
  );

  const removeHighlight = useCallback(async (highlightId: number) => {
    await deleteHighlight(highlightId);
    setHighlights((prev) => prev.filter((h) => h.id !== highlightId));
  }, []);

  const getSegmentHighlights = useCallback(
    (chapterId: number, segmentIndex: number) => {
      return highlights.filter(
        (h) => h.chapter_id === chapterId && h.segment_index === segmentIndex,
      );
    },
    [highlights],
  );

  return { highlights, addHighlight, removeHighlight, getSegmentHighlights, isLoading };
}
