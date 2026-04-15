import { useEffect, useState } from 'react';
import type { Chapter, Segment } from '../api/types';
import { getSegments } from '../api/client';

export interface ChapterSegments {
  chapterIdx: number;
  chapterId: number;
  title: string;
  segments: Segment[];
}

export interface AllChapterSegmentsState {
  chapters: ChapterSegments[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Load every chapter's segments for a publication so plain/text mode
 * can render the whole book in one scrollable list (mirrors what
 * FormattedView does with `chapters.map`). Used only in paused state;
 * playing mode continues to load chapter-by-chapter via the engine.
 */
export function useAllChapterSegments(
  publicationId: number,
  chapters: Chapter[],
  enabled: boolean,
): AllChapterSegmentsState {
  const [state, setState] = useState<AllChapterSegmentsState>({
    chapters: [],
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!enabled || chapters.length === 0) {
      setState({ chapters: [], isLoading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, isLoading: true, error: null }));

    Promise.all(
      chapters.map((ch) =>
        getSegments(publicationId, ch.id, 0, 999999).then((batch) => ({
          chapterIdx: ch.chapter_index,
          chapterId: ch.id,
          title: ch.title,
          segments: batch.segments,
        })),
      ),
    )
      .then((results) => {
        if (cancelled) return;
        results.sort((a, b) => a.chapterIdx - b.chapterIdx);
        setState({ chapters: results, isLoading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          chapters: [],
          isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to load chapter segments',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [publicationId, chapters, enabled]);

  return state;
}
