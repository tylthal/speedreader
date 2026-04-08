import { useState, useEffect, useCallback, useRef } from 'react';
import { useAnnounce } from '../hooks/useAnnounce';
import { useSegmentLoader } from '../hooks/useSegmentLoader';
import { usePlaybackController } from '../hooks/usePlaybackController';
import { useGazeTracker } from '../hooks/useGazeTracker';
import { useProgressSaver } from '../hooks/useProgressSaver';
import { useOrientationResilience } from '../hooks/useOrientationResilience';
import { useKeyboardHandling } from '../hooks/useKeyboardHandling';
import { useWakeLock } from '../hooks/useWakeLock';
import { useNavigate } from 'react-router-dom';
import { getPublication, getProgress, setDisplayModePref } from '../api/client';
import { useDataSaver } from '../hooks/useDataSaver';
import { markNavigationStart, markFirstChunkRendered } from '../lib/ttfcMetric';
import type { Chapter, ReadingProgress, TocNode, DisplayMode as ApiDisplayMode } from '../api/client';
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
  positionStore,
  usePositionSelector,
} from '../state/position/positionStore';
import type { DisplayMode } from '../state/position/types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ReaderViewportProps {
  publicationId: number;
}

interface InitialPosition {
  chapters: Chapter[];
  tocTree: TocNode[] | null;
  contentType: ContentType;
  bookTitle: string;
}

interface ActiveReaderProps {
  publicationId: number;
  bookTitle: string;
  chapters: Chapter[];
  tocTree: TocNode[] | null;
  contentType: ContentType;
}

const VALID_MODES: ReadingMode[] = ['phrase', 'rsvp', 'scroll', 'track'];
function coerceMode(raw: string): ReadingMode {
  if ((VALID_MODES as readonly string[]).includes(raw)) return raw as ReadingMode;
  if (raw === 'eyetrack') return 'track';
  return 'phrase';
}

