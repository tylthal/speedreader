import { useEffect, useRef, useCallback } from 'react';
import { bookmarkStore } from '../state/bookmarkStore';
import { positionStore } from '../state/position/positionStore';
import { readStoredPrefs, writeStoredPosition, writeStoredPrefs } from '../lib/readerProgress';
import type { ReadingMode } from '../types';
import type { DisplayMode } from '../state/position/types';

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
  // Debounce localStorage writes so scroll-tick commits don't land a
  // synchronous setItem on every 10-px scroll bucket.
  const lsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPositionRef = useRef<{
    chapter_id: number
    chapter_idx: number
    absolute_segment_index: number
    word_index: number
    scroll_top: number
  } | null>(null);
  const pendingPrefsRef = useRef<{ wpm: number; readingMode: ReadingMode; wpmByMode: Partial<Record<ReadingMode, number>> } | null>(null);

  const flushLocalStorage = useCallback(() => {
    if (lsTimerRef.current) {
      clearTimeout(lsTimerRef.current);
      lsTimerRef.current = null;
    }
    const pos = pendingPositionRef.current;
    if (pos) {
      pendingPositionRef.current = null;
      writeStoredPosition(publicationId, pos);
    }
    const prefs = pendingPrefsRef.current;
    if (prefs) {
      pendingPrefsRef.current = null;
      writeStoredPrefs(publicationId, prefs);
    }
  }, [publicationId]);

  const scheduleLocalStorageWrite = useCallback(() => {
    if (lsTimerRef.current) return;
    lsTimerRef.current = setTimeout(() => {
      lsTimerRef.current = null;
      flushLocalStorage();
    }, 500);
  }, [flushLocalStorage]);
  /** Last section-relative offset computed while the DOM was live.
   *  Used as a fallback in doSave() when the container may be detached
   *  (e.g. during React unmount cleanup in Safari, where detached
   *  elements return scrollTop=0). Cleared on chapter or display-mode
   *  change so a stale offset from a previous layout can't be persisted. */
  const lastLiveSectionOffsetRef = useRef<number | null>(null);
  /** Tracks chapterIdx / displayMode so we can null-out the fallback
   *  cache the first time we observe a layout-invalidating transition. */
  const lastChapterIdxRef = useRef<number | null>(null);
  const lastDisplayModeRef = useRef<DisplayMode | null>(null);
  /** Play->pause edge detection — flush-on-pause (replaces the separate
   *  pause subscription that used to live in this hook). */
  const wasPlayingRef = useRef(false);
  /** Monotonic farthest-read tracker. Moved here from ReaderViewport so
   *  the single subscription handles both progress save and farthest-read. */
  const farthestGlobalRef = useRef(-1);

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

  // Single subscription to the store. Handles (in order):
  //   1. Fallback-cache invalidation on chapter / display-mode transitions.
  //   2. Play->pause edge detection — flushes the pending API write
  //      immediately so lastOpened / farthestRead markers don't lag by
  //      up to 2s after the pause click. Replaces what used to be a
  //      separate positionStore.subscribe() block.
  //   3. Placeholder-segment guard (don't overwrite previous chapter's
  //      position with a chapter-transition placeholder of segment 0).
  //   4. Synchronous localStorage write on any key change.
  //   5. Farthest-read update (monotonic), folded in from ReaderViewport.
  //   6. 2s debounced API flush via doSave().
  //
  // Using one subscription guarantees deterministic ordering of the
  // pause-flush versus the farthest-read update for the same snapshot,
  // and halves the per-commit listener-iteration cost.
  useEffect(() => {
    return positionStore.subscribe(() => {
      const snap = positionStore.getSnapshot();

      // Edge-detect play->pause BEFORE any early returns so we always
      // catch the transition, then update the tracker.
      const wasPlaying = wasPlayingRef.current;
      wasPlayingRef.current = snap.isPlaying;
      const pauseTransition = wasPlaying && !snap.isPlaying;

      // Invalidate the unmount-fallback cache whenever layout topology
      // changes (chapter swap or display-mode flip). Either transition
      // invalidates offsetTop assumptions, so the cached section offset
      // must not survive into the next layout.
      if (
        lastChapterIdxRef.current !== null &&
        (snap.chapterIdx !== lastChapterIdxRef.current ||
          snap.displayMode !== lastDisplayModeRef.current)
      ) {
        lastLiveSectionOffsetRef.current = null;
      }
      lastChapterIdxRef.current = snap.chapterIdx;
      lastDisplayModeRef.current = snap.displayMode;

      if (snap.revision === 0) return;
      if (snap.chapterId === 0) return;

      // Skip saving position 0 when the chapter just changed. This is a
      // placeholder from handleVisibleSectionChange / chapter-nav — the
      // real position will be detected by Effect 3 once segments load.
      // Saving this placeholder would overwrite the correct position in
      // the PREVIOUS chapter, causing re-entry to jump to segment 0.
      const isPlaceholder =
        snap.absoluteSegmentIndex === 0 &&
        snap.chapterId !== lastSavedChapterIdRef.current &&
        lastSavedChapterIdRef.current !== 0;
      if (isPlaceholder) {
        // Still honor the pause-flush: doSave() has its own placeholder
        // guard that will no-op for the same reason, but calling it
        // preserves the original flush-on-pause semantic of clearing the
        // 2s timer so a stale post-pause write doesn't fire.
        if (pauseTransition) {
          if (apiTimerRef.current) {
            clearTimeout(apiTimerRef.current);
            apiTimerRef.current = null;
          }
          flushLocalStorage();
          doSave();
        }
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
        // Stash the latest values and debounce the sync localStorage
        // writes. During playback the commit rate outpaces what the
        // main thread can absorb as setItem calls; the pause/unload/
        // unmount flush paths still persist immediately.
        pendingPositionRef.current = {
          chapter_id: snap.chapterId,
          chapter_idx: snap.chapterIdx,
          absolute_segment_index: snap.absoluteSegmentIndex,
          word_index: snap.wordIndex,
          scroll_top: sectionOffset,
        };
        wpmByModeRef.current = { ...wpmByModeRef.current, [snap.mode]: snap.wpm };
        pendingPrefsRef.current = {
          wpm: snap.wpm,
          readingMode: snap.mode,
          wpmByMode: wpmByModeRef.current,
        };
        scheduleLocalStorageWrite();
      }

      // Farthest-read update (monotonic). Mirrors the old ReaderViewport
      // subscription verbatim: same snap.origin guard, same globalIndex
      // computation, same call into bookmarkStore.updateFarthestRead.
      if (snap.origin !== 'restore') {
        const globalIndex = snap.chapterIdx * 100000 + snap.absoluteSegmentIndex;
        if (globalIndex > farthestGlobalRef.current) {
          farthestGlobalRef.current = globalIndex;
          bookmarkStore
            .updateFarthestRead(
              {
                chapter_id: snap.chapterId,
                chapter_idx: snap.chapterIdx,
                absolute_segment_index: snap.absoluteSegmentIndex,
                word_index: snap.wordIndex,
              },
              globalIndex,
            )
            .catch(() => {});
        }
      }

      // API flush: on play->pause transition, cancel the debounce and
      // flush immediately so bookmark markers reflect the pause point.
      // Otherwise, (re)arm the 2s debounce.
      if (apiTimerRef.current) clearTimeout(apiTimerRef.current);
      if (pauseTransition) {
        apiTimerRef.current = null;
        flushLocalStorage();
        doSave();
      } else {
        apiTimerRef.current = setTimeout(doSave, 2000);
      }
    });
  }, [publicationId, doSave, flushLocalStorage, scheduleLocalStorageWrite]);

  // Immediate save on page hide, beforeunload, and unmount
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushLocalStorage();
        doSave();
      }
    };
    const onBeforeUnload = () => {
      flushLocalStorage();
      doSave();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (apiTimerRef.current) clearTimeout(apiTimerRef.current);
      flushLocalStorage();
      doSave();
    };
  }, [doSave, flushLocalStorage]);
}
