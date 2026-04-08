import { useEffect, useRef, useCallback } from 'react';
import { saveProgress } from '../api/client';
import type { ReadingProgress } from '../api/client';
import { useCursorState } from '../state/cursor/CursorContext';

interface UseProgressSaverOptions {
  publicationId: number;
  wpm: number;
  readingMode: string;
  /**
   * Optional override for the live word index. RSVP keeps word state
   * local for hot-path reasons (4-12 Hz tick) and only commits to the
   * cursor on segment boundaries; this callback lets the saver still
   * snapshot the latest intra-segment word on flush (visibility-hidden,
   * beforeunload, unmount).
   */
  getLiveWordIndex?: () => number;
}

function localStorageKey(pubId: number): string {
  return `speedreader_progress_${pubId}`;
}

/**
 * Reads its position from CursorContext and writes whenever the live
 * cursor commits. The `restore.status === 'live'` gate replaces the
 * old `enabled` flag — RestoreCoordinator owns the transition, so the
 * saver can never overwrite a saved position with a default zero.
 *
 * Writes go to localStorage on every commit (sync) and to the API on
 * a 2s debounce. visibility-hidden / beforeunload / unmount each
 * trigger an immediate flush.
 */
export function useProgressSaver(options: UseProgressSaverOptions): void {
  const { publicationId, wpm, readingMode, getLiveWordIndex } = options;
  const cursorRoot = useCursorState();
  const isLive = cursorRoot.restore.status === 'live';
  const { chapterId, absoluteSegmentIndex, wordIndex } = cursorRoot.cursor;

  const latestRef = useRef({
    publicationId,
    chapterId,
    absoluteSegmentIndex,
    wordIndex,
    wpm,
    readingMode,
    isLive,
    getLiveWordIndex,
  });
  latestRef.current = {
    publicationId,
    chapterId,
    absoluteSegmentIndex,
    wordIndex,
    wpm,
    readingMode,
    isLive,
    getLiveWordIndex,
  };

  const lastSavedKeyRef = useRef('');

  const doSave = useCallback(() => {
    const cur = latestRef.current;
    if (!cur.isLive || cur.chapterId === 0) return;
    // Prefer the engine's live word index on flush so a beforeunload
    // mid-segment writes the right RSVP word.
    const liveWord = cur.getLiveWordIndex?.() ?? cur.wordIndex;

    const data = {
      chapter_id: cur.chapterId,
      absolute_segment_index: cur.absoluteSegmentIndex,
      word_index: liveWord,
      wpm: cur.wpm,
      reading_mode: cur.readingMode,
    };

    try {
      const lsData: ReadingProgress = {
        publication_id: cur.publicationId,
        chapter_id: cur.chapterId,
        absolute_segment_index: cur.absoluteSegmentIndex,
        word_index: liveWord,
        wpm: cur.wpm,
        reading_mode: cur.readingMode,
        updated_at: new Date().toISOString(),
        // BookCard uses segments_read, but the home screen will refresh
        // it from the server on its next mount. Writing 0 here is fine
        // — only saveProgress's API response carries the real value.
        segments_read: 0,
      };
      localStorage.setItem(localStorageKey(cur.publicationId), JSON.stringify(lsData));
    } catch {
      /* storage full or unavailable */
    }

    saveProgress(cur.publicationId, data).catch(() => {});
  }, []);

  // Save on cursor change — localStorage immediate, API debounced.
  const apiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isLive || chapterId === 0) return;

    const key = `${publicationId}:${chapterId}:${absoluteSegmentIndex}:${wordIndex}:${wpm}:${readingMode}`;
    if (key !== lastSavedKeyRef.current) {
      lastSavedKeyRef.current = key;
      try {
        const lsData: ReadingProgress = {
          publication_id: publicationId,
          chapter_id: chapterId,
          absolute_segment_index: absoluteSegmentIndex,
          word_index: wordIndex,
          wpm,
          reading_mode: readingMode,
          updated_at: new Date().toISOString(),
          segments_read: 0,
        };
        localStorage.setItem(localStorageKey(publicationId), JSON.stringify(lsData));
      } catch {
        /* storage full or unavailable */
      }
    }

    if (apiTimerRef.current) clearTimeout(apiTimerRef.current);
    apiTimerRef.current = setTimeout(doSave, 2000);

    return () => {
      if (apiTimerRef.current) clearTimeout(apiTimerRef.current);
    };
  }, [
    isLive,
    publicationId,
    chapterId,
    absoluteSegmentIndex,
    wordIndex,
    wpm,
    readingMode,
    doSave,
  ]);

  // Immediate save on page hide, beforeunload, and unmount
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') doSave();
    };
    const onBeforeUnload = () => doSave();

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
      doSave();
    };
  }, [doSave]);
}
