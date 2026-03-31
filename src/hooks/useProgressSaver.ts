import { useEffect, useRef, useCallback } from 'react';
import { saveProgress } from '../api/client';
import type { ReadingProgress } from '../api/client';

interface UseProgressSaverOptions {
  publicationId: number;
  chapterId: number;
  segmentIndex: number;
  wordIndex: number;
  wpm: number;
  readingMode: string;
  /** Saves are completely suppressed until enabled is true */
  enabled: boolean;
}

function localStorageKey(pubId: number): string {
  return `speedreader_progress_${pubId}`;
}

/**
 * Minimal progress saver. Does NOT load or restore progress.
 * Saves are suppressed until `enabled` is true, preventing
 * default values from overwriting real saved progress.
 */
export function useProgressSaver(options: UseProgressSaverOptions): void {
  const latestRef = useRef(options);
  latestRef.current = options;

  const lastSavedKeyRef = useRef('');

  const doSave = useCallback(() => {
    const {
      publicationId,
      chapterId,
      segmentIndex,
      wordIndex,
      wpm,
      readingMode,
      enabled,
    } = latestRef.current;

    if (!enabled || chapterId === 0) return;

    const data = {
      chapter_id: chapterId,
      segment_index: segmentIndex,
      word_index: wordIndex,
      wpm,
      reading_mode: readingMode,
    };

    // localStorage (immediate, in case API fails)
    try {
      const lsData: ReadingProgress = {
        publication_id: publicationId,
        chapter_id: chapterId,
        segment_index: segmentIndex,
        word_index: wordIndex,
        wpm,
        reading_mode: readingMode,
        updated_at: new Date().toISOString(),
        segments_read: segmentIndex,
      };
      localStorage.setItem(localStorageKey(publicationId), JSON.stringify(lsData));
    } catch {
      /* storage full or unavailable */
    }

    // API: async, best-effort
    saveProgress(publicationId, data).catch(() => {});
  }, []);

  // Save on segment change — localStorage is immediate (sync),
  // API is debounced to avoid flooding the server.
  const apiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!options.enabled || options.chapterId === 0) return;

    // Always save to localStorage immediately on segment change
    const {
      publicationId,
      chapterId,
      segmentIndex,
      wordIndex,
      wpm,
      readingMode,
    } = options;

    const key = `${publicationId}:${chapterId}:${segmentIndex}:${wordIndex}:${wpm}:${readingMode}`;
    if (key !== lastSavedKeyRef.current) {
      lastSavedKeyRef.current = key;
      try {
        const lsData: ReadingProgress = {
          publication_id: publicationId,
          chapter_id: chapterId,
          segment_index: segmentIndex,
          word_index: wordIndex,
          wpm,
          reading_mode: readingMode,
          updated_at: new Date().toISOString(),
          segments_read: segmentIndex,
        };
        localStorage.setItem(localStorageKey(publicationId), JSON.stringify(lsData));
      } catch {
        /* storage full or unavailable */
      }
    }

    // Debounce API save (2 seconds)
    if (apiTimerRef.current) clearTimeout(apiTimerRef.current);
    apiTimerRef.current = setTimeout(doSave, 2000);

    return () => {
      if (apiTimerRef.current) clearTimeout(apiTimerRef.current);
    };
  }, [
    options.enabled,
    options.publicationId,
    options.chapterId,
    options.segmentIndex,
    options.wordIndex,
    options.wpm,
    options.readingMode,
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
      // Save on unmount (user navigating away from reader)
      doSave();
    };
  }, [doSave]);
}
