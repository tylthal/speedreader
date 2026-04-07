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

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ReaderViewportProps {
  publicationId: number;
}

interface InitialPosition {
  chapters: Chapter[];
  tocTree: TocNode[] | null;
  chapterIdx: number;
  segmentIndex: number;
  wordIndex: number;
  wpm: number;
  readingMode: ReadingMode;
  contentType: ContentType;
  bookTitle: string;
  initialDisplayMode: DisplayMode;
}

interface ActiveReaderProps {
  publicationId: number;
  bookTitle: string;
  chapters: Chapter[];
  tocTree: TocNode[] | null;
  initialChapterIdx: number;
  initialSegmentIndex: number;
  initialWordIndex: number;
  initialWpm: number;
  initialReadingMode: ReadingMode;
  initialDisplayMode: DisplayMode;
  contentType: ContentType;
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
            if (progress.reading_mode === 'rsvp' || progress.reading_mode === 'phrase' || progress.reading_mode === 'scroll' || progress.reading_mode === 'track') {
              readingMode = progress.reading_mode as ReadingMode;
            } else if (progress.reading_mode === 'eyetrack') {
              // Backward compat: old saved progress used 'eyetrack'
              readingMode = 'track';
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

        const initialDisplayMode: DisplayMode =
          pub.display_mode_pref ?? readDefaultDisplayMode();

        setInitState({
          status: 'ready',
          position: {
            chapters: sorted,
            tocTree: pub.toc_tree ?? null,
            chapterIdx,
            segmentIndex,
            wordIndex,
            wpm,
            readingMode,
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
    <ActiveReader
      publicationId={publicationId}
      bookTitle={position.bookTitle}
      chapters={position.chapters}
      tocTree={position.tocTree}
      initialChapterIdx={position.chapterIdx}
      initialSegmentIndex={position.segmentIndex}
      initialWordIndex={position.wordIndex}
      initialWpm={position.wpm}
      initialReadingMode={position.readingMode}
      initialDisplayMode={position.initialDisplayMode}
      contentType={position.contentType}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  ActiveReader — Phase 2: Fully initialized reader                   */
/* ------------------------------------------------------------------ */

function ActiveReader({
  publicationId,
  bookTitle,
  chapters,
  tocTree,
  initialChapterIdx,
  initialSegmentIndex,
  initialWordIndex,
  initialWpm,
  initialReadingMode,
  initialDisplayMode,
  contentType,
}: ActiveReaderProps) {
  const [readingMode, setReadingMode] = useState<ReadingMode>(initialReadingMode);
  const [chapterIdx, setChapterIdx] = useState(initialChapterIdx);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(initialDisplayMode);
  const [tocOpen, setTocOpen] = useState(false);

  // CBZ never shows the formatted-view toggle (PRD §4.5).
  const isImageBook = contentType === 'image';
  // Phrase/RSVP show the phrase/word display only while playing — this is
  // a deliberate refinement of PRD §4.4: when paused in formatted mode, the
  // user gets the full formatted page to browse, then hitting Play snaps
  // back to the phrase/word display from the same segment cursor.
  const phraseLikeMode = readingMode === 'phrase' || readingMode === 'rsvp';

  const handleToggleDisplayMode = useCallback(() => {
    setDisplayMode((prev) => {
      const next: DisplayMode = prev === 'plain' ? 'formatted' : 'plain';
      // Persist per-book preference (best-effort).
      setDisplayModePref(publicationId, next).catch(() => { /* ignore */ });
      return next;
    });
  }, [publicationId]);
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

  /* ---- Scroll engine ---- */
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollItemRefsMap = useRef<Map<number, HTMLDivElement>>(new Map());

  const [scrollState, scrollActions] = useScrollEngine({
    segments: loaderState.segments,
    totalSegments: loaderState.totalSegments,
    containerRef: scrollContainerRef,
    itemOffsetsRef: scrollItemRefsMap,
    initialWpm,
    onSegmentChange,
    onComplete: onPlaybackComplete,
  });

  /* ---- Gaze tracker + track engine ---- */
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
    onSegmentChange,
    onComplete: onPlaybackComplete,
  });

  /* ---- Formatted-view scroll/track variants ---------------------------
   *
   * The focus-mode engines above drive the FocusChunkOverlay teleprompter.
   * When the user is in formatted display mode and switches to scroll or
   * track playback, we want the formatted EPUB page itself to auto-scroll —
   * not the teleprompter. So we spin up a SECOND pair of engines that read
   * a different container ref (the FormattedView scroller), an empty item
   * offsets map (no per-segment DOM exists in formatted view), and the
   * velocity profile populated by FormattedView's ProfileBuilder.
   *
   * These engines are inert until the activeState/activeActions selector
   * below picks them — they only consume CPU when their isPlaying flips
   * true, which never happens until the user is actually playing in
   * formatted+scroll/track mode.
   */
  const formattedViewRef = useRef<FormattedViewHandle>(null);
  // MutableRefObject so we can repoint .current at the FormattedView's
  // scroll container after it mounts. The engines accept this as a
  // RefObject<HTMLDivElement | null>.
  const formattedScrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Empty — the formatted-view variant uses onScrollTick + the velocity
  // profile instead of per-segment item rects. Kept around because the
  // engines' option types still require the field.
  const formattedItemOffsetsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const velocityProfileRef = useRef<VelocityProfile | null>(null);

  // Remember the highest segment index the cursor has reached during the
  // current play session. The section-proportional cursor mapping is
  // positional (it derives index from scroll position within the section),
  // which means a late image load that grows section height would briefly
  // pull the cursor backward. We clamp the cursor to monotonic forward
  // progress while the engine is playing; on pause the cursor is allowed
  // to track scroll position freely so manual scroll-back updates work.
  const formattedCursorMonoRef = useRef(0);

  /**
   * Pure cursor mapping: given a container-relative scroll center, return
   * the segment array index the user is looking at — no monotonic clamp,
   * no side effects. Used both by the engine's onScrollTick (with the
   * clamp wrapper below) and by the manual-scroll listener (without it,
   * because users may legitimately scroll backward while paused).
   *
   * Section-proportional: find where the scroll center sits within the
   * current section's bounding box and interpolate across the loaded
   * segments. Segments come from a plain-text chunker pipeline, not from
   * the EPUB HTML, so there's no reliable mapping from a DOM position to
   * a specific segment. Proportional is approximate but smooth and good
   * enough for progress saving (which only cares about segment_index
   * granularity).
   */
  const computeFormattedCursor = useCallback(
    (centerY: number): number | null => {
      const handle = formattedViewRef.current;
      if (!handle) return null;
      const sectionEl = handle.getSectionEl(chapterIdx);
      const container = handle.getScrollContainer();
      if (!sectionEl || !container) return null;
      const containerRect = container.getBoundingClientRect();
      const sectionRect = sectionEl.getBoundingClientRect();
      // Convert section rect into the same container-relative coordinate
      // space as centerY (which is container.scrollTop + clientHeight/2).
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
    [chapterIdx, loaderState.segments],
  );

  /**
   * Engine-side wrapper that applies the monotonic forward clamp. While
   * playing we never want the cursor to slide backward — late image loads
   * grow the section height, the proportional mapping recomputes lower,
   * and the cursor would otherwise rewind under the scroll. The clamp ref
   * resets in startPlay() so each play session starts fresh.
   */
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
    onSegmentChange,
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
    onSegmentChange,
    onComplete: onPlaybackComplete,
  });

  /**
   * Wrap formatted-mode play/pause so the engine driving flag flips on the
   * imperative handle and image decoding finishes before the engine starts.
   *
   * Play sequence:
   *   1. Reset the monotonic cursor clamp so we don't carry stale state
   *      from a previous play session.
   *   2. Tell FormattedView the engine is now driving — this suppresses the
   *      IntersectionObserver's onVisibleSectionChange feedback so the
   *      engine's scrollTop writes don't loop back through setChapterIdx.
   *   3. Await every <img>.decode() in the current section so layout is
   *      stable before we measure pxPerWeight.
   *   4. Force a profile rebuild from the now-stable layout.
   *   5. Hand off to the engine's real play().
   *
   * Pause is symmetric: stop the engine first, then clear the driving flag.
   *
   * Each engine (scroll, track) gets its own wrapper so togglePlayPause sees
   * the right isPlaying flag.
   */
  const wrapFormattedActions = useCallback(
    (
      raw: typeof formattedScrollActionsRaw,
      isPlaying: boolean,
    ) => {
      const startPlay = () => {
        const handle = formattedViewRef.current;
        formattedCursorMonoRef.current = 0;
        if (!handle) {
          raw.play();
          return;
        }
        if (!formattedScrollContainerRef.current) {
          formattedScrollContainerRef.current = handle.getScrollContainer();
        }
        handle.setEngineDriving(true);
        handle
          .settleImages(chapterIdx)
          .then(() => {
            handle.rebuildProfile();
            raw.play();
          })
          .catch(() => {
            handle.rebuildProfile();
            raw.play();
          });
      };
      const stopPlay = () => {
        raw.pause();
        formattedViewRef.current?.setEngineDriving(false);
      };
      return {
        ...raw,
        play: startPlay,
        pause: stopPlay,
        togglePlayPause: () => {
          if (isPlaying) stopPlay();
          else startPlay();
        },
      };
    },
    [chapterIdx],
  );

  const formattedScrollActions = useMemo(
    () => wrapFormattedActions(formattedScrollActionsRaw, formattedScrollState.isPlaying),
    [wrapFormattedActions, formattedScrollActionsRaw, formattedScrollState.isPlaying],
  );
  const formattedTrackActions = useMemo(
    () => wrapFormattedActions(formattedTrackActionsRaw, formattedTrackState.isPlaying),
    [wrapFormattedActions, formattedTrackActionsRaw, formattedTrackState.isPlaying],
  );

  // Start/stop camera when entering/leaving track mode
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

  // Auto-pause on tracking loss, auto-resume when tracking recovers
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

  // Pause gaze inference when playback is paused to free up CPU for touch scrolling
  useEffect(() => {
    if (readingMode !== 'track') return;
    if (trackState.isPlaying) {
      gazeActions.resumeTracking();
    } else if (!wasPlayingBeforeLost) {
      // Only pause tracking if this isn't a tracking-loss auto-pause
      // (tracking needs to stay on to detect when the user returns)
      gazeActions.pauseTracking();
    }
  }, [readingMode, trackState.isPlaying, wasPlayingBeforeLost, gazeActions]);

  // We need to know which engines are "active" (focus-mode vs formatted-mode
  // variants) before we can compute showFormattedView, but showFormattedView
  // also feeds the engine selection. Resolve in two steps:
  //   1. Compute a tentative showFormattedView from displayMode + isPlaying
  //      against the FOCUS-mode states. This is correct for the phraseLikeMode
  //      exclusion path because phrase/RSVP only have focus-mode engines.
  //   2. Pick activeState/activeActions using the tentative value plus the
  //      reading mode. Scroll/track in formatted view → formatted variants;
  //      everything else → focus variants.
  // The formatted variants are only ever consulted when showFormattedView is
  // true, so the tentative-vs-final distinction never causes a wrong pick.
  const showFormattedView =
    (isImageBook || displayMode === 'formatted') &&
    !(phraseLikeMode && (
      readingMode === 'rsvp' ? rsvpState.isPlaying : playbackState.isPlaying
    ));

  /* ---- Active state/actions based on reading mode + display mode ---- */
  const useFormattedEngines = showFormattedView && (readingMode === 'scroll' || readingMode === 'track');

  const activeState = readingMode === 'rsvp'
    ? {
        currentIndex: rsvpState.currentSegmentIndex,
        isPlaying: rsvpState.isPlaying,
        wpm: rsvpState.wpm,
        progress: rsvpState.progress,
      }
    : readingMode === 'scroll'
    ? (useFormattedEngines ? formattedScrollState : scrollState)
    : readingMode === 'track'
    ? (useFormattedEngines ? formattedTrackState : trackState)
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
    : readingMode === 'scroll'
    ? (useFormattedEngines ? formattedScrollActions : scrollActions)
    : readingMode === 'track'
    ? (useFormattedEngines ? formattedTrackActions : trackActions)
    : playbackActions;

  // Repoint the formatted scroll container ref whenever the formatted view
  // mounts/unmounts. The engine reads .current on every tick so this just
  // needs to be in place before play() runs.
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

  /**
   * Sync the active engine's segment cursor to the user's manual scroll
   * position while paused in formatted view. Without this, the cursor
   * stays wherever it was last set (TOC click, end of last play session,
   * etc.) so pressing Play after a manual scroll resumes from the wrong
   * place. The mapping reuses computeFormattedCursor — same math the
   * engine uses while playing — but skips the monotonic clamp because the
   * user is allowed to scroll backward when paused.
   *
   * The active engine is whichever activeActions.seekTo points at:
   *   - playback mode → playbackActions.seekTo
   *   - rsvp mode    → rsvpActions.seekToSegment
   *   - scroll mode  → formattedScrollActions.seekTo (raw passthrough)
   *   - track mode   → formattedTrackActions.seekTo (raw passthrough)
   * So this works "regardless of mode" as long as the user is in
   * formatted view.
   *
   * rAF-throttled so a flick scroll doesn't fire dozens of seekTo calls
   * per frame; the comparison against the latest currentIndex via a ref
   * prevents re-firing for the same value.
   */
  const activeCurrentIndexRef = useRef(activeState.currentIndex);
  activeCurrentIndexRef.current = activeState.currentIndex;
  const activeSeekToRef = useRef(activeActions.seekTo);
  activeSeekToRef.current = activeActions.seekTo;
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
        if (idx === activeCurrentIndexRef.current) return;
        activeSeekToRef.current(idx);
      });
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
    };
  }, [showFormattedView, activeState.isPlaying, computeFormattedCursor]);

  /**
   * Mid-play handoff between focus-mode and formatted-mode engines.
   *
   * When the user toggles displayMode while a scroll/track engine is
   * playing, the active engine flips from one variant to the other. The
   * outgoing engine is still running its rAF loop against a container ref
   * that's about to disappear (or already has). At minimum we need to pause
   * it cleanly so it stops trying to write scrollTop on a stale element and
   * the engine-driving flag clears.
   *
   * For MVP we don't auto-resume on the incoming engine — the user can hit
   * Play again. This matches how phrase/RSVP behave when displayMode toggles
   * mid-play (no automatic resume). Auto-resume is a fast-follow.
   *
   * Tracks the previous value of useFormattedEngines via a ref so the
   * effect only acts on the actual transition, not on every render.
   */
  const prevUseFormattedRef = useRef(useFormattedEngines);
  useEffect(() => {
    const prev = prevUseFormattedRef.current;
    prevUseFormattedRef.current = useFormattedEngines;
    if (prev === useFormattedEngines) return;

    if (useFormattedEngines) {
      // Just entered formatted view. Pause whichever focus-mode engine
      // was running for the current readingMode.
      if (readingMode === 'scroll' && scrollState.isPlaying) {
        scrollActions.pause();
      } else if (readingMode === 'track' && trackState.isPlaying) {
        trackActions.pause();
      }
    } else {
      // Just left formatted view. Pause the formatted-mode engines via
      // their wrapped pause so setEngineDriving(false) fires.
      if (readingMode === 'scroll' && formattedScrollState.isPlaying) {
        formattedScrollActions.pause();
      } else if (readingMode === 'track' && formattedTrackState.isPlaying) {
        formattedTrackActions.pause();
      }
    }
    // The handoff is keyed solely on useFormattedEngines flipping; the
    // engine isPlaying flags are read at flip time but we don't want the
    // effect to fire every time they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useFormattedEngines]);

  // trackedSegmentIndexRef declared earlier, before chapter change reset

  /* ---- Initial seek: apply once when segments first load ---- */
  useEffect(() => {
    if (hasAppliedInitialSeek.current) return;
    if (loaderState.segments.length === 0) return;

    hasAppliedInitialSeek.current = true;

    // Full chapter is loaded from segment 0. Find the array index
    // matching the saved segment_index and seek both engines there.
    const targetIdx = initialSegmentIndex > 0
      ? loaderState.segments.findIndex((s) => s.segment_index >= initialSegmentIndex)
      : 0;
    const seekIdx = targetIdx !== -1 ? targetIdx : 0;

    // Suppress prefetch during initial seek to avoid unnecessary fetches
    suppressPrefetchRef.current = true;
    if (seekIdx > 0) {
      playbackActions.seekTo(seekIdx);
      rsvpActions.seekToSegment(seekIdx, initialWordIndex);
      scrollActions.seekTo(seekIdx);
      trackActions.seekTo(seekIdx);
    } else if (initialWordIndex > 0) {
      rsvpActions.seekToSegment(0, initialWordIndex);
    }
    suppressPrefetchRef.current = false;
    trackedSegmentIndexRef.current = loaderState.segments[seekIdx]?.segment_index ?? initialSegmentIndex;

    setSaverEnabled(true);
  }, [loaderState.segments, initialSegmentIndex, initialWordIndex, playbackActions, rsvpActions, scrollActions]);

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
      scrollActions.seekTo(newArrayIdx);
      trackActions.seekTo(newArrayIdx);
    }
  }, [loaderState.segments, playbackActions, rsvpActions, scrollActions, trackActions, rsvpState.currentWordIndex]);

  /* ---- Auto-play after chapter auto-advance ---- */
  useEffect(() => {
    if (!hasAppliedInitialSeek.current) return;
    if (autoAdvanceRef.current && loaderState.segments.length > 0) {
      autoAdvanceRef.current = false;
      activeActions.seekTo(0);
      setTimeout(() => activeActions.play(), 300);
    }
  }, [loaderState.segments, activeActions]);

  /* ---- Mode switching (shared logic) ---- */
  const switchToMode = useCallback((next: ReadingMode) => {
    playbackActions.pause();
    rsvpActions.pause();
    scrollActions.pause();
    trackActions.pause();

    // Get current position/wpm from the active engine
    let curIdx: number;
    let curWpm: number;
    const cur = readingMode;
    if (cur === 'rsvp') {
      curIdx = rsvpState.currentSegmentIndex;
      curWpm = rsvpState.wpm;
    } else if (cur === 'scroll') {
      curIdx = scrollState.currentIndex;
      curWpm = scrollState.wpm;
    } else if (cur === 'track') {
      curIdx = trackState.currentIndex;
      curWpm = trackState.wpm;
    } else {
      curIdx = playbackState.currentIndex;
      curWpm = playbackState.wpm;
    }

    // Sync the target engine
    if (next === 'rsvp') {
      rsvpActions.seekToSegment(curIdx);
      rsvpActions.setWpm(curWpm);
    } else if (next === 'scroll') {
      scrollActions.seekTo(curIdx);
      scrollActions.setWpm(curWpm);
    } else if (next === 'track') {
      trackActions.seekTo(curIdx);
      trackActions.setWpm(curWpm);
    } else {
      playbackActions.seekTo(curIdx);
      playbackActions.setWpm(curWpm);
    }

    setReadingMode(next);
  }, [readingMode, playbackActions, rsvpActions, scrollActions, trackActions, playbackState.currentIndex, playbackState.wpm, rsvpState.currentSegmentIndex, rsvpState.wpm, scrollState.currentIndex, scrollState.wpm, trackState.currentIndex, trackState.wpm]);

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

  const currentSegment = loaderState.segments[activeState.currentIndex] ?? null;

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

  /* ---- Keep screen awake during playback ---- */
  useWakeLock(activeState.isPlaying || wasPlayingBeforeLost);

  /* ---- Signal playing state globally (for fading peripheral UI like ThemeToggle) ---- */
  useEffect(() => {
    document.documentElement.toggleAttribute('data-playing', activeState.isPlaying);
    return () => document.documentElement.removeAttribute('data-playing');
  }, [activeState.isPlaying]);

  /* ---- Render ---- */
  // Detect PDF vs HTML formatted view by checking section meta.
  const isPdfBook =
    !isImageBook &&
    chapters.length > 0 &&
    chapters[0].meta != null &&
    typeof (chapters[0].meta as Record<string, unknown>).startPage === 'number';

  // Visible-section callback used by the formatted views.
  const handleVisibleSectionChange = useCallback(
    (idx: number) => {
      if (idx !== chapterIdx) {
        setChapterIdx(idx);
        activeActions.seekTo(0);
      }
    },
    [chapterIdx, activeActions],
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
        currentSectionIndex={chapterIdx}
        onJump={(idx) => {
          setChapterIdx(idx);
          activeActions.seekTo(0);
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
            currentPageIndex={currentSegmentRealIndex}
            onVisiblePageChange={(idx) => {
              if (idx !== currentSegmentRealIndex) {
                activeActions.seekTo(idx);
              }
            }}
            onTap={activeState.isPlaying ? activeActions.pause : undefined}
          />
        ) : isPdfBook ? (
          <PdfFormattedView
            publicationId={publicationId}
            chapters={chapters}
            currentSectionIndex={chapterIdx}
            onVisibleSectionChange={handleVisibleSectionChange}
            onTap={activeState.isPlaying ? activeActions.pause : undefined}
          />
        ) : (
          <>
            <FormattedView
              ref={formattedViewRef}
              publicationId={publicationId}
              chapters={chapters}
              currentSectionIndex={chapterIdx}
              onVisibleSectionChange={handleVisibleSectionChange}
              onTap={activeState.isPlaying ? activeActions.pause : undefined}
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
        onTap={activeState.isPlaying ? activeActions.pause : undefined}
        onSwipeLeft={activeState.isPlaying ? handleNextChapter : undefined}
        onSwipeRight={activeState.isPlaying ? handlePrevChapter : undefined}
        onSwipeUp={activeState.isPlaying ? () => activeActions.adjustWpm(25) : undefined}
        onSwipeDown={activeState.isPlaying ? () => activeActions.adjustWpm(-25) : undefined}
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
          currentIndex={activeState.currentIndex}
          onSeek={activeActions.seekTo}
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
        onTogglePlay={activeActions.togglePlayPause}
        onSetWpm={activeActions.setWpm}
        onAdjustWpm={activeActions.adjustWpm}
        onPrevChapter={handlePrevChapter}
        onNextChapter={handleNextChapter}
        hasPrevChapter={chapterIdx > 0}
        hasNextChapter={chapterIdx < chapters.length - 1}
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
