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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    const key = `${publicationId}:${chapterId}:${segmentIndex}:${wordIndex}:${wpm}:${readingMode}`;
    if (key === lastSavedKeyRef.current) return;
    lastSavedKeyRef.current = key;

    const data = {
      chapter_id: chapterId,
      segment_index: segmentIndex,
      word_index: wordIndex,
      wpm,
      reading_mode: readingMode,
    };

    if (import.meta.env.DEV) {
      console.log('[ProgressSaver] saving', data);
    }

    // localStorage: sync, always works
    try {
      const lsData: ReadingProgress = {
        publication_id: publicationId,
        chapter_id: chapterId,
        segment_index: segmentIndex,
        word_index: wordIndex,
        wpm,
        reading_mode: readingMode,
        updated_at: new Date().toISOString(),
      };
      localStorage.setItem(localStorageKey(publicationId), JSON.stringify(lsData));
    } catch {
      /* storage full or unavailable */
    }

    // API: async, best-effort
    saveProgress(publicationId, data).catch(() => {});
  }, []);

  // Debounced save on value change (2 seconds)
  useEffect(() => {
    if (!options.enabled || options.chapterId === 0) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(doSave, 2000);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
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
