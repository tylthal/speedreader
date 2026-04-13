import { useEffect, useRef, useCallback } from 'react';
import { upsertAutoBookmark } from '../api/client';
import { positionStore } from '../state/position/positionStore';
import { readStoredPrefs, writeStoredPosition, writeStoredPrefs } from '../lib/readerProgress';
import type { ReadingMode } from '../types';

interface UseProgressSaverOptions {
  publicationId: number;
}

/**
 * Persists reading position via the last_opened auto-bookmark.
 *
 * Uses a direct positionStore subscription instead of React state so
 * that position commits during scroll/track playback don't trigger
 * React re-renders. Writes go to localStorage on every commit (sync)
 * and to the API on a 2s debounce. visibility-hidden / beforeunload /
 * unmount each trigger an immediate flush.
 */
export function useProgressSaver({ publicationId }: UseProgressSaverOptions): void {
  const lastSavedKeyRef = useRef('');
  const lastSavedChapterIdRef = useRef(0);
  const wpmByModeRef = useRef<Partial<Record<ReadingMode, number>>>({});
  const apiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    // Don't flush a chapter-transition placeholder on exit
    if (
      snap.absoluteSegmentIndex === 0 &&
      snap.chapterId !== lastSavedChapterIdRef.current &&
      lastSavedChapterIdRef.current !== 0
    ) {
      return;
    }

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

  // Subscribe to store directly — no React re-renders.
  useEffect(() => {
    return positionStore.subscribe(() => {
      const snap = positionStore.getSnapshot();
      if (snap.revision === 0) return;
      if (snap.chapterId === 0) return;

      // Skip saving position 0 when the chapter just changed. This is a
      // placeholder from handleVisibleSectionChange / chapter-nav — the
      // real position will be detected by Effect 3 once segments load.
      // Saving this placeholder would overwrite the correct position in
      // the PREVIOUS chapter, causing re-entry to jump to segment 0.
      if (
        snap.absoluteSegmentIndex === 0 &&
        snap.chapterId !== lastSavedChapterIdRef.current &&
        lastSavedChapterIdRef.current !== 0
      ) {
        return;
      }

      const key = `${publicationId}:${snap.chapterId}:${snap.chapterIdx}:${snap.absoluteSegmentIndex}:${snap.wordIndex}:${snap.wpm}:${snap.mode}`;
      if (key !== lastSavedKeyRef.current) {
        lastSavedKeyRef.current = key;
        lastSavedChapterIdRef.current = snap.chapterId;
        writeStoredPosition(publicationId, {
          chapter_id: snap.chapterId,
          chapter_idx: snap.chapterIdx,
          absolute_segment_index: snap.absoluteSegmentIndex,
          word_index: snap.wordIndex,
        });
        wpmByModeRef.current = { ...wpmByModeRef.current, [snap.mode]: snap.wpm };
        writeStoredPrefs(publicationId, { wpm: snap.wpm, readingMode: snap.mode, wpmByMode: wpmByModeRef.current });
      }

      if (apiTimerRef.current) clearTimeout(apiTimerRef.current);
      apiTimerRef.current = setTimeout(doSave, 2000);
    });
  }, [publicationId, doSave]);

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
      if (apiTimerRef.current) clearTimeout(apiTimerRef.current);
      doSave();
    };
  }, [doSave]);
}