/* ------------------------------------------------------------------ */
/*  ReaderViewport — Phase 1: load + seed positionStore                */
/* ------------------------------------------------------------------ */
//
// Phase 1 fetches publication + saved progress and writes the result
// directly into positionStore via positionStore.init() before mounting
// ActiveReader. There is no provider, no context, no restore state
// machine — the store is module-scope and ActiveReader reads from it
// via usePositionSelector. Phase 1 must complete before ActiveReader
// mounts so the very first render of ActiveReader sees the restored
// position; this is what the old RestoreCoordinator approximated with
// its 4-phase machine.

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

        // Pick the fresher of API + localStorage. localStorage is read
        // synchronously here so we can seed the store before mount and
        // avoid a flash at chapter 0.
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
          }
        }

        const initialDisplayMode: ApiDisplayMode =
          pub.display_mode_pref ?? readDefaultDisplayMode();

        // Seed the store *before* mounting ActiveReader so the first
        // render reads the restored values. revision stays at 0 so the
        // saver gate (revision > 0) doesn't fire on the seed itself.
        positionStore.init({
          chapterId: sorted[chapterIdx].id,
          chapterIdx,
          absoluteSegmentIndex,
          wordIndex,
          wpm,
          mode: readingMode,
          displayMode: initialDisplayMode as DisplayMode,
          isPlaying: false,
        });

        setInitState({
          status: 'ready',
          position: {
            chapters: sorted,
            tocTree: pub.toc_tree ?? null,
            contentType: (pub.content_type ?? 'text') as ContentType,
            bookTitle: pub.title,
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
      contentType={position.contentType}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  ActiveReader — Phase 2: rendering                                  */
/* ------------------------------------------------------------------ */
//
// One controller. No engine pairs, no align effects, no
// activeState/activeActions dispatch tables. ReaderViewport reads
// position from the store and dispatches changes through the controller
// or directly via positionStore.setPosition.

function ActiveReader({
  publicationId,
  bookTitle,
  chapters,
  tocTree,
  contentType,
}: ActiveReaderProps) {
  const chapterIdx = usePositionSelector((s) => s.chapterIdx);
  const absoluteSegmentIndex = usePositionSelector((s) => s.absoluteSegmentIndex);
  const isPlaying = usePositionSelector((s) => s.isPlaying);
  const wpm = usePositionSelector((s) => s.wpm);
  const readingMode = usePositionSelector((s) => s.mode);
  const displayMode = usePositionSelector((s) => s.displayMode);
  const cursorOrigin = usePositionSelector((s) => s.origin);
  const cursorRevision = usePositionSelector((s) => s.revision);

  const [tocOpen, setTocOpen] = useState(false);

  const isImageBook = contentType === 'image';
  const phraseLikeMode = readingMode === 'phrase' || readingMode === 'rsvp';

  const handleToggleDisplayMode = useCallback(() => {
    const next: DisplayMode = displayMode === 'plain' ? 'formatted' : 'plain';
    positionStore.setDisplayMode(next);
    setDisplayModePref(publicationId, next).catch(() => { /* ignore */ });
  }, [displayMode, publicationId]);

  const [stopAtChapterEnd, setStopAtChapterEnd] = useState(() => {
    try {
      return localStorage.getItem(`speedreader_stop_at_chapter_${publicationId}`) === '1';
    } catch { return false; }
  });
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

  const currentChapter = chapters[chapterIdx] ?? chapters[0] ?? null;
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

  /* ---- Refs handed to the controller ---- */
  const focusContainerRef = useRef<HTMLDivElement>(null);
  const focusItemRefsMap = useRef<Map<number, HTMLDivElement>>(new Map());
  const formattedViewRef = useRef<FormattedViewHandle>(null);
  const velocityProfileRef = useRef<VelocityProfile | null>(null);

  /* ---- Layout-version counter for the formatted view ---- */
  // FormattedView writes its body innerHTML in a useEffect that depends
  // on an async image loader, so on first mount the section heights
  // reflect only the title h1 — any auto-scroll computed at that
  // moment lands at the wrong offset. We bump this version every time
  // the velocity profile rebuilds (which fires after innerHTML lands
  // and on every ResizeObserver settle), and the auto-scroll +
  // highlight effects depend on it so they re-run against the real
  // geometry.
  const [layoutVersion, setLayoutVersion] = useState(0);
  const onFormattedLayoutChange = useCallback(() => {
    setLayoutVersion((v) => v + 1);
  }, []);

  /* ---- Gaze tracker ---- */
  const [gazeState, gazeRef, gazeActions] = useGazeTracker();
  const [showCalibration, setShowCalibration] = useState(false);
  const [gazeSensitivity, setGazeSensitivity] = useState(1.0);
  const hasCalibrated = useRef(!!(() => { try { return localStorage.getItem('speedreader_gaze_calibration'); } catch { return null; } })());

  /* ---- The single playback controller ---- */
  const handleAutoAdvance = useCallback(() => {
    const nextIdx = positionStore.getSnapshot().chapterIdx + 1;
    if (nextIdx >= chapters.length) {
      announce('Book finished');
      return;
    }
    if (stopAtChapterEndRef.current) {
      announce(`Chapter complete: ${chapters[nextIdx - 1]?.title ?? ''}`);
      return;
    }
    // Move the cursor to the next chapter, then resume play. The
    // controller will see the new chapter on its next tick and start
    // ticking from absoluteSegmentIndex=0 of the new chapter.
    autoAdvanceRef.current = true;
    positionStore.setPosition(
      {
        chapterId: chapters[nextIdx].id,
        chapterIdx: nextIdx,
        absoluteSegmentIndex: 0,
        wordIndex: 0,
      },
      'chapter-nav',
    );
    announce(`Next chapter: ${chapters[nextIdx]?.title ?? ''}`);
  }, [chapters, announce]);

  const autoAdvanceRef = useRef(false);
  const onPrefetchHint = useCallback(
    (arrayIdx: number) => {
      loaderActions.checkPrefetch(arrayIdx);
    },
    [loaderActions],
  );

  const controller = usePlaybackController({
    segments: loaderState.segments,
    totalSegments: loaderState.totalSegments,
    translators,
    focusContainerRef,
    focusItemOffsetsRef: focusItemRefsMap,
    formattedViewRef,
    velocityProfileRef,
    gazeRef,
    onPrefetchHint,
    onComplete: handleAutoAdvance,
  });

  /* ---- Auto-play after auto-advance ---- */
  // Fired by handleAutoAdvance via autoAdvanceRef. Wait for the new
  // chapter's segments to load (loader effect re-runs on chapter change),
  // then call play(). No 300ms timeout — the controller reads position
  // from the store at play time, so it automatically picks up the new
  // chapter's abs=0.
  useEffect(() => {
    if (!autoAdvanceRef.current) return;
    if (loaderState.segments.length === 0) return;
    autoAdvanceRef.current = false;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) controller.play();
    });
    return () => {
      cancelled = true;
    };
  }, [loaderState.segments, controller]);

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
    if (readingMode !== 'track') return;
    if (gazeState.status === 'lost' && isPlaying) {
      setWasPlayingBeforeLost(true);
      controller.pause();
    } else if (gazeState.status === 'tracking' && wasPlayingBeforeLost && !isPlaying) {
      setWasPlayingBeforeLost(false);
      controller.play();
    }
  }, [readingMode, gazeState.status, isPlaying, controller, wasPlayingBeforeLost]);

  useEffect(() => {
    if (readingMode !== 'track') return;
    if (isPlaying) {
      gazeActions.resumeTracking();
    } else if (!wasPlayingBeforeLost) {
      gazeActions.pauseTracking();
    }
  }, [readingMode, isPlaying, wasPlayingBeforeLost, gazeActions]);

  /* ---- showFormattedView decision ---- */
  // Phrase/RSVP show their focus display while playing; when paused
  // they fall back to the formatted view if the user prefers it.
  const showFormattedView =
    (isImageBook || displayMode === 'formatted') &&
    !(phraseLikeMode && isPlaying);

  /* ---- activeArrayIdx — single derived value the UI consumes ---- */
  const activeArrayIdx =
    translators.absoluteToArrayIndex(absoluteSegmentIndex) ?? 0;
  const currentSegment = loaderState.segments[activeArrayIdx] ?? null;

  /* ---- Mode switching: just dispatch ---- */
  // pause + setMode. The controller's tick reads mode from the store
  // each frame; no per-mode seek, no carry-wpm dance, no align effects.
  const switchToMode = useCallback((next: ReadingMode) => {
    controller.pause();
    positionStore.setMode(next);
  }, [controller]);

  const handleToggleMode = useCallback(() => {
    const modeOrder: ReadingMode[] = ['phrase', 'rsvp', 'scroll', 'track'];
    const next = modeOrder[(modeOrder.indexOf(readingMode) + 1) % modeOrder.length];
    switchToMode(next);
  }, [readingMode, switchToMode]);

  const handleSetMode = useCallback((target: ReadingMode) => {
    if (target !== readingMode) switchToMode(target);
  }, [readingMode, switchToMode]);

  /* ---- Progress saver ---- */
  // Reads cursor + restore state from the store directly. Gate is
  // revision > 0 — the seed init() leaves revision at 0 so the saver
  // never overwrites the restored value before the user has interacted.
  useProgressSaver({ publicationId });

  /* ---- Chapter announcements ---- */
  useEffect(() => {
    if (currentChapter && cursorRevision > 0) {
      announce(`Chapter: ${currentChapter.title}`);
    }
  }, [currentChapter, announce, cursorRevision]);

  /* ---- Chapter navigation (TOC, prev/next) ---- */
  const navigateToSection = useCallback((idx: number) => {
    if (idx < 0 || idx >= chapters.length) return;
    controller.pause();
    positionStore.setPosition(
      {
        chapterId: chapters[idx].id,
        chapterIdx: idx,
        absoluteSegmentIndex: 0,
        wordIndex: 0,
      },
      'toc',
    );
  }, [chapters, controller]);

  // Scroll the formatted view into view whenever the cursor lands on a
  // new chapter via something other than a user scroll. Single source
  // of truth: the cursor selector.
  const lastScrolledChapterIdxRef = useRef<number>(-1);
  useEffect(() => {
    if (!showFormattedView) return;
    if (cursorOrigin === 'user-scroll') return;
    if (cursorOrigin === 'engine') return;
    if (lastScrolledChapterIdxRef.current === chapterIdx) return;
    lastScrolledChapterIdxRef.current = chapterIdx;
    requestAnimationFrame(() => {
      formattedViewRef.current?.scrollSectionIntoView(chapterIdx);
    });
  }, [showFormattedView, chapterIdx, cursorOrigin, cursorRevision]);

  /* ---- Current-segment highlight band ---- */
  // Always paints the band on cursor changes while showFormattedView is
  // true — including engine ticks (so the band follows live playback in
  // scroll/track modes) and user scrolls (so the band follows the
  // user's finger). Re-fires on layoutVersion bumps so late content
  // loads (innerHTML write, image decode, font reflow) update the band
  // against the fresh geometry.
  useEffect(() => {
    const handle = formattedViewRef.current;
    if (!handle) return;
    if (!showFormattedView) {
      handle.setHighlightBand(null);
      return;
    }
    const segs = loaderState.segments;
    const arrIdx = translators.absoluteToArrayIndex(absoluteSegmentIndex);
    if (segs.length === 0 || arrIdx == null) {
      handle.setHighlightBand(null);
      return;
    }

    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      const container = handle.getScrollContainer();
      const sectionEl = handle.getSectionEl(chapterIdx);
      if (!container || !sectionEl) return;
      // Skip if the section hasn't been laid out yet — body innerHTML
      // is written async after the image loader resolves, so on the
      // very first effect run after FormattedView mounts, the section
      // is just a title h1. Wait for layoutVersion to bump.
      if (sectionEl.getBoundingClientRect().height < 80) return;
      const band = computeHighlightBand(
        arrIdx,
        segs,
        sectionEl,
        container,
        velocityProfileRef.current,
      );
      if (band) handle.setHighlightBand(band);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [
    showFormattedView,
    absoluteSegmentIndex,
    chapterIdx,
    cursorRevision,
    isPlaying,
    loaderState.segments,
    translators,
    layoutVersion,
  ]);

  /* ---- Auto-scroll the formatted view to the current segment ---- */
  // Three trigger conditions:
  //   1. The cursor moves via something other than user-scroll/engine
  //      (toc/chapter-nav/user-seek/restore/display-mode/mode-switch)
  //   2. showFormattedView flips from false → true (user paused in
  //      phrase/rsvp; formatted view is now visible). The cursor
  //      itself didn't move, so we detect this via pendingScrollRef.
  //   3. layoutVersion bumps while pendingScrollRef is set — the
  //      formatted view's bodies just landed/grew, retry the scroll
  //      against the now-real section geometry.
  //
  // The engine path is suppressed during play because the engine is
  // pushing scrollTop directly each frame (scroll/track) or the
  // formatted view isn't visible (phrase/rsvp).
  //
  // pendingScrollRef is the "we want to scroll but haven't been able
  // to yet" latch. Set on transition-in or external cursor move,
  // cleared once a successful scroll lands. Survives multiple effect
  // re-runs while waiting for layout to settle.
  const pendingScrollRef = useRef(false);
  const wasFormattedRef = useRef(false);
  useEffect(() => {
    const handle = formattedViewRef.current;
    if (!handle) return;
    if (!showFormattedView) {
      wasFormattedRef.current = false;
      pendingScrollRef.current = false;
      return;
    }

    // Detect transitions to mark a scroll as pending. We track three
    // distinct sources that should trigger a scroll:
    //   - showFormattedView just flipped true (transitionedIn)
    //   - cursor commit with a non-engine non-user-scroll origin
    const transitionedIn = !wasFormattedRef.current;
    wasFormattedRef.current = true;
    if (transitionedIn) pendingScrollRef.current = true;
    if (cursorOrigin !== 'user-scroll' && cursorOrigin !== 'engine') {
      pendingScrollRef.current = true;
    }

    if (!pendingScrollRef.current) return;

    const segs = loaderState.segments;
    const arrIdx = translators.absoluteToArrayIndex(absoluteSegmentIndex);
    if (segs.length === 0 || arrIdx == null) return;

    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      const container = handle.getScrollContainer();
      const sectionEl = handle.getSectionEl(chapterIdx);
      if (!container || !sectionEl) return;
      // Wait for the section to actually be laid out. On first mount
      // after a pause-from-phrase, the body innerHTML is written async
      // (image loader is a Promise). Until it lands the section is
      // just a ~30px title h1, and computing a scroll target against
      // that puts the user at the wrong place. Bail; we'll re-fire
      // when layoutVersion bumps after the velocity profile rebuilds.
      if (sectionEl.getBoundingClientRect().height < 80) return;

      const band = computeHighlightBand(
        arrIdx,
        segs,
        sectionEl,
        container,
        velocityProfileRef.current,
      );
      if (!band) return;

      const segCenterY = band.topPx + band.heightPx / 2;
      const viewportH = container.clientHeight;
      const targetScroll = segCenterY - viewportH * 0.4;
      const maxScroll = Math.max(0, container.scrollHeight - viewportH);
      const clamped = Math.max(0, Math.min(targetScroll, maxScroll));

      const behavior: ScrollBehavior =
        transitionedIn ||
        cursorOrigin === 'restore' ||
        cursorOrigin === 'display-mode' ||
        cursorOrigin === 'mode-switch'
          ? 'auto'
          : 'smooth';
      container.scrollTo({ top: clamped, behavior });
      pendingScrollRef.current = false;
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [
    showFormattedView,
    absoluteSegmentIndex,
    chapterIdx,
    cursorOrigin,
    cursorRevision,
    loaderState.segments,
    translators,
    layoutVersion,
  ]);

  const handlePrevChapter = useCallback(() => {
    if (chapterIdx > 0) navigateToSection(chapterIdx - 1);
  }, [chapterIdx, navigateToSection]);

  const handleNextChapter = useCallback(() => {
    if (chapterIdx < chapters.length - 1) navigateToSection(chapterIdx + 1);
  }, [chapterIdx, chapters.length, navigateToSection]);

  /* ---- Pause-mode scroll listener (formatted view USER_SCROLL) ---- */
  // While paused in formatted view, manual scroll updates the cursor
  // position. The controller's seekToAbs is the wrong primitive here
  // because we want origin='user-scroll' (so the scroll-into-view
  // effect skips), and we want to reuse the proportional cursor mapping.
  useEffect(() => {
    if (!showFormattedView) return;
    if (isPlaying) return;
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
        const sectionEl = handle.getSectionEl(chapterIdx);
        if (!sectionEl) return;
        const containerRect = container.getBoundingClientRect();
        const sectionRect = sectionEl.getBoundingClientRect();
        const sectionTop =
          sectionRect.top - containerRect.top + container.scrollTop;
        const centerY = container.scrollTop + container.clientHeight / 2;
        if (centerY < sectionTop || centerY >= sectionTop + sectionRect.height) return;
        const segs = loaderState.segments;
        if (segs.length === 0) return;
        const progress = (centerY - sectionTop) / sectionRect.height;
        const arr = Math.min(
          segs.length - 1,
          Math.max(0, Math.floor(progress * segs.length)),
        );
        const abs = translators.arrayToAbsolute(arr);
        if (abs == null) return;
        if (abs === positionStore.getSnapshot().absoluteSegmentIndex) return;
        positionStore.setPosition(
          { absoluteSegmentIndex: abs, wordIndex: 0 },
          'user-scroll',
        );
      });
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
    };
  }, [showFormattedView, isPlaying, chapterIdx, loaderState.segments, translators]);

  /* ---- Orientation resilience ---- */
  useOrientationResilience(
    useCallback(() => {
      onPrefetchHint(activeArrayIdx);
    }, [onPrefetchHint, activeArrayIdx]),
  );

  /* ---- Keyboard handling ---- */
  const seekToArr = useCallback(
    (arr: number) => {
      const abs = translators.arrayToAbsolute(arr);
      if (abs == null) return;
      controller.seekToAbs(abs);
    },
    [controller, translators],
  );

  useKeyboardHandling({
    onTogglePlay: controller.togglePlayPause,
    onSpeedUp: useCallback(() => controller.adjustWpm(25), [controller]),
    onSpeedDown: useCallback(() => controller.adjustWpm(-25), [controller]),
    onNextChunk: useCallback(() => seekToArr(activeArrayIdx + 1), [seekToArr, activeArrayIdx]),
    onPrevChunk: useCallback(() => seekToArr(activeArrayIdx - 1), [seekToArr, activeArrayIdx]),
    onNextChapter: handleNextChapter,
    onPrevChapter: handlePrevChapter,
  });

  /* ---- Wake lock ---- */
  useWakeLock(isPlaying || wasPlayingBeforeLost);

  /* ---- Global playing attribute (for ThemeToggle fade) ---- */
  useEffect(() => {
    document.documentElement.toggleAttribute('data-playing', isPlaying);
    return () => document.documentElement.removeAttribute('data-playing');
  }, [isPlaying]);

  /* ---- Render ---- */
  const isPdfBook =
    !isImageBook &&
    chapters.length > 0 &&
    chapters[0].meta != null &&
    typeof (chapters[0].meta as Record<string, unknown>).startPage === 'number';

  // Formatted-view IntersectionObserver fires when scroll lands in a
  // new section. Convert to a CHAPTER_NAV via setPosition.
  const handleVisibleSectionChange = useCallback(
    (idx: number) => {
      if (idx === chapterIdx) return;
      positionStore.setPosition(
        {
          chapterId: chapters[idx].id,
          chapterIdx: idx,
          absoluteSegmentIndex: 0,
          wordIndex: 0,
        },
        'chapter-nav',
      );
    },
    [chapterIdx, chapters],
  );

  // RSVP display values come from the controller (live word ticks at
  // 4-12 Hz, isolated re-render).
  const rsvpWord = controller.rsvpWord;
  const rsvpOrpIndex = controller.rsvpOrpIndex;
  const progress = useDerivedProgress(
    activeArrayIdx,
    loaderState.segments,
    loaderState.totalSegments,
  );

  return (
    <div className="reader-viewport" role="main" aria-label="Book reader" id="main-content">
      <ReaderHeader
        bookTitle={bookTitle}
        sectionTitle={currentChapter?.title ?? 'Untitled'}
        displayMode={displayMode as ApiDisplayMode}
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
        onJump={(idx) => navigateToSection(idx)}
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
            currentPageIndex={absoluteSegmentIndex}
            onVisiblePageChange={(idx) => {
              if (idx !== absoluteSegmentIndex) {
                positionStore.setPosition(
                  { absoluteSegmentIndex: idx, wordIndex: 0 },
                  'user-seek',
                );
              }
            }}
            onTap={isPlaying ? controller.pause : undefined}
          />
        ) : isPdfBook ? (
          <PdfFormattedView
            publicationId={publicationId}
            chapters={chapters}
            currentSectionIndex={chapterIdx}
            onVisibleSectionChange={handleVisibleSectionChange}
            onTap={isPlaying ? controller.pause : undefined}
          />
        ) : (
          <>
            <FormattedView
              ref={formattedViewRef}
              publicationId={publicationId}
              chapters={chapters}
              currentSectionIndex={chapterIdx}
              onVisibleSectionChange={handleVisibleSectionChange}
              onTap={isPlaying ? controller.pause : undefined}
              velocityProfileRef={velocityProfileRef}
              onLayoutChange={onFormattedLayoutChange}
            />
            <VelocityProfileDebugOverlay
              formattedViewRef={formattedViewRef}
              velocityProfileRef={velocityProfileRef}
              wpm={wpm}
            />
          </>
        )
      )}

      {!showFormattedView && (
      <GestureLayer
        onTap={isPlaying ? controller.pause : undefined}
        onSwipeLeft={isPlaying ? handleNextChapter : undefined}
        onSwipeRight={isPlaying ? handlePrevChapter : undefined}
        onSwipeUp={isPlaying ? () => controller.adjustWpm(25) : undefined}
        onSwipeDown={isPlaying ? () => controller.adjustWpm(-25) : undefined}
        enabled={isPlaying}
      >
        <FocusChunkOverlay
          segment={currentSegment}
          isPlaying={isPlaying}
          progress={progress}
          mode={readingMode}
          rsvpWord={rsvpWord}
          rsvpOrpIndex={rsvpOrpIndex}
          rsvpWpm={wpm}
          segments={loaderState.segments}
          currentIndex={activeArrayIdx}
          onSeek={seekToArr}
          scrollContainerRef={focusContainerRef}
          scrollItemRefs={focusItemRefsMap}
        />
      </GestureLayer>
      )}

      {readingMode === 'track' && gazeState.status !== 'idle' && isPlaying && (
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
            <button className="gaze-error-overlay__btn" onClick={handleToggleMode}>Switch mode</button>
            <button className="gaze-error-overlay__retry" onClick={() => gazeActions.start()}>Retry</button>
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
        isPlaying={isPlaying || wasPlayingBeforeLost}
        wpm={wpm}
        progress={progress}
        onTogglePlay={controller.togglePlayPause}
        onSetWpm={controller.setWpm}
        onAdjustWpm={controller.adjustWpm}
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

/** Derive a progress fraction from absolute segment index and total. */
function useDerivedProgress(
  activeArrayIdx: number,
  segments: { segment_index: number }[],
  totalSegments: number,
): number {
  const effectiveTotal = totalSegments > 0 ? totalSegments : segments.length;
  const absoluteIndex = segments[activeArrayIdx]?.segment_index ?? activeArrayIdx;
  return effectiveTotal > 0 ? absoluteIndex / effectiveTotal : 0;
}

/* ------------------------------------------------------------------ */
/*  computeHighlightBand                                               */
/* ------------------------------------------------------------------ */
//
// Returns the y-range of the given segment within the formatted view's
// scroll-container coordinate system. Three accuracy tiers, from best
// to fallback:
//
//   1. Velocity-profile + word-count weighted (block-accurate). The
//      profile already partitions the section into blocks with known
//      topPx/heightPx and a per-block "weight" (effective word count).
//      We map cumulative segment word-count to cumulative weight, then
//      walk the profile to find the matching block + interpolate the
//      block-relative offset.
//
//   2. Word-count weighted proportional. No profile yet — distribute
//      segments across the section's height by their cumulative
//      word-count fraction. Better than naive proportional for chapters
//      with very uneven segment sizes (short title segments etc.).
//
//   3. Pure proportional. Equal slices per segment. Used when word
//      counts are missing (zero) or absent.
//
// The function is pure: same inputs, same output. It reads section
// geometry via getBoundingClientRect — slightly expensive, but called
// only on cursor/layout changes, not in any rAF hot path.

function computeHighlightBand(
  arrIdx: number,
  segments: { word_count?: number }[],
  sectionEl: HTMLElement,
  container: HTMLDivElement,
  profile: VelocityProfile | null,
): { topPx: number; heightPx: number } | null {
  const segCount = segments.length;
  if (segCount === 0 || arrIdx < 0 || arrIdx >= segCount) return null;

  const containerRect = container.getBoundingClientRect();
  const sectionRect = sectionEl.getBoundingClientRect();
  const sectionTop =
    sectionRect.top - containerRect.top + container.scrollTop;
  const sectionH = sectionRect.height;
  if (sectionH <= 0) return null;

  // Cumulative word counts. Word counts of 0 fall back to 1 so each
  // segment has at least equal weight (this matches the chunker's
  // intent — even a "title" segment gets some space).
  let cumBefore = 0;
  for (let i = 0; i < arrIdx; i++) {
    cumBefore += Math.max(1, segments[i].word_count ?? 1);
  }
  const segWords = Math.max(1, segments[arrIdx].word_count ?? 1);
  const cumAfter = cumBefore + segWords;
  let totalWords = cumAfter;
  for (let i = arrIdx + 1; i < segCount; i++) {
    totalWords += Math.max(1, segments[i].word_count ?? 1);
  }

  // Tier 1: velocity profile available — find this section's block
  // entries and use them for accurate per-block positioning.
  if (profile && profile.entries.length > 0) {
    const sectionBottom = sectionTop + sectionH;
    // Filter to entries that fall within this section. The profile is
    // built once for the whole formatted view (every chapter), so we
    // need to slice. Tolerance of a few px to handle margin overlap.
    const sectionEntries: { topPx: number; heightPx: number; weight: number }[] = [];
    for (const e of profile.entries) {
      if (e.bottomPx <= sectionTop + 1) continue;
      if (e.topPx >= sectionBottom - 1) break; // entries are sorted
      sectionEntries.push({
        topPx: e.topPx,
        heightPx: e.heightPx,
        weight: e.weight,
      });
    }

    if (sectionEntries.length > 0) {
      let sectionTotalWeight = 0;
      for (const e of sectionEntries) sectionTotalWeight += e.weight;
      if (sectionTotalWeight > 0) {
        const startWeight = (cumBefore / totalWords) * sectionTotalWeight;
        const endWeight = (cumAfter / totalWords) * sectionTotalWeight;
        const topPx = weightToPx(startWeight, sectionEntries);
        const bottomPx = weightToPx(endWeight, sectionEntries);
        const heightPx = Math.max(2, bottomPx - topPx);
        return { topPx, heightPx };
      }
    }
  }

  // Tier 2: word-count weighted proportional within the section.
  if (totalWords > 0) {
    const startFrac = cumBefore / totalWords;
    const endFrac = cumAfter / totalWords;
    return {
      topPx: sectionTop + startFrac * sectionH,
      heightPx: Math.max(2, (endFrac - startFrac) * sectionH),
    };
  }

  // Tier 3: pure proportional fallback.
  return {
    topPx: sectionTop + (arrIdx / segCount) * sectionH,
    heightPx: Math.max(2, sectionH / segCount),
  };
}

/** Walk weight-sorted entries until cumulative weight reaches target;
 *  interpolate within the matched entry to a precise pixel offset. */
function weightToPx(
  targetWeight: number,
  entries: { topPx: number; heightPx: number; weight: number }[],
): number {
  let cum = 0;
  for (const e of entries) {
    if (cum + e.weight >= targetWeight) {
      const frac = e.weight > 0 ? (targetWeight - cum) / e.weight : 0;
      return e.topPx + Math.max(0, Math.min(1, frac)) * e.heightPx;
    }
    cum += e.weight;
  }
  // Past the end — clamp to bottom of last entry.
  const last = entries[entries.length - 1];
  return last.topPx + last.heightPx;
}
