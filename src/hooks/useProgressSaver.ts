import { useEffect, useRef, useCallback } from 'react';
import { upsertAutoBookmark } from '../api/client';
import { positionStore, usePositionSelector } from '../state/position/positionStore';
import { readStoredPrefs, writeStoredPosition, writeStoredPrefs } from '../lib/readerProgress';
import type { ReadingMode } from '../types';

interface UseProgressSaverOptions {
  publicationId: number;
}

/**
 * Persists reading position via the last_opened auto-bookmark.
 *
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
  const chapterId = usePositionSelector((s) => s.chapterId);
  const chapterIdx = usePositionSelector((s) => s.chapterIdx);
  const absoluteSegmentIndex = usePositionSelector((s) => s.absoluteSegmentIndex);
  const wordIndex = usePositionSelector((s) => s.wordIndex);
  const wpm = usePositionSelector((s) => s.wpm);
  const readingMode = usePositionSelector((s) => s.mode);
  const revision = usePositionSelector((s) => s.revision);

  const lastSavedKeyRef = useRef('');
  const wpmByModeRef = useRef<Partial<Record<ReadingMode, number>>>({});

  // Seed wpmByMode from localStorage on mount
  useEffect(() => {
    const existing = readStoredPrefs(publicationId);
    if (existing?.wpmByMode) {
      wpmByModeRef.current = { ...existing.wpmByMode };
    }
  }, [publicationId]);

  const doSave = useCallback(() => {
    const snap = positionStore.getSnapshot();
    if (snap.revision === 0) return; // pre-interaction, don't write
    if (snap.chapterId === 0) return;

    const location = {
      chapter_id: snap.chapterId,
      chapter_idx: snap.chapterIdx,
      absolute_segment_index: snap.absoluteSegmentIndex,
      word_index: snap.wordIndex,
    };

    writeStoredPosition(publicationId, location);
    wpmByModeRef.current = { ...wpmByModeRef.current, [snap.mode]: snap.wpm };
    writeStoredPrefs(publicationId, {
      wpm: snap.wpm,
      readingMode: snap.mode,
      wpmByMode: wpmByModeRef.current,
    });

    upsertAutoBookmark(publicationId, 'last_opened', location).catch((err) => {
      if (import.meta.env.DEV) console.warn('[ProgressSaver] auto-bookmark save failed:', err);
    });
  }, [publicationId]);

  // Save on cursor change — localStorage immediate, API debounced.
  const apiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (revision === 0) return;
    if (chapterId === 0) return;

    const key = `${publicationId}:${chapterId}:${chapterIdx}:${absoluteSegmentIndex}:${wordIndex}:${wpm}:${readingMode}`;
    if (key !== lastSavedKeyRef.current) {
      lastSavedKeyRef.current = key;
      writeStoredPosition(publicationId, {
        chapter_id: chapterId,
        chapter_idx: chapterIdx,
        absolute_segment_index: absoluteSegmentIndex,
        word_index: wordIndex,
      });
      wpmByModeRef.current = { ...wpmByModeRef.current, [readingMode]: wpm };
      writeStoredPrefs(publicationId, { wpm, readingMode, wpmByMode: wpmByModeRef.current });
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
    chapterIdx,
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
