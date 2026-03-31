import { useState, useEffect, useCallback, useRef } from 'react';
import { useAnnounce } from '../hooks/useAnnounce';
import { useSegmentLoader } from '../hooks/useSegmentLoader';
import { usePlaybackEngine } from '../hooks/usePlaybackEngine';
import { useRsvpEngine } from '../hooks/useRsvpEngine';
import { useProgressSaver } from '../hooks/useProgressSaver';
import { useOrientationResilience } from '../hooks/useOrientationResilience';
import { useKeyboardHandling } from '../hooks/useKeyboardHandling';
import { useNavigate } from 'react-router-dom';
import { getPublication, getProgress } from '../api/client';
import { useBookmarks } from '../hooks/useBookmarks';
import { useDataSaver } from '../hooks/useDataSaver';
import { markNavigationStart, markFirstChunkRendered } from '../lib/ttfcMetric';
import type { Chapter, ReadingProgress } from '../api/client';
import type { ReadingMode } from '../types';
import GestureLayer from './GestureLayer';
import FocusChunkOverlay from './FocusChunkOverlay';
import ControlsBottomSheet from './ControlsBottomSheet';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ReaderViewportProps {
  publicationId: number;
}

interface InitialPosition {
  chapters: Chapter[];
  chapterIdx: number;
  segmentIndex: number;
  wordIndex: number;
  wpm: number;
  readingMode: ReadingMode;
}

interface ActiveReaderProps {
  publicationId: number;
  chapters: Chapter[];
  initialChapterIdx: number;
  initialSegmentIndex: number;
  initialWordIndex: number;
  initialWpm: number;
  initialReadingMode: ReadingMode;
}

/* ------------------------------------------------------------------ */
/*  ReaderViewport — Phase 1: Loading                                  */
/* ------------------------------------------------------------------ */

