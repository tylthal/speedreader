import { useEffect, useRef, useCallback } from 'react';
import { bookmarkStore } from '../state/bookmarkStore';
import { positionStore } from '../state/position/positionStore';
import { readStoredPrefs, writeStoredPosition, writeStoredPrefs } from '../lib/readerProgress';
import type { ReadingMode } from '../types';

interface FormattedViewLike {
  getScrollContainer(): HTMLElement | null
  getSectionEl(idx: number): HTMLElement | null
}

interface UseProgressSaverOptions {
  publicationId: number;
  /** Ref to the formatted view scroll container, used to read live scrollTop. */
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
  /** Ref to the formatted view handle, used to compute section-relative offset. */
  formattedViewRef?: React.RefObject<FormattedViewLike | null>;
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
export function useProgressSaver({ publicationId, scrollContainerRef, formattedViewRef }: UseProgressSaverOptions): void {
  const lastSavedKeyRef = useRef('');
  const lastSavedChapterIdRef = useRef(0);
  const wpmByModeRef = useRef<Partial<Record<ReadingMode, number>>>({});
  const apiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Last section-relative offset computed while the DOM was live.
   *  Used as a fallback in doSave() when the container may be detached
   *  (e.g. during React unmount cleanup in Safari, where detached
   *  elements return scrollTop=0). */
  const lastLiveSectionOffsetRef = useRef<number | null>(null);

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

    // Compute section-relative scroll offset from live DOM. This is
    // immune to layout changes in other sections (image decode, font
    // load, or sections not yet rendered on restore).
    const container = scrollContainerRef?.current;
    const sectionEl = formattedViewRef?.current?.getSectionEl(snap.chapterIdx);
    let sectionOffset = snap.scrollTop; // fallback to store value
    if (container && sectionEl) {
      const rawOffset = container.scrollTop - sectionEl.offsetTop;
      // Guard against detached DOM elements (Safari iOS zeroes
      // scrollTop/offsetTop on detached elements). If the DOM reads
      // zero but the store has a non-zero scrollTop, the container is
      // likely detached — use the last value computed while DOM was live.
      if (
        rawOffset === 0 &&
        snap.scrollTop > 0 &&
        container.scrollTop === 0 &&
        lastLiveSectionOffsetRef.current != null
      ) {
        sectionOffset = lastLiveSectionOffsetRef.current;
      } else {
        sectionOffset = rawOffset;
      }
    } else if (container) {
      if (
        container.scrollTop === 0 &&
        snap.scrollTop > 0 &&
        lastLiveSectionOffsetRef.current != null
      ) {
        sectionOffset = lastLiveSectionOffsetRef.current;
      } else {
        sectionOffset = container.scrollTop;
      }
    } else if (lastLiveSectionOffsetRef.current != null) {
      // Refs already cleared (unmount) — use cached value
      sectionOffset = lastLiveSectionOffsetRef.current;
    }

    const location = {
      chapter_id: snap.chapterId,
      chapter_idx: snap.chapterIdx,
      absolute_segment_index: snap.absoluteSegmentIndex,
      word_index: snap.wordIndex,
    };

    // Refuse to persist implausible scroll_top values. Negative values
    // happen when the target section's offsetTop grows after we read
    // container.scrollTop (because prior sections are still filling in
    // during restore) — persisting them poisons localStorage and
    // corrupts the next restore. Out-of-range positives are similarly
    // bogus (> 1e6 px means something went very wrong upstream).
    if (sectionOffset < 0 || sectionOffset > 1_000_000) {
      if (import.meta.env.DEV) {
        console.warn('[ProgressSaver] refusing implausible scroll_top', {
          sectionOffset,
          containerScrollTop: container?.scrollTop,
          sectionOffsetTop: sectionEl?.offsetTop,
          snap,
        });
      }
      return;
    }

    writeStoredPosition(publicationId, {
      ...location,
      scroll_top: sectionOffset,
    });
    wpmByModeRef.current = { ...wpmByModeRef.current, [snap.mode]: snap.wpm };
    writeStoredPrefs(publicationId, {
      wpm: snap.wpm,
      readingMode: snap.mode,
      wpmByMode: wpmByModeRef.current,
    });

    bookmarkStore.updateLastOpened(location).catch((err) => {
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

      // Compute section-relative scroll offset from live DOM.
      const container = scrollContainerRef?.current;
      const sectionEl = formattedViewRef?.current?.getSectionEl(snap.chapterIdx);
      let sectionOffset = snap.scrollTop;
      if (container && sectionEl) {
        sectionOffset = container.scrollTop - sectionEl.offsetTop;
      } else if (container) {
        sectionOffset = container.scrollTop;
      }
      // Cache the offset while the DOM is known to be live, but ONLY
      // when the value is plausible (>= 0). A negative value here means
      // the target section's offsetTop was larger than the container's
      // scrollTop — a transient layout state during restore that must
      // not be allowed to poison the unmount-fallback cache. Without
      // this guard, useProgressSaver's doSave() would fall back to the
      // negative value on unmount and persist it to localStorage.
      if (sectionOffset >= 0) {
        lastLiveSectionOffsetRef.current = sectionOffset;
      }

      // Refuse to persist implausible scroll_top values. See the same
      // guard in doSave() above for rationale.
      if (sectionOffset < 0 || sectionOffset > 1_000_000) {
        if (import.meta.env.DEV) {
          console.warn('[ProgressSaver] refusing implausible scroll_top (live)', {
            sectionOffset,
            containerScrollTop: container?.scrollTop,
            sectionOffsetTop: sectionEl?.offsetTop,
            snap,
          });
        }
        return;
      }

      // Include a coarse offset in the key so intra-segment scroll
      // changes trigger a save. Round to 10px to avoid writing on every
      // pixel of scroll while still capturing meaningful position changes.
      const scrollBucket = Math.round(sectionOffset / 10) * 10;
      const key = `${publicationId}:${snap.chapterId}:${snap.chapterIdx}:${snap.absoluteSegmentIndex}:${snap.wordIndex}:${snap.wpm}:${snap.mode}:${scrollBucket}`;
      if (key !== lastSavedKeyRef.current) {
        lastSavedKeyRef.current = key;
        lastSavedChapterIdRef.current = snap.chapterId;
        writeStoredPosition(publicationId, {
          chapter_id: snap.chapterId,
          chapter_idx: snap.chapterIdx,
          absolute_segment_index: snap.absoluteSegmentIndex,
          word_index: snap.wordIndex,
          scroll_top: sectionOffset,
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

  // Flush on the isPlaying true→false transition. The 2s API debounce is the
  // right default for continuous playback (avoids hammering IndexedDB on every
  // segment boundary), but a user who pauses expects their position — and the
  // auto-bookmark markers on the progress bar — to reflect where they just
  // stopped. Without this flush, lastOpened/farthestRead markers can take up
  // to 2s of additional idle time to appear after the pause click.
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    const unsub = positionStore.subscribe(() => {
      const snap = positionStore.getSnapshot();
      if (wasPlayingRef.current && !snap.isPlaying) {
        if (apiTimerRef.current) {
          clearTimeout(apiTimerRef.current);
          apiTimerRef.current = null;
        }
        doSave();
      }
      wasPlayingRef.current = snap.isPlaying;
    });
    return unsub;
  }, [doSave]);
}
