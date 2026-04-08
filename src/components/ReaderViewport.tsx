import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAnnounce } from '../hooks/useAnnounce';
import { useSegmentLoader } from '../hooks/useSegmentLoader';
import { usePlaybackEngine } from '../hooks/usePlaybackEngine';
import { useRsvpEngine } from '../hooks/useRsvpEngine';
import { useScrollEngine } from '../hooks/useScrollEngine';
import { useTrackEngine } from '../hooks/useTrackEngine';
import { useGazeTracker } from '../hooks/useGazeTracker';
import { useProgressSaver } from '../hooks/useProgressSaver';
import { useOrientationResilience } from '../hooks/useOrientationResilience';
import { useKeyboardHandling } from '../hooks/useKeyboardHandling';
import { useWakeLock } from '../hooks/useWakeLock';
import { useCursorAlignedEngine } from '../hooks/useCursorAlignedEngine';
import { useNavigate } from 'react-router-dom';
import { getPublication, getProgress, setDisplayModePref } from '../api/client';
import { useDataSaver } from '../hooks/useDataSaver';
import { markNavigationStart, markFirstChunkRendered } from '../lib/ttfcMetric';
import type { Chapter, ReadingProgress, TocNode, DisplayMode } from '../api/client';
import { readDefaultDisplayMode } from '../hooks/useDefaultDisplayMode';
import type { ReadingMode } from '../types';
import GestureLayer from './GestureLayer';
import FocusChunkOverlay from './FocusChunkOverlay';
import ControlsBottomSheet from './ControlsBottomSheet';
import GazeIndicator from './GazeIndicator';
import TrackCalibration from './TrackCalibration';
import ReaderHeader from './ReaderHeader';
import TocSidebar from './TocSidebar';
import FormattedView from './FormattedView';
import type { FormattedViewHandle } from './FormattedView';
import VelocityProfileDebugOverlay from './VelocityProfileDebugOverlay';
import PdfFormattedView from './PdfFormattedView';
import CbzFormattedView from './CbzFormattedView';
import type { ContentType } from '../api/client';
import type { VelocityProfile } from '../lib/velocityProfile';
import {
  CursorProvider,
  useCursorDispatch,
  useCursorSelector,
} from '../state/cursor/CursorContext';
import type { CursorRootState } from '../state/cursor/types';
import { initialCursor } from '../state/cursor/types';
import { useRestoreCoordinator } from '../state/cursor/RestoreCoordinator';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ReaderViewportProps {
  publicationId: number;
}

interface InitialPosition {
  chapters: Chapter[];
  tocTree: TocNode[] | null;
  initialCursorRoot: CursorRootState;
  initialWpm: number;
  initialReadingMode: ReadingMode;
  contentType: ContentType;
  bookTitle: string;
  initialDisplayMode: DisplayMode;
}

interface ActiveReaderProps {
  publicationId: number;
  bookTitle: string;
  chapters: Chapter[];
  tocTree: TocNode[] | null;
  initialWpm: number;
  initialReadingMode: ReadingMode;
  initialDisplayMode: DisplayMode;
  contentType: ContentType;
}

const VALID_MODES: ReadingMode[] = ['phrase', 'rsvp', 'scroll', 'track'];
function coerceMode(raw: string): ReadingMode {
  if ((VALID_MODES as readonly string[]).includes(raw)) return raw as ReadingMode;
  if (raw === 'eyetrack') return 'track';
  return 'phrase';
}

/* ------------------------------------------------------------------ */
/*  ReaderViewport — Phase 1: Loading                                  */
/* ------------------------------------------------------------------ */
//
// Phase 1 fetches the publication AND the saved progress synchronously
// so we can construct the cursor's initial state with the right
// chapter+segment before mounting the provider. This is the only place
// we directly read getProgress() — once the provider is up,
// RestoreCoordinator owns the lifecycle.
//
// Pre-launch we don't bother gating on the API; localStorage is read
// inline and we pick the fresher of the two. RestoreCoordinator will
// re-validate after mount but the initial cursor state is already
// correct, so the engines align without ever flashing through zero.

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

        // Pick the fresher of API + localStorage. The duplicate read
        // (RestoreCoordinator does the same) is intentional — we want
        // the initial cursor state correct on the very first render so
        // engines never see a default zero position.
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

        let chapterIdx = 0;
        let absoluteSegmentIndex = 0;
        let wordIndex = 0;
        let wpm = 250;
        let readingMode: ReadingMode = 'phrase';
        let havePosition = false;

        if (progress) {
          const savedChapterIdx = sorted.findIndex(
            (ch) => ch.id === progress!.chapter_id,
          );
          if (savedChapterIdx !== -1) {
            chapterIdx = savedChapterIdx;
            absoluteSegmentIndex = progress.absolute_segment_index;
            wordIndex = progress.word_index ?? 0;
            wpm = progress.wpm;
            readingMode = coerceMode(progress.reading_mode);
            havePosition = true;
          }
        }

        const initialCursorRoot: CursorRootState = havePosition
          ? {
              cursor: {
                ...initialCursor,
                chapterId: sorted[chapterIdx].id,
                chapterIdx,
                absoluteSegmentIndex,
                wordIndex,
                origin: 'restore',
                revision: 1,
              },
              restore: {
                status: 'pending',
                target: {
                  chapterId: sorted[chapterIdx].id,
                  chapterIdx,
                  absoluteSegmentIndex,
                  wordIndex,
                  wpm,
                  readingMode,
                },
                source: progress === apiProgress ? 'api' : 'localStorage',
                error: null,
              },
            }
          : {
              cursor: {
                ...initialCursor,
                chapterId: sorted[0].id,
                chapterIdx: 0,
                origin: 'restore',
                revision: 1,
              },
              restore: {
                status: 'live',
                target: null,
                source: 'none',
                error: null,
              },
            };

        const initialDisplayMode: DisplayMode =
          pub.display_mode_pref ?? readDefaultDisplayMode();

        setInitState({
          status: 'ready',
          position: {
            chapters: sorted,
            tocTree: pub.toc_tree ?? null,
            initialCursorRoot,
            initialWpm: wpm,
            initialReadingMode: readingMode,
            contentType: (pub.content_type ?? 'text') as ContentType,
            bookTitle: pub.title,
            initialDisplayMode,
          },
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
    <CursorProvider initial={position.initialCursorRoot}>
      <ActiveReader
        publicationId={publicationId}
        bookTitle={position.bookTitle}
        chapters={position.chapters}
        tocTree={position.tocTree}
        initialWpm={position.initialWpm}
        initialReadingMode={position.initialReadingMode}
        initialDisplayMode={position.initialDisplayMode}
        contentType={position.contentType}
      />
    </CursorProvider>
  );
}

