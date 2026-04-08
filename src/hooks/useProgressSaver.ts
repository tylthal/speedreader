import { useEffect, useRef, useCallback } from 'react';
import { saveProgress } from '../api/client';
import type { ReadingProgress } from '../api/client';
import { positionStore, usePositionSelector } from '../state/position/positionStore';

interface UseProgressSaverOptions {
  publicationId: number;
}

function localStorageKey(pubId: number): string {
  return `speedreader_progress_${pubId}`;
}

/**
 * Reads its position from positionStore and writes whenever the live
 * position commits. Gate: `revision > 0` — the seed init() leaves
 * revision at 0, so the saver never overwrites the restored position
 * before the user has interacted.
 *
 * Writes go to localStorage on every commit (sync) and to the API on
 * a 2s debounce. visibility-hidden / beforeunload / unmount each
 * trigger an immediate flush.
 */
export function useProgressSaver({ publicationId }: UseProgressSaverOptions): void {
  // Subscribe to the slices we care about. The store's selector
  // dedupe makes per-tick word changes free unless we ask for word.
  const chapterId = usePositionSelector((s) => s.chapterId);
  const absoluteSegmentIndex = usePositionSelector((s) => s.absoluteSegmentIndex);
  const wordIndex = usePositionSelector((s) => s.wordIndex);
  const wpm = usePositionSelector((s) => s.wpm);
  const readingMode = usePositionSelector((s) => s.mode);
  const revision = usePositionSelector((s) => s.revision);

  const lastSavedKeyRef = useRef('');

  const doSave = useCallback(() => {
    const snap = positionStore.getSnapshot();
    if (snap.revision === 0) return; // pre-interaction, don't write
    if (snap.chapterId === 0) return;

    const data = {
      chapter_id: snap.chapterId,
      absolute_segment_index: snap.absoluteSegmentIndex,
      word_index: snap.wordIndex,
      wpm: snap.wpm,
      reading_mode: snap.mode,
    };

    try {
      const lsData: ReadingProgress = {
        publication_id: publicationId,
        chapter_id: snap.chapterId,
        absolute_segment_index: snap.absoluteSegmentIndex,
        word_index: snap.wordIndex,
        wpm: snap.wpm,
        reading_mode: snap.mode,
        updated_at: new Date().toISOString(),
        // BookCard reads the API response's segments_read; the localStorage
        // value is a placeholder overwritten on the next API success.
        segments_read: 0,
      };
      localStorage.setItem(localStorageKey(publicationId), JSON.stringify(lsData));
    } catch {
      /* storage full or unavailable */
    }

    saveProgress(publicationId, data).catch(() => {});
  }, [publicationId]);

  // Save on cursor change — localStorage immediate, API debounced.
  const apiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (revision === 0) return;
    if (chapterId === 0) return;

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
    revision,
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