export default function ReaderViewport({ publicationId }: ReaderViewportProps) {
  const [initState, setInitState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; position: InitialPosition }
  >({ status: 'loading' });

  useEffect(() => {
    markNavigationStart();
  }, []);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      getPublication(publicationId),
      getProgress(publicationId).catch(() => null),
    ])
      .then(([pub, apiProgress]) => {
        if (cancelled) return;

        const sorted = [...pub.chapters].sort(
          (a, b) => a.chapter_index - b.chapter_index,
        );

        if (sorted.length === 0) {
          setInitState({ status: 'error', message: 'No chapters found in this publication.' });
          return;
        }

        // Pick best progress: compare API vs localStorage, use most recent
        let progress: ReadingProgress | null = apiProgress;
        try {
          const raw = localStorage.getItem(`speedreader_progress_${publicationId}`);
          if (raw) {
            const local = JSON.parse(raw) as ReadingProgress;
            if (!progress || new Date(local.updated_at) > new Date(progress.updated_at)) {
              progress = local;
            }
          }
        } catch {
          /* ignore */
        }

        // Compute initial position from saved progress
        let chapterIdx = 0;
        let segmentIndex = 0;
        let wordIndex = 0;
        let wpm = 250;
        let readingMode: ReadingMode = 'phrase';

        if (progress) {
          const savedChapterIdx = sorted.findIndex(
            (ch) => ch.id === progress!.chapter_id,
          );
          if (savedChapterIdx !== -1) {
            chapterIdx = savedChapterIdx;
            segmentIndex = progress.segment_index;
            wordIndex = progress.word_index ?? 0;
            wpm = progress.wpm;
            if (progress.reading_mode === 'rsvp' || progress.reading_mode === 'phrase') {
              readingMode = progress.reading_mode as ReadingMode;
            }
          }

          if (import.meta.env.DEV) {
            console.log('[Progress] restoring', {
              source: progress === apiProgress ? 'api' : 'localStorage',
              chapterIdx,
              segmentIndex,
              wordIndex,
              wpm,
              readingMode,
            });
          }
        } else if (import.meta.env.DEV) {
          console.log('[Progress] no saved progress found');
        }

        setInitState({
          status: 'ready',
          position: { chapters: sorted, chapterIdx, segmentIndex, wordIndex, wpm, readingMode },
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setInitState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load publication',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [publicationId]);

  if (initState.status === 'loading') {
    return <div className="reader-viewport__loading">Loading...</div>;
  }

  if (initState.status === 'error') {
    return <div className="reader-viewport__error">{initState.message}</div>;
  }

  const { position } = initState;
  return (
    <ActiveReader
      publicationId={publicationId}
      chapters={position.chapters}
      initialChapterIdx={position.chapterIdx}
      initialSegmentIndex={position.segmentIndex}
      initialWordIndex={position.wordIndex}
      initialWpm={position.wpm}
      initialReadingMode={position.readingMode}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  ActiveReader — Phase 2: Fully initialized reader                   */
/* ------------------------------------------------------------------ */

function ActiveReader({
  publicationId,
  chapters,
  initialChapterIdx,
  initialSegmentIndex,
  initialWordIndex,
  initialWpm,
  initialReadingMode,
}: ActiveReaderProps) {
  const [readingMode, setReadingMode] = useState<ReadingMode>(initialReadingMode);
  const [chapterIdx, setChapterIdx] = useState(initialChapterIdx);
  const [saverEnabled, setSaverEnabled] = useState(false);
  const [stopAtChapterEnd, setStopAtChapterEnd] = useState(() => {
    try {
      return localStorage.getItem(`speedreader_stop_at_chapter_${publicationId}`) === '1';
    } catch { return false; }
  });
  const hasAppliedInitialSeek = useRef(false);
  const autoAdvanceRef = useRef(false);
  const stopAtChapterEndRef = useRef(stopAtChapterEnd);
  stopAtChapterEndRef.current = stopAtChapterEnd;

  const handleToggleStopAtChapter = useCallback(() => {
    setStopAtChapterEnd((prev) => {
      const next = !prev;
      try { localStorage.setItem(`speedreader_stop_at_chapter_${publicationId}`, next ? '1' : '0'); } catch {}
      return next;
    });
  }, [publicationId]);

  const navigate = useNavigate();
  const { announce } = useAnnounce();
  const isDataSaver = useDataSaver();

  const currentChapter = chapters[chapterIdx] ?? null;
  const currentChapterId = currentChapter?.id ?? 0;

  // Track the absolute segment_index the engines are currently on.
  // This survives array shifts caused by backward prefetch.
  const trackedSegmentIndexRef = useRef(initialSegmentIndex);

  // Reset tracked segment position on chapter change
  const prevChapterIdRef = useRef(currentChapterId);
  if (prevChapterIdRef.current !== currentChapterId) {
    prevChapterIdRef.current = currentChapterId;
    trackedSegmentIndexRef.current = 0;
  }

  /* ---- Segment loader ---- */
  const [loaderState, loaderActions] = useSegmentLoader({
    publicationId,
    chapterId: currentChapterId,
    dataSaver: isDataSaver,
    initialSegmentIndex,
  });

  useEffect(() => {
    if (loaderState.segments.length > 0) {
      markFirstChunkRendered();
    }
  }, [loaderState.segments]);

  /* ---- Callbacks for engines ---- */
  const suppressPrefetchRef = useRef(false);
  const onSegmentChange = useCallback(
    (index: number) => {
      // Keep the tracked absolute segment_index in sync
      const seg = loaderState.segments[index];
      if (seg) trackedSegmentIndexRef.current = seg.segment_index;
      if (!suppressPrefetchRef.current) {
        loaderActions.checkPrefetch(index);
      }
    },
    [loaderActions, loaderState.segments],
  );

  const onPlaybackComplete = useCallback(() => {
    if (chapterIdx >= chapters.length - 1) {
      announce('Book finished');
      return;
    }
    if (stopAtChapterEndRef.current) {
      announce(`Chapter complete: ${chapters[chapterIdx]?.title ?? ''}`);
      return;
    }
    autoAdvanceRef.current = true;
    setChapterIdx((i) => i + 1);
    announce(`Next chapter: ${chapters[chapterIdx + 1]?.title ?? ''}`);
  }, [chapterIdx, chapters, announce]);

  /* ---- Playback engines (initialized with correct WPM from the start) ---- */
  const [playbackState, playbackActions] = usePlaybackEngine({
    segments: loaderState.segments,
    totalSegments: loaderState.totalSegments,
    initialWpm,
    onSegmentChange,
    onComplete: onPlaybackComplete,
  });

  const [rsvpState, rsvpActions] = useRsvpEngine({
    segments: loaderState.segments,
    totalSegments: loaderState.totalSegments,
    initialWpm,
    onSegmentChange,
    onComplete: onPlaybackComplete,
  });

  /* ---- Active state/actions based on reading mode ---- */
  const activeState = readingMode === 'rsvp'
    ? {
        currentIndex: rsvpState.currentSegmentIndex,
        isPlaying: rsvpState.isPlaying,
        wpm: rsvpState.wpm,
        progress: rsvpState.progress,
      }
    : playbackState;

  const activeActions = readingMode === 'rsvp'
    ? {
        play: rsvpActions.play,
        pause: rsvpActions.pause,
        togglePlayPause: rsvpActions.togglePlayPause,
        seekTo: rsvpActions.seekToSegment,
        setWpm: rsvpActions.setWpm,
        adjustWpm: rsvpActions.adjustWpm,
      }
    : playbackActions;

  // trackedSegmentIndexRef declared earlier, before chapter change reset

  /* ---- Initial seek: apply once when segments first load ---- */
  useEffect(() => {
    if (hasAppliedInitialSeek.current) return;
    if (loaderState.segments.length === 0) return;

    hasAppliedInitialSeek.current = true;

    // Segments now load starting from the exact saved position, so
    // array index 0 IS the saved segment. No seek needed for the segment.
    // Only restore word position for RSVP mode.
    if (initialWordIndex > 0) {
      rsvpActions.seekToSegment(0, initialWordIndex);
    }
    trackedSegmentIndexRef.current = loaderState.segments[0]?.segment_index ?? initialSegmentIndex;

    setSaverEnabled(true);
  }, [loaderState.segments, initialSegmentIndex, initialWordIndex, playbackActions, rsvpActions]);

  /* ---- Correct engine positions when segments prepend shifts array ---- */
  const prevSegmentsRef = useRef(loaderState.segments);
  useEffect(() => {
    if (!hasAppliedInitialSeek.current) return;
    const prev = prevSegmentsRef.current;
    const next = loaderState.segments;
    prevSegmentsRef.current = next;

    // Skip if segments were cleared (chapter change) or this is the first load
    if (prev.length === 0 || next.length === 0 || prev === next) return;

    // Detect if the array start shifted (backward prefetch prepended segments)
    const prevFirstIdx = prev[0]?.segment_index;
    const nextFirstIdx = next[0]?.segment_index;
    if (prevFirstIdx === undefined || nextFirstIdx === undefined) return;
    if (nextFirstIdx >= prevFirstIdx) return; // Forward append or no change — indices still valid

    // Array shifted: find new array index for the tracked segment
    const targetSegIdx = trackedSegmentIndexRef.current;
    const newArrayIdx = next.findIndex((s) => s.segment_index >= targetSegIdx);
    if (newArrayIdx !== -1) {
      playbackActions.seekTo(newArrayIdx);
      // Preserve word index for RSVP
      const currentWordIdx = rsvpState.currentWordIndex;
      rsvpActions.seekToSegment(newArrayIdx, currentWordIdx);
    }
  }, [loaderState.segments, playbackActions, rsvpActions, rsvpState.currentWordIndex]);

  /* ---- Auto-play after chapter auto-advance ---- */
  useEffect(() => {
    if (!hasAppliedInitialSeek.current) return;
    if (autoAdvanceRef.current && loaderState.segments.length > 0) {
      autoAdvanceRef.current = false;
      activeActions.seekTo(0);
      setTimeout(() => activeActions.play(), 300);
    }
  }, [loaderState.segments, activeActions]);

  /* ---- Mode toggle ---- */
  const handleToggleMode = useCallback(() => {
    playbackActions.pause();
    rsvpActions.pause();

    setReadingMode((prev) => {
      const next = prev === 'phrase' ? 'rsvp' : 'phrase';
      if (next === 'rsvp') {
        rsvpActions.seekToSegment(playbackState.currentIndex);
        rsvpActions.setWpm(playbackState.wpm);
      } else {
        playbackActions.seekTo(rsvpState.currentSegmentIndex);
        playbackActions.setWpm(rsvpState.wpm);
      }
      return next;
    });
  }, [playbackActions, rsvpActions, playbackState.currentIndex, playbackState.wpm, rsvpState.currentSegmentIndex, rsvpState.wpm]);

  /* ---- Progress saver (enabled only after initial seek) ---- */
  // Use the tracked absolute segment_index which survives array shifts from
  // backward prefetch, rather than computing from the array each render.
  const currentSegmentRealIndex = loaderState.segments[activeState.currentIndex]?.segment_index
    ?? trackedSegmentIndexRef.current;

  useProgressSaver({
    publicationId,
    chapterId: currentChapterId,
    segmentIndex: currentSegmentRealIndex,
    wordIndex: readingMode === 'rsvp' ? rsvpState.currentWordIndex : 0,
    wpm: activeState.wpm,
    readingMode,
    enabled: saverEnabled,
  });

  /* ---- Bookmarks & highlights ---- */
  const { bookmarks, addBookmark, removeBookmark, isBookmarked } = useBookmarks(publicationId);

  const currentSegment = loaderState.segments[activeState.currentIndex] ?? null;

  const handleToggleBookmark = useCallback(() => {
    if (!currentChapter) return;
    const seg = loaderState.segments[activeState.currentIndex];
    const segIndex = seg?.segment_index ?? activeState.currentIndex;
    if (isBookmarked(currentChapterId, segIndex)) {
      const bookmark = bookmarks.find(
        (b) => b.chapter_id === currentChapterId && b.segment_index === segIndex,
      );
      if (bookmark) removeBookmark(bookmark.id);
    } else {
      addBookmark(currentChapterId, segIndex);
    }
  }, [
    currentChapter,
    currentChapterId,
    loaderState.segments,
    activeState.currentIndex,
    isBookmarked,
    bookmarks,
    addBookmark,
    removeBookmark,
  ]);

  /* ---- Chapter announcements ---- */
  useEffect(() => {
    if (currentChapter && hasAppliedInitialSeek.current) {
      announce(`Chapter: ${currentChapter.title}`);
    }
  }, [currentChapter, announce]);

  /* ---- Chapter navigation ---- */
  const handlePrevChapter = useCallback(() => {
    if (chapterIdx > 0) {
      setChapterIdx((i) => i - 1);
      activeActions.seekTo(0);
    }
  }, [chapterIdx, activeActions]);

  const handleNextChapter = useCallback(() => {
    if (chapterIdx < chapters.length - 1) {
      setChapterIdx((i) => i + 1);
      activeActions.seekTo(0);
    }
  }, [chapterIdx, chapters.length, activeActions]);

  /* ---- Orientation resilience ---- */
  useOrientationResilience(
    useCallback(() => {
      onSegmentChange(activeState.currentIndex);
    }, [onSegmentChange, activeState.currentIndex]),
  );

  /* ---- Keyboard handling ---- */
  useKeyboardHandling({
    onTogglePlay: activeActions.togglePlayPause,
    onSpeedUp: useCallback(() => activeActions.adjustWpm(25), [activeActions]),
    onSpeedDown: useCallback(() => activeActions.adjustWpm(-25), [activeActions]),
    onNextChunk: useCallback(
      () => activeActions.seekTo(activeState.currentIndex + 1),
      [activeActions, activeState.currentIndex],
    ),
    onPrevChunk: useCallback(
      () => activeActions.seekTo(activeState.currentIndex - 1),
      [activeActions, activeState.currentIndex],
    ),
    onNextChapter: handleNextChapter,
    onPrevChapter: handlePrevChapter,
  });

  /* ---- Signal playing state globally (for fading peripheral UI like ThemeToggle) ---- */
  useEffect(() => {
    document.documentElement.toggleAttribute('data-playing', activeState.isPlaying);
    return () => document.documentElement.removeAttribute('data-playing');
  }, [activeState.isPlaying]);

  /* ---- Render ---- */
  return (
    <div className="reader-viewport" role="main" aria-label="Book reader" id="main-content">
      {isDataSaver && (
        <div className="data-saver-indicator" aria-label="Data saver active">
          Data Saver
        </div>
      )}
      <GestureLayer
        onTap={activeActions.togglePlayPause}
        onSwipeLeft={activeState.isPlaying ? handleNextChapter : undefined}
        onSwipeRight={activeState.isPlaying ? handlePrevChapter : undefined}
        onSwipeUp={activeState.isPlaying ? () => activeActions.adjustWpm(25) : undefined}
        onSwipeDown={activeState.isPlaying ? () => activeActions.adjustWpm(-25) : undefined}
      >
        <FocusChunkOverlay
          segment={currentSegment}
          isPlaying={activeState.isPlaying}
          progress={activeState.progress}
          mode={readingMode}
          rsvpWord={rsvpState.currentWord}
          rsvpOrpIndex={rsvpState.orpIndex}
          rsvpWpm={rsvpState.wpm}
          segments={loaderState.segments}
          currentIndex={activeState.currentIndex}
          onSeek={activeActions.seekTo}
        />
      </GestureLayer>

      <ControlsBottomSheet
        isPlaying={activeState.isPlaying}
        wpm={activeState.wpm}
        progress={activeState.progress}
        onTogglePlay={activeActions.togglePlayPause}
        onSetWpm={activeActions.setWpm}
        onAdjustWpm={activeActions.adjustWpm}
        chapterTitle={currentChapter?.title ?? 'Untitled'}
        onPrevChapter={handlePrevChapter}
        onNextChapter={handleNextChapter}
        hasPrevChapter={chapterIdx > 0}
        hasNextChapter={chapterIdx < chapters.length - 1}
        isCurrentBookmarked={isBookmarked(currentChapterId, currentSegment?.segment_index ?? activeState.currentIndex)}
        onToggleBookmark={handleToggleBookmark}
        mode={readingMode}
        onToggleMode={handleToggleMode}
        onExit={() => navigate('/')}
        chapters={chapters}
        currentChapterIndex={chapterIdx}
        onJumpToChapter={(idx) => {
          setChapterIdx(idx);
          activeActions.seekTo(0);
        }}
        stopAtChapterEnd={stopAtChapterEnd}
        onToggleStopAtChapter={handleToggleStopAtChapter}
      />
    </div>
  );
}