/* ------------------------------------------------------------------ */
/*  ActiveReader — Phase 2: Fully initialized reader                   */
/* ------------------------------------------------------------------ */
//
// All the cursor reads/writes happen here. Engines no longer own a
// canonical position — they publish to the cursor via onCursorTick and
// receive alignments via useCursorAlignedEngine. Mode switching is
// MODE_SWITCH dispatch + setReadingMode; the engines re-align as a
// side effect of the revision bump.

function ActiveReader({
  publicationId,
  bookTitle,
  chapters,
  tocTree,
  initialWpm,
  initialReadingMode,
  initialDisplayMode,
  contentType,
}: ActiveReaderProps) {
  const dispatch = useCursorDispatch();
  const cursorChapterIdx = useCursorSelector((s) => s.cursor.chapterIdx);
  const cursorAbsIdx = useCursorSelector((s) => s.cursor.absoluteSegmentIndex);
  const cursorWordIdx = useCursorSelector((s) => s.cursor.wordIndex);
  const cursorOrigin = useCursorSelector((s) => s.cursor.origin);
  const cursorRevision = useCursorSelector((s) => s.cursor.revision);
  const restoreStatus = useCursorSelector((s) => s.restore.status);
  const isLive = restoreStatus === 'live';

  const [readingMode, setReadingMode] = useState<ReadingMode>(initialReadingMode);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(initialDisplayMode);
  const [tocOpen, setTocOpen] = useState(false);

  const isImageBook = contentType === 'image';
  const phraseLikeMode = readingMode === 'phrase' || readingMode === 'rsvp';

  const handleToggleDisplayMode = useCallback(() => {
    setDisplayMode((prev) => {
      const next: DisplayMode = prev === 'plain' ? 'formatted' : 'plain';
      setDisplayModePref(publicationId, next).catch(() => { /* ignore */ });
      return next;
    });
  }, [publicationId]);

  const [stopAtChapterEnd, setStopAtChapterEnd] = useState(() => {
    try {
      return localStorage.getItem(`speedreader_stop_at_chapter_${publicationId}`) === '1';
    } catch { return false; }
  });
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

  const currentChapter = chapters[cursorChapterIdx] ?? chapters[0] ?? null;
  const currentChapterId = currentChapter?.id ?? 0;

  /* ---- Segment loader (with translators) ---- */
  const [loaderState, loaderActions, translators] = useSegmentLoader({
    publicationId,
    chapterId: currentChapterId,
    dataSaver: isDataSaver,
  });

  useEffect(() => {
    if (loaderState.segments.length > 0) {
      markFirstChunkRendered();
    }
  }, [loaderState.segments]);

  /* ---- Restore coordinator ---- */
  // Skip the coordinator's own getProgress call — Phase 1 already did
  // it and seeded the initial cursor. We only need the ensure-window +
  // applied + go-live transitions, which fire from the cursor state.
  const ensureWindowFor = useCallback(
    (_chapterId: number, abs: number) => loaderActions.ensureWindowFor(abs),
    [loaderActions],
  );
  useRestoreCoordinator({
    publicationId,
    chapters,
    ensureWindowFor,
  });

  /* ---- Cursor publishers from engine ticks ---- */
  // Wraps the loader prefetch + cursor dispatch into a single callback
  // each engine plugs into. Only fires from rAF tick loops; explicit
  // seeks (alignToCursor below) bypass it so we can never close the
  // engine→cursor→engine feedback loop.
  const onCursorTick = useCallback(
    (arrayIdx: number) => {
      loaderActions.checkPrefetch(arrayIdx);
      const abs = translators.arrayToAbsolute(arrayIdx);
      if (abs == null) return;
      dispatch({
        type: 'ENGINE_TICK',
        payload: { absoluteSegmentIndex: abs },
      });
    },
    [loaderActions, translators, dispatch],
  );

  // onSegmentChange is the legacy prefetch-only path; engines call it
  // from BOTH ticks and seeks. We keep it for prefetch, distinct from
  // onCursorTick (ticks only).
  const onSegmentChangeForPrefetch = useCallback(
    (arrayIdx: number) => {
      loaderActions.checkPrefetch(arrayIdx);
    },
    [loaderActions],
  );

  const onPlaybackComplete = useCallback(() => {
    if (cursorChapterIdx >= chapters.length - 1) {
      announce('Book finished');
      return;
    }
    if (stopAtChapterEndRef.current) {
      announce(`Chapter complete: ${chapters[cursorChapterIdx]?.title ?? ''}`);
      return;
    }
    autoAdvanceRef.current = true;
    const nextIdx = cursorChapterIdx + 1;
    dispatch({
      type: 'CHAPTER_NAV',
      payload: {
        chapterId: chapters[nextIdx].id,
        chapterIdx: nextIdx,
        reset: true,
      },
    });
    announce(`Next chapter: ${chapters[nextIdx]?.title ?? ''}`);
  }, [cursorChapterIdx, chapters, announce, dispatch]);

  /* ---- Playback engines ---- */
  const [playbackState, playbackActions] = usePlaybackEngine({
    segments: loaderState.segments,
    totalSegments: loaderState.totalSegments,
    initialWpm,
    onSegmentChange: onSegmentChangeForPrefetch,
    onCursorTick,
    onComplete: onPlaybackComplete,
  });

  const [rsvpState, rsvpActions] = useRsvpEngine({
    segments: loaderState.segments,
    totalSegments: loaderState.totalSegments,
    initialWpm,
    onSegmentChange: onSegmentChangeForPrefetch,
    onCursorTick,
    onComplete: onPlaybackComplete,
  });

  /* ---- Focus-mode scroll/track engines ---- */
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollItemRefsMap = useRef<Map<number, HTMLDivElement>>(new Map());

  const [scrollState, scrollActions] = useScrollEngine({
    segments: loaderState.segments,
    totalSegments: loaderState.totalSegments,
    containerRef: scrollContainerRef,
    itemOffsetsRef: scrollItemRefsMap,
    initialWpm,
    onSegmentChange: onSegmentChangeForPrefetch,
    onCursorTick,
    onComplete: onPlaybackComplete,
  });

  /* ---- Gaze tracker + focus track engine ---- */
  const [gazeState, gazeRef, gazeActions] = useGazeTracker();
  const [showCalibration, setShowCalibration] = useState(false);
  const [gazeSensitivity, setGazeSensitivity] = useState(1.0);
  const hasCalibrated = useRef(!!(() => { try { return localStorage.getItem('speedreader_gaze_calibration'); } catch { return null; } })());

  const [trackState, trackActions] = useTrackEngine({
    segments: loaderState.segments,
    totalSegments: loaderState.totalSegments,
    containerRef: scrollContainerRef,
    itemOffsetsRef: scrollItemRefsMap,
    gazeRef,
    initialWpm,
    onSegmentChange: onSegmentChangeForPrefetch,
    onCursorTick,
    onComplete: onPlaybackComplete,
  });

  /* ---- Formatted-view scroll/track variants ---- */
  const formattedViewRef = useRef<FormattedViewHandle>(null);
  const formattedScrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Empty — formatted variant uses onScrollTick + the velocity profile
  // instead of per-segment item rects. Required by the engines' option type.
  const formattedItemOffsetsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const velocityProfileRef = useRef<VelocityProfile | null>(null);

  // Monotonic forward clamp for the formatted-mode scroll cursor while
  // playing. Late image loads can grow section height and pull the
  // proportional mapping backward; we lock the cursor to monotonic
  // forward progress per play session. Reset on each play().
  const formattedCursorMonoRef = useRef(0);

  /**
   * Pure cursor mapping: container-relative scroll center → array index
   * within the current section. No clamp, no side effects. Reused by
   * the engine's onScrollTick (with the clamp wrapper) and the
   * pause-time scroll listener (without it).
   */
  const computeFormattedCursor = useCallback(
    (centerY: number): number | null => {
      const handle = formattedViewRef.current;
      if (!handle) return null;
      const sectionEl = handle.getSectionEl(cursorChapterIdx);
      const container = handle.getScrollContainer();
      if (!sectionEl || !container) return null;
      const containerRect = container.getBoundingClientRect();
      const sectionRect = sectionEl.getBoundingClientRect();
      const sectionTop = sectionRect.top - containerRect.top + container.scrollTop;
      const sectionBottom = sectionTop + sectionRect.height;
      if (centerY < sectionTop || centerY >= sectionBottom) return null;
      const segs = loaderState.segments;
      if (segs.length === 0) return null;
      const progress = (centerY - sectionTop) / sectionRect.height;
      return Math.min(
        segs.length - 1,
        Math.max(0, Math.floor(progress * segs.length)),
      );
    },
    [cursorChapterIdx, loaderState.segments],
  );

  const formattedScrollTick = useCallback(
    (centerY: number): number | null => {
      const idx = computeFormattedCursor(centerY);
      if (idx == null) return null;
      const clamped = Math.max(idx, formattedCursorMonoRef.current);
      formattedCursorMonoRef.current = clamped;
      return clamped;
    },
    [computeFormattedCursor],
  );

  const [formattedScrollState, formattedScrollActionsRaw] = useScrollEngine({
    segments: loaderState.segments,
    totalSegments: loaderState.totalSegments,
    containerRef: formattedScrollContainerRef,
    itemOffsetsRef: formattedItemOffsetsRef,
    velocityProfileRef,
    onScrollTick: formattedScrollTick,
    initialWpm,
    onSegmentChange: onSegmentChangeForPrefetch,
    onCursorTick,
    onComplete: onPlaybackComplete,
  });

  const [formattedTrackState, formattedTrackActionsRaw] = useTrackEngine({
    segments: loaderState.segments,
    totalSegments: loaderState.totalSegments,
    containerRef: formattedScrollContainerRef,
    itemOffsetsRef: formattedItemOffsetsRef,
    velocityProfileRef,
    onScrollTick: formattedScrollTick,
    gazeRef,
    initialWpm,
    onSegmentChange: onSegmentChangeForPrefetch,
    onCursorTick,
    onComplete: onPlaybackComplete,
  });

  /**
   * Formatted-mode play wrapper. Settles images and rebuilds the
   * velocity profile before handing off to the engine. Also resets the
   * monotonic forward clamp so each play session starts fresh.
   *
   * Replaces wrapFormattedActions from the pre-cursor-refactor era —
   * the engine-driving flag is gone (the IntersectionObserver consults
   * cursor.origin instead) and the cross-engine seek dance is gone
   * (useCursorAlignedEngine handles alignment).
   */
  const startFormattedPlay = useCallback(
    (raw: { play: () => void }) => {
      formattedCursorMonoRef.current = 0;
      const handle = formattedViewRef.current;
      if (!handle) {
        raw.play();
        return;
      }
      if (!formattedScrollContainerRef.current) {
        formattedScrollContainerRef.current = handle.getScrollContainer();
      }
      handle
        .settleImages(cursorChapterIdx)
        .then(() => {
          handle.rebuildProfile();
          raw.play();
        })
        .catch(() => {
          handle.rebuildProfile();
          raw.play();
        });
    },
    [cursorChapterIdx],
  );

  const formattedScrollActions = useMemo(
    () => ({
      ...formattedScrollActionsRaw,
      play: () => startFormattedPlay(formattedScrollActionsRaw),
      togglePlayPause: () => {
        if (formattedScrollState.isPlaying) formattedScrollActionsRaw.pause();
        else startFormattedPlay(formattedScrollActionsRaw);
      },
    }),
    [formattedScrollActionsRaw, formattedScrollState.isPlaying, startFormattedPlay],
  );
  const formattedTrackActions = useMemo(
    () => ({
      ...formattedTrackActionsRaw,
      play: () => startFormattedPlay(formattedTrackActionsRaw),
      togglePlayPause: () => {
        if (formattedTrackState.isPlaying) formattedTrackActionsRaw.pause();
        else startFormattedPlay(formattedTrackActionsRaw);
      },
    }),
    [formattedTrackActionsRaw, formattedTrackState.isPlaying, startFormattedPlay],
  );

  /* ---- Camera lifecycle for track mode ---- */
  const readingModeRef = useRef(readingMode);
  readingModeRef.current = readingMode;
  useEffect(() => {
    if (readingMode === 'track') {
      gazeActions.start().then((success) => {
        if (success && readingModeRef.current === 'track' && !hasCalibrated.current) {
          setShowCalibration(true);
        }
      });
    } else {
      gazeActions.stop();
      setShowCalibration(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingMode]);

  const [wasPlayingBeforeLost, setWasPlayingBeforeLost] = useState(false);
  useEffect(() => {
    if (readingMode === 'track') {
      if (gazeState.status === 'lost' && trackState.isPlaying) {
        setWasPlayingBeforeLost(true);
        trackActions.pause();
      } else if (gazeState.status === 'tracking' && wasPlayingBeforeLost && !trackState.isPlaying) {
        setWasPlayingBeforeLost(false);
        trackActions.play();
      }
    }
  }, [readingMode, gazeState.status, trackState.isPlaying, trackActions, wasPlayingBeforeLost]);

  useEffect(() => {
    if (readingMode !== 'track') return;
    if (trackState.isPlaying) {
      gazeActions.resumeTracking();
    } else if (!wasPlayingBeforeLost) {
      gazeActions.pauseTracking();
    }
  }, [readingMode, trackState.isPlaying, wasPlayingBeforeLost, gazeActions]);

  /* ---- showFormattedView decision (same heuristic as before) ---- */
  const showFormattedView =
    (isImageBook || displayMode === 'formatted') &&
    !(phraseLikeMode && (
      readingMode === 'rsvp' ? rsvpState.isPlaying : playbackState.isPlaying
    ));

  const useFormattedEngines = showFormattedView && (readingMode === 'scroll' || readingMode === 'track');

  /* ---- alignToCursor wiring (one effect per engine) ---- */
  // Each engine gets a useCursorAlignedEngine call. The seek translates
  // absolute → array index inside the callback so we don't capture a
  // stale array length, and skips when origin === 'engine' to break the
  // feedback loop. `isActive` is set so parked engines don't waste work
  // chasing alignments they'll never play out.

  const alignPlayback = useCallback((abs: number) => {
    const arr = translators.absoluteToArrayIndex(abs);
    if (arr == null) return false;
    playbackActions.seekTo(arr);
    return true;
  }, [translators, playbackActions]);
  useCursorAlignedEngine({
    cursorRevision,
    cursorOrigin,
    cursorAbsoluteIndex: cursorAbsIdx,
    alignToCursor: alignPlayback,
    isLive,
    isActive: readingMode === 'phrase',
  });

  const alignRsvp = useCallback((abs: number, word: number) => {
    const arr = translators.absoluteToArrayIndex(abs);
    if (arr == null) return false;
    rsvpActions.seekToSegment(arr, word);
    return true;
  }, [translators, rsvpActions]);
  useCursorAlignedEngine({
    cursorRevision,
    cursorOrigin,
    cursorAbsoluteIndex: cursorAbsIdx,
    cursorWordIndex: cursorWordIdx,
    alignToCursor: alignRsvp,
    isLive,
    isActive: readingMode === 'rsvp',
  });

  const alignFocusScroll = useCallback((abs: number) => {
    const arr = translators.absoluteToArrayIndex(abs);
    if (arr == null) return false;
    scrollActions.seekTo(arr);
    return true;
  }, [translators, scrollActions]);
  useCursorAlignedEngine({
    cursorRevision,
    cursorOrigin,
    cursorAbsoluteIndex: cursorAbsIdx,
    alignToCursor: alignFocusScroll,
    isLive,
    isActive: readingMode === 'scroll' && !useFormattedEngines,
  });

  const alignFocusTrack = useCallback((abs: number) => {
    const arr = translators.absoluteToArrayIndex(abs);
    if (arr == null) return false;
    trackActions.seekTo(arr);
    return true;
  }, [translators, trackActions]);
  useCursorAlignedEngine({
    cursorRevision,
    cursorOrigin,
    cursorAbsoluteIndex: cursorAbsIdx,
    alignToCursor: alignFocusTrack,
    isLive,
    isActive: readingMode === 'track' && !useFormattedEngines,
  });

  const alignFormattedScroll = useCallback((abs: number) => {
    const arr = translators.absoluteToArrayIndex(abs);
    if (arr == null) return false;
    formattedScrollActionsRaw.seekTo(arr);
    return true;
  }, [translators, formattedScrollActionsRaw]);
  useCursorAlignedEngine({
    cursorRevision,
    cursorOrigin,
    cursorAbsoluteIndex: cursorAbsIdx,
    alignToCursor: alignFormattedScroll,
    isLive,
    isActive: readingMode === 'scroll' && useFormattedEngines,
  });

  const alignFormattedTrack = useCallback((abs: number) => {
    const arr = translators.absoluteToArrayIndex(abs);
    if (arr == null) return false;
    formattedTrackActionsRaw.seekTo(arr);
    return true;
  }, [translators, formattedTrackActionsRaw]);
  useCursorAlignedEngine({
    cursorRevision,
    cursorOrigin,
    cursorAbsoluteIndex: cursorAbsIdx,
    alignToCursor: alignFormattedTrack,
    isLive,
    isActive: readingMode === 'track' && useFormattedEngines,
  });

  /* ---- activeState/activeActions ---- */
  // The "active" engine is the one currently rendering UI. Reads
  // current array index from the cursor selector so the rest of the
  // component doesn't have to know which engine variant is in use.
  const activeArrayIdx = useMemo(() => {
    return translators.absoluteToArrayIndex(cursorAbsIdx) ?? 0;
  }, [translators, cursorAbsIdx, loaderState.segments]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeState = readingMode === 'rsvp'
    ? {
        currentIndex: activeArrayIdx,
        isPlaying: rsvpState.isPlaying,
        wpm: rsvpState.wpm,
        progress: rsvpState.progress,
      }
    : readingMode === 'scroll'
    ? (useFormattedEngines
        ? { ...formattedScrollState, currentIndex: activeArrayIdx }
        : { ...scrollState, currentIndex: activeArrayIdx })
    : readingMode === 'track'
    ? (useFormattedEngines
        ? { ...formattedTrackState, currentIndex: activeArrayIdx }
        : { ...trackState, currentIndex: activeArrayIdx })
    : { ...playbackState, currentIndex: activeArrayIdx };

  const activeActions = readingMode === 'rsvp'
    ? {
        play: rsvpActions.play,
        pause: rsvpActions.pause,
        togglePlayPause: rsvpActions.togglePlayPause,
        seekTo: (idx: number) => {
          const abs = translators.arrayToAbsolute(idx);
          if (abs == null) return;
          dispatch({
            type: 'USER_SEEK',
            payload: { absoluteSegmentIndex: abs },
          });
        },
        setWpm: rsvpActions.setWpm,
        adjustWpm: rsvpActions.adjustWpm,
      }
    : readingMode === 'scroll'
    ? (useFormattedEngines ? formattedScrollActions : scrollActions)
    : readingMode === 'track'
    ? (useFormattedEngines ? formattedTrackActions : trackActions)
    : playbackActions;

  // Wrap the non-RSVP active engines' seekTo so it goes through cursor
  // dispatch (USER_SEEK) instead of jumping the engine directly. The
  // align effect then drives the engine, ensuring every other engine
  // tracks the same absolute position.
  const wrappedActiveActions = useMemo(() => {
    if (readingMode === 'rsvp') return activeActions;
    return {
      ...activeActions,
      seekTo: (idx: number) => {
        const abs = translators.arrayToAbsolute(idx);
        if (abs == null) return;
        dispatch({
          type: 'USER_SEEK',
          payload: { absoluteSegmentIndex: abs },
        });
      },
    };
  }, [activeActions, readingMode, translators, dispatch]);

  /* ---- Repoint formatted scroll container ref ---- */
  useEffect(() => {
    if (!showFormattedView) {
      formattedScrollContainerRef.current = null;
      return;
    }
    const handle = formattedViewRef.current;
    if (handle) {
      formattedScrollContainerRef.current = handle.getScrollContainer();
    }
  }, [showFormattedView]);

  /* ---- Pause-mode scroll listener (USER_SCROLL dispatcher) ---- */
  useEffect(() => {
    if (!showFormattedView) return;
    if (activeState.isPlaying) return;
    const handle = formattedViewRef.current;
    if (!handle) return;
    const container = handle.getScrollContainer();
    if (!container) return;

    let rafScheduled = false;
    const onScroll = () => {
      if (rafScheduled) return;
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        const centerY = container.scrollTop + container.clientHeight / 2;
        const idx = computeFormattedCursor(centerY);
        if (idx == null) return;
        const abs = translators.arrayToAbsolute(idx);
        if (abs == null) return;
        if (abs === cursorAbsIdx) return;
        dispatch({
          type: 'USER_SCROLL',
          payload: { absoluteSegmentIndex: abs },
        });
      });
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
    };
  }, [
    showFormattedView,
    activeState.isPlaying,
    computeFormattedCursor,
    translators,
    cursorAbsIdx,
    dispatch,
  ]);

  /* ---- Auto-play after chapter auto-advance ---- */
  useEffect(() => {
    if (!isLive) return;
    if (autoAdvanceRef.current && loaderState.segments.length > 0) {
      autoAdvanceRef.current = false;
      // The cursor is already at abs=0 of the new chapter (from
      // CHAPTER_NAV in onPlaybackComplete). All engines will have
      // aligned via useCursorAlignedEngine. Just resume playback.
      setTimeout(() => wrappedActiveActions.play(), 300);
    }
  }, [loaderState.segments, isLive, wrappedActiveActions]);

  /* ---- Mode switching: dispatch + setReadingMode ---- */
  // No more cross-engine seekTo. The cursor stays put; MODE_SWITCH
  // bumps revision so the newly-active engine's useCursorAlignedEngine
  // effect picks up alignment. Old engines pause via the explicit
  // pause calls below.
  const switchToMode = useCallback((next: ReadingMode) => {
    playbackActions.pause();
    rsvpActions.pause();
    scrollActions.pause();
    trackActions.pause();
    formattedScrollActionsRaw.pause();
    formattedTrackActionsRaw.pause();

    // Carry wpm forward to the engine pair the new mode will use.
    const curWpm = activeState.wpm;
    if (next === 'rsvp') {
      rsvpActions.setWpm(curWpm);
    } else if (next === 'scroll') {
      scrollActions.setWpm(curWpm);
      formattedScrollActionsRaw.setWpm(curWpm);
    } else if (next === 'track') {
      trackActions.setWpm(curWpm);
      formattedTrackActionsRaw.setWpm(curWpm);
    } else {
      playbackActions.setWpm(curWpm);
    }

    dispatch({ type: 'MODE_SWITCH' });
    setReadingMode(next);
  }, [
    activeState.wpm,
    playbackActions,
    rsvpActions,
    scrollActions,
    trackActions,
    formattedScrollActionsRaw,
    formattedTrackActionsRaw,
    dispatch,
  ]);

  const handleToggleMode = useCallback(() => {
    const modeOrder: ReadingMode[] = ['phrase', 'rsvp', 'scroll', 'track'];
    const next = modeOrder[(modeOrder.indexOf(readingMode) + 1) % modeOrder.length];
    switchToMode(next);
  }, [readingMode, switchToMode]);

  const handleSetMode = useCallback((target: ReadingMode) => {
    if (target !== readingMode) {
      switchToMode(target);
    }
  }, [readingMode, switchToMode]);

  /* ---- Progress saver ---- */
  // Reads from cursor + restore state via context; the only props are
  // the things the cursor doesn't carry (wpm, readingMode, getLiveWordIndex).
  useProgressSaver({
    publicationId,
    wpm: activeState.wpm,
    readingMode,
    getLiveWordIndex: rsvpActions.getLiveWordIndex,
  });

  const currentSegment = loaderState.segments[activeArrayIdx] ?? null;

  /* ---- Chapter announcements ---- */
  useEffect(() => {
    if (currentChapter && isLive) {
      announce(`Chapter: ${currentChapter.title}`);
    }
  }, [currentChapter, announce, isLive]);

  /* ---- Chapter navigation (TOC, prev/next) ---- */
  // Dispatch dispatches the cursor; engines align; in formatted view,
  // a separate effect below scrolls the section into view.
  const navigateToSection = useCallback((idx: number) => {
    if (idx < 0 || idx >= chapters.length) return;
    dispatch({
      type: 'TOC_JUMP',
      payload: {
        chapterId: chapters[idx].id,
        chapterIdx: idx,
        absoluteSegmentIndex: 0,
      },
    });
  }, [chapters, dispatch]);

  // Scroll the formatted view into view whenever the cursor lands on a
  // new chapter via something other than a user scroll. The previous
  // beginProgrammaticScroll guard is gone — the IntersectionObserver
  // inside FormattedView still suppresses its own programmatic-scroll
  // echo via scrollSectionIntoView's internal flag.
  const lastScrolledChapterIdxRef = useRef<number>(-1);
  useEffect(() => {
    if (!showFormattedView) return;
    if (cursorOrigin === 'user-scroll') return;
    if (cursorOrigin === 'engine') return;
    if (lastScrolledChapterIdxRef.current === cursorChapterIdx) return;
    lastScrolledChapterIdxRef.current = cursorChapterIdx;
    requestAnimationFrame(() => {
      formattedViewRef.current?.scrollSectionIntoView(cursorChapterIdx);
    });
  }, [showFormattedView, cursorChapterIdx, cursorOrigin, cursorRevision]);

  const handlePrevChapter = useCallback(() => {
    if (cursorChapterIdx > 0) {
      navigateToSection(cursorChapterIdx - 1);
    }
  }, [cursorChapterIdx, navigateToSection]);

  const handleNextChapter = useCallback(() => {
    if (cursorChapterIdx < chapters.length - 1) {
      navigateToSection(cursorChapterIdx + 1);
    }
  }, [cursorChapterIdx, chapters.length, navigateToSection]);

  /* ---- Orientation resilience ---- */
  useOrientationResilience(
    useCallback(() => {
      onSegmentChangeForPrefetch(activeArrayIdx);
    }, [onSegmentChangeForPrefetch, activeArrayIdx]),
  );

  /* ---- Keyboard handling ---- */
  useKeyboardHandling({
    onTogglePlay: wrappedActiveActions.togglePlayPause,
    onSpeedUp: useCallback(() => wrappedActiveActions.adjustWpm(25), [wrappedActiveActions]),
    onSpeedDown: useCallback(() => wrappedActiveActions.adjustWpm(-25), [wrappedActiveActions]),
    onNextChunk: useCallback(
      () => wrappedActiveActions.seekTo(activeArrayIdx + 1),
      [wrappedActiveActions, activeArrayIdx],
    ),
    onPrevChunk: useCallback(
      () => wrappedActiveActions.seekTo(activeArrayIdx - 1),
      [wrappedActiveActions, activeArrayIdx],
    ),
    onNextChapter: handleNextChapter,
    onPrevChapter: handlePrevChapter,
  });

  /* ---- Wake lock ---- */
  useWakeLock(activeState.isPlaying || wasPlayingBeforeLost);

  /* ---- Global playing attribute (for ThemeToggle fade) ---- */
  useEffect(() => {
    document.documentElement.toggleAttribute('data-playing', activeState.isPlaying);
    return () => document.documentElement.removeAttribute('data-playing');
  }, [activeState.isPlaying]);

  /* ---- Render ---- */
  const isPdfBook =
    !isImageBook &&
    chapters.length > 0 &&
    chapters[0].meta != null &&
    typeof (chapters[0].meta as Record<string, unknown>).startPage === 'number';

  // FormattedView's IntersectionObserver fires on scroll-to-different-section.
  // Convert to a CHAPTER_NAV dispatch.
  const handleVisibleSectionChange = useCallback(
    (idx: number) => {
      if (idx === cursorChapterIdx) return;
      dispatch({
        type: 'CHAPTER_NAV',
        payload: {
          chapterId: chapters[idx].id,
          chapterIdx: idx,
          reset: true,
        },
      });
    },
    [cursorChapterIdx, chapters, dispatch],
  );

  return (
    <div className="reader-viewport" role="main" aria-label="Book reader" id="main-content">
      <ReaderHeader
        bookTitle={bookTitle}
        sectionTitle={currentChapter?.title ?? 'Untitled'}
        displayMode={displayMode}
        onToggleDisplayMode={isImageBook ? undefined : handleToggleDisplayMode}
        hideDisplayToggle={isImageBook}
        onOpenToc={() => setTocOpen(true)}
        onExit={() => navigate('/')}
      />
      <TocSidebar
        open={tocOpen}
        chapters={chapters}
        tocTree={tocTree}
        currentSectionIndex={cursorChapterIdx}
        onJump={(idx) => {
          navigateToSection(idx);
        }}
        onClose={() => setTocOpen(false)}
      />
      {isDataSaver && (
        <div className="data-saver-indicator" aria-label="Data saver active">
          Data Saver
        </div>
      )}

      {showFormattedView && (
        isImageBook ? (
          <CbzFormattedView
            publicationId={publicationId}
            chapterId={currentChapterId}
            totalPages={chapters[0]?.meta && typeof (chapters[0].meta as any).pageCount === 'number'
              ? (chapters[0].meta as any).pageCount as number
              : 9999}
            currentPageIndex={cursorAbsIdx}
            onVisiblePageChange={(idx) => {
              if (idx !== cursorAbsIdx) {
                dispatch({
                  type: 'USER_SEEK',
                  payload: { absoluteSegmentIndex: idx },
                });
              }
            }}
            onTap={activeState.isPlaying ? wrappedActiveActions.pause : undefined}
          />
        ) : isPdfBook ? (
          <PdfFormattedView
            publicationId={publicationId}
            chapters={chapters}
            currentSectionIndex={cursorChapterIdx}
            onVisibleSectionChange={handleVisibleSectionChange}
            onTap={activeState.isPlaying ? wrappedActiveActions.pause : undefined}
          />
        ) : (
          <>
            <FormattedView
              ref={formattedViewRef}
              publicationId={publicationId}
              chapters={chapters}
              currentSectionIndex={cursorChapterIdx}
              onVisibleSectionChange={handleVisibleSectionChange}
              onTap={activeState.isPlaying ? wrappedActiveActions.pause : undefined}
              velocityProfileRef={velocityProfileRef}
            />
            <VelocityProfileDebugOverlay
              formattedViewRef={formattedViewRef}
              velocityProfileRef={velocityProfileRef}
              wpm={activeState.wpm}
            />
          </>
        )
      )}

      {!showFormattedView && (
      <GestureLayer
        onTap={activeState.isPlaying ? wrappedActiveActions.pause : undefined}
        onSwipeLeft={activeState.isPlaying ? handleNextChapter : undefined}
        onSwipeRight={activeState.isPlaying ? handlePrevChapter : undefined}
        onSwipeUp={activeState.isPlaying ? () => wrappedActiveActions.adjustWpm(25) : undefined}
        onSwipeDown={activeState.isPlaying ? () => wrappedActiveActions.adjustWpm(-25) : undefined}
        enabled={activeState.isPlaying}
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
          currentIndex={activeArrayIdx}
          onSeek={wrappedActiveActions.seekTo}
          scrollContainerRef={scrollContainerRef}
          scrollItemRefs={scrollItemRefsMap}
        />
      </GestureLayer>
      )}

      {readingMode === 'track' && gazeState.status !== 'idle' && activeState.isPlaying && (
        <GazeIndicator
          direction={gazeState.direction}
          intensity={gazeState.intensity}
          status={gazeState.status}
          debugPitch={gazeState.debugPitch}
          debugNormalized={gazeState.debugNormalized}
        />
      )}

      {showCalibration && (
        <TrackCalibration
          onComplete={() => { setShowCalibration(false); hasCalibrated.current = true; }}
          onSkip={() => { setShowCalibration(false); hasCalibrated.current = true; }}
          onCalibratePoint={gazeActions.calibratePoint}
          onFinish={gazeActions.finishCalibration}
        />
      )}

      {readingMode === 'track' && gazeState.status === 'lost' && wasPlayingBeforeLost && (
        <div className="gaze-resume-overlay" role="status">
          <div className="gaze-resume-overlay__content">
            {gazeState.resumeCountdown > 0 ? (
              <>
                <span className="gaze-resume-overlay__title">Resuming...</span>
                <span className="gaze-resume-overlay__countdown">{gazeState.resumeCountdown}</span>
                <span className="gaze-resume-overlay__message">Keep looking at the screen</span>
              </>
            ) : (
              <>
                <span className="gaze-resume-overlay__title">Reading paused</span>
                <span className="gaze-resume-overlay__message">Look back at the screen to resume</span>
              </>
            )}
          </div>
        </div>
      )}

      {readingMode === 'track' && gazeState.status === 'error' && (
        <div className="gaze-error-overlay" role="alert">
          <div className="gaze-error-overlay__content">
            <span className="gaze-error-overlay__title">Camera unavailable</span>
            <span className="gaze-error-overlay__message">{gazeState.error}</span>
            <button
              className="gaze-error-overlay__btn"
              onClick={handleToggleMode}
            >
              Switch mode
            </button>
            <button
              className="gaze-error-overlay__retry"
              onClick={() => gazeActions.start()}
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {readingMode === 'track' && (gazeState.status === 'requesting' || gazeState.status === 'loading_model') && (
        <div className="gaze-error-overlay" role="status">
          <div className="gaze-error-overlay__content">
            <span className="gaze-error-overlay__title">
              {gazeState.status === 'requesting' ? 'Starting camera...' : 'Loading tracking model...'}
            </span>
            <span className="gaze-error-overlay__message">
              {gazeState.status === 'requesting'
                ? 'Please allow camera access when prompted.'
                : 'Downloading model files. This may take a moment on first use.'}
            </span>
          </div>
        </div>
      )}

      <ControlsBottomSheet
        isPlaying={activeState.isPlaying || wasPlayingBeforeLost}
        wpm={activeState.wpm}
        progress={activeState.progress}
        onTogglePlay={wrappedActiveActions.togglePlayPause}
        onSetWpm={wrappedActiveActions.setWpm}
        onAdjustWpm={wrappedActiveActions.adjustWpm}
        onPrevChapter={handlePrevChapter}
        onNextChapter={handleNextChapter}
        hasPrevChapter={cursorChapterIdx > 0}
        hasNextChapter={cursorChapterIdx < chapters.length - 1}
        mode={readingMode}
        onToggleMode={handleToggleMode}
        onSetMode={handleSetMode}
        stopAtChapterEnd={stopAtChapterEnd}
        onToggleStopAtChapter={handleToggleStopAtChapter}
        gazeSensitivity={gazeSensitivity}
        onGazeSensitivityChange={(val) => { setGazeSensitivity(val); gazeActions.setSensitivity(val); }}
        onRecalibrate={() => {
          hasCalibrated.current = false;
          try { localStorage.removeItem('speedreader_gaze_calibration'); } catch {}
          setShowCalibration(true);
        }}
      />
    </div>
  );
}
