import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
import { useHighlights } from '../hooks/useHighlights';
import { useDataSaver } from '../hooks/useDataSaver';
import { markNavigationStart, markFirstChunkRendered } from '../lib/ttfcMetric';
import type { Chapter, ReadingProgress } from '../api/client';
import type { ReadingMode } from '../types';
import GestureLayer from './GestureLayer';
import TranscriptPane from './TranscriptPane';
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
  const hasAppliedInitialSeek = useRef(false);
  const autoAdvanceRef = useRef(false);

  const navigate = useNavigate();
  const { announce } = useAnnounce();
  const isDataSaver = useDataSaver();

  const currentChapter = chapters[chapterIdx] ?? null;
  const currentChapterId = currentChapter?.id ?? 0;

  /* ---- Segment loader ---- */
  const [loaderState, loaderActions] = useSegmentLoader({
    publicationId,
    chapterId: currentChapterId,
    dataSaver: isDataSaver,
  });

  useEffect(() => {
    if (loaderState.segments.length > 0) {
      markFirstChunkRendered();
    }
  }, [loaderState.segments]);

  /* ---- Callbacks for engines ---- */
  const onSegmentChange = useCallback(
    (index: number) => {
      loaderActions.checkPrefetch(index);
    },
    [loaderActions],
  );

  const onPlaybackComplete = useCallback(() => {
    if (chapterIdx < chapters.length - 1) {
      autoAdvanceRef.current = true;
      setChapterIdx((i) => i + 1);
      announce(`Next chapter: ${chapters[chapterIdx + 1]?.title ?? ''}`);
    } else {
      announce('Book finished');
    }
  }, [chapterIdx, chapters, announce]);

  /* ---- Playback engines (initialized with correct WPM from the start) ---- */
  const [playbackState, playbackActions] = usePlaybackEngine({
    segments: loaderState.segments,
    initialWpm,
    onSegmentChange,
    onComplete: onPlaybackComplete,
  });

  const [rsvpState, rsvpActions] = useRsvpEngine({
    segments: loaderState.segments,
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

  /* ---- Initial seek: apply once when segments first load ---- */
  useEffect(() => {
    if (hasAppliedInitialSeek.current) return;
    if (loaderState.segments.length === 0) return;

    hasAppliedInitialSeek.current = true;

    if (initialSegmentIndex > 0) {
      const targetIdx = Math.min(initialSegmentIndex, loaderState.segments.length - 1);
      if (import.meta.env.DEV) {
        console.log('[Progress] applying initial seek', { targetIdx, initialWpm });
      }
      playbackActions.seekTo(targetIdx);
      rsvpActions.seekToSegment(targetIdx);
    }

    // Enable saving after the initial seek has been applied.
    // Use a microtask to ensure seek state updates are flushed first.
    Promise.resolve().then(() => setSaverEnabled(true));
  }, [loaderState.segments, initialSegmentIndex, initialWpm, playbackActions, rsvpActions]);

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
  useProgressSaver({
    publicationId,
    chapterId: currentChapterId,
    segmentIndex: activeState.currentIndex,
    wordIndex: readingMode === 'rsvp' ? rsvpState.currentWordIndex : 0,
    wpm: activeState.wpm,
    readingMode,
    enabled: saverEnabled,
  });

  /* ---- Bookmarks & highlights ---- */
  const { bookmarks, addBookmark, removeBookmark, isBookmarked } = useBookmarks(publicationId);
  const { highlights } = useHighlights(publicationId);

  const bookmarkedIndices = useMemo(() => {
    const set = new Set<number>();
    for (const b of bookmarks) {
      if (b.chapter_id === currentChapterId) {
        set.add(b.segment_index);
      }
    }
    return set;
  }, [bookmarks, currentChapterId]);

  const highlightedIndices = useMemo(() => {
    const map = new Map<number, string>();
    for (const h of highlights) {
      if (h.chapter_id === currentChapterId) {
        map.set(h.segment_index, h.color);
      }
    }
    return map;
  }, [highlights, currentChapterId]);

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
        onSwipeLeft={handleNextChapter}
        onSwipeRight={handlePrevChapter}
        onSwipeUp={() => activeActions.adjustWpm(25)}
        onSwipeDown={() => activeActions.adjustWpm(-25)}
      >
        <TranscriptPane
          segments={loaderState.segments}
          currentIndex={activeState.currentIndex}
          onSegmentClick={activeActions.seekTo}
          bookmarkedIndices={bookmarkedIndices}
          highlightedIndices={highlightedIndices}
        />
        <FocusChunkOverlay
          segment={currentSegment}
          isPlaying={activeState.isPlaying}
          progress={activeState.progress}
          mode={readingMode}
          rsvpWord={rsvpState.currentWord}
          rsvpOrpIndex={rsvpState.orpIndex}
          rsvpWpm={rsvpState.wpm}
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
      />
    </div>
  );
}
