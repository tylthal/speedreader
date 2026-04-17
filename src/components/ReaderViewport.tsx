import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { useAnnounce } from '../hooks/useAnnounce';
import { useHaptics } from '../hooks/useHaptics';
import { useSegmentLoader } from '../hooks/useSegmentLoader';
import { useAllChapterSegments } from '../hooks/useAllChapterSegments';
import { usePlaybackController } from '../hooks/usePlaybackController';
import { useGazeTracker } from '../hooks/useGazeTracker';
import { useProgressSaver } from '../hooks/useProgressSaver';
import { useOrientationResilience } from '../hooks/useOrientationResilience';
import { useKeyboardHandling } from '../hooks/useKeyboardHandling';
import { useWakeLock } from '../hooks/useWakeLock';
import { useChapterFlow } from '../hooks/useChapterFlow';
import {
  useTocNavigation,
} from '../hooks/useTocNavigation';
import { useNavigateToPosition } from '../hooks/useNavigateToPosition';
import { useFormattedViewCursorSync } from '../hooks/useFormattedViewCursorSync';
import { useReaderInitialization } from '../hooks/useReaderInitialization';
import { Link, useNavigate } from 'react-router-dom';
import { setDisplayModePref } from '../db/localClient';
import { markFirstChunkRendered } from '../lib/ttfcMetric';
import { extractSnippet } from '../lib/bookmarkSnippet';
import { readStoredPrefs, resolveWpmForMode, writeStoredPrefs } from '../lib/readerProgress';
import type { Chapter, TocNode } from '../db/localClient';
import type { Bookmark } from '../db/localClient';
import type { ReadingMode } from '../types';
import GestureLayer from './GestureLayer';
import FocusChunkOverlay from './FocusChunkOverlay';
import ControlsBottomSheet from './ControlsBottomSheet';
import TrackCalibration from './TrackCalibration';
import ReaderHeader from './ReaderHeader';
import TocSidebar from './TocSidebar';
import BookmarksPanel from './BookmarksPanel';
import BookmarkNameDialog from './BookmarkNameDialog';
import ActionSheet from './ActionSheet';
import FormattedView from './FormattedView';
import { REFERENCE_LINE_RATIO, type FormattedViewHandle } from './FormattedView';
import PdfFormattedView from './PdfFormattedView';
import CbzFormattedView from './CbzFormattedView';
import type { ContentType } from '../db/localClient';
import type { VelocityProfile } from '../lib/velocityProfile';
import { flattenTocLocations } from '../lib/tocLocation';
import { shallowEqual } from '../lib/shallowEqual';
import {
  positionStore,
  usePositionSelector,
} from '../state/position/positionStore';
import { bookmarkStore, useBookmarkSelector } from '../state/bookmarkStore';
import type { DisplayMode } from '../state/position/types';

// Dev-only tuning overlay for the formatted-view velocity profile. Guarded by
// import.meta.env.DEV so Rollup constant-folds the branch to `null` in
// production builds, dropping the overlay module (and its portal/rAF debug
// path) out of the main entry chunk. A static import would pin the module
// into the graph regardless of the runtime URL-param gate that used to live
// inside the component.
const VelocityProfileDebugOverlay = import.meta.env.DEV
  ? lazy(() => import('./VelocityProfileDebugOverlay'))
  : null

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ReaderViewportProps {
  publicationId: number;
}

interface ActiveReaderProps {
  publicationId: number;
  bookTitle: string;
  chapters: Chapter[];
  tocTree: TocNode[] | null;
  contentType: ContentType;
}

interface PreferredTocLocation {
  key: string | null
  title: string | null
  sectionIndex: number | null
  htmlAnchor: string | null
}

const preferredTocLocationByPublication = new Map<number, PreferredTocLocation>()

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function normalizeHtmlAnchor(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim().replace(/^#/, '')
  if (!trimmed) return ''
  try {
    return decodeURIComponent(trimmed)
  } catch {
    return trimmed
  }
}

function findAnchorElement(sectionEl: HTMLElement, htmlAnchor: string): HTMLElement | null {
  const normalized = htmlAnchor.trim()
  if (!normalized) return null
  return (
    sectionEl.querySelector(`[id="${escapeAttributeValue(normalized)}"]`) as HTMLElement | null
  ) ?? (
    sectionEl.querySelector(`[name="${escapeAttributeValue(normalized)}"]`) as HTMLElement | null
  )
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
  const initState = useReaderInitialization(publicationId);

  if (initState.status === 'loading') {
    return (
      <div className="reader-viewport__loading">
        <div className="reader-state" role="status" aria-live="polite">
          <div className="reader-state__icon" aria-hidden="true">A</div>
          <h1 className="reader-state__title">Opening your book</h1>
          <p className="reader-state__message">Restoring your place and preparing the reader.</p>
        </div>
      </div>
    );
  }

  if (initState.status === 'error') {
    return (
      <div className="reader-viewport__error">
        <div className="reader-state reader-state--error" role="alert">
          <div className="reader-state__icon" aria-hidden="true">!</div>
          <h1 className="reader-state__title">Couldn't open this book</h1>
          <p className="reader-state__message">{initState.message}</p>
          <Link className="reader-state__action" to="/">
            Back to Library
          </Link>
        </div>
      </div>
    );
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
  // Single composite selector — returns a stable reference while the
  // 7 slice values are shallowly equal. Collapses what used to be 7
  // independent useSyncExternalStore subscriptions into one, reducing
  // React-internal subscription churn during playback.
  const { chapterIdx, absoluteSegmentIndex, isPlaying, wpm, readingMode, displayMode, cursorOrigin } =
    usePositionSelector(
      (s) => ({
        chapterIdx: s.chapterIdx,
        absoluteSegmentIndex: s.absoluteSegmentIndex,
        isPlaying: s.isPlaying,
        wpm: s.wpm,
        readingMode: s.mode,
        displayMode: s.displayMode,
        cursorOrigin: s.origin,
      }),
      shallowEqual,
    );
  // NOTE: We intentionally do NOT subscribe to `revision` here.
  // Revision increments on every positionStore commit, which during
  // scroll/track playback happens on each segment boundary. Subscribing
  // to it would re-render the entire ActiveReader tree on every commit,
  // causing scroll jitter. Effects that need commit-level granularity
  // should use positionStore.subscribe() directly instead.
  const cursorRevisionRef = useRef(0);
  useEffect(() => {
    return positionStore.subscribe(() => {
      cursorRevisionRef.current = positionStore.getSnapshot().revision;
    });
  }, []);

  const [tocOpen, setTocOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [bookmarkNaming, setBookmarkNaming] = useState<{
    chapterId: number
    chapterIdx: number
    absoluteSegmentIndex: number
    wordIndex: number
    snippet: string
  } | null>(null);
  const [visualActiveTocLocationKey, setVisualActiveTocLocationKey] = useState<string | null>(null);
  const [preferredTocLocation, setPreferredTocLocationState] = useState<PreferredTocLocation>(
    () =>
      preferredTocLocationByPublication.get(publicationId) ?? {
        key: null,
        title: null,
        sectionIndex: null,
        htmlAnchor: null,
      },
  );

  const setPreferredTocLocation = useCallback((value: PreferredTocLocation) => {
    preferredTocLocationByPublication.set(publicationId, value);
    setPreferredTocLocationState(value);
  }, [publicationId]);

  const isImageBook = contentType === 'image';
  const phraseLikeMode = readingMode === 'phrase' || readingMode === 'rsvp';

  const handleToggleDisplayMode = useCallback(() => {
    const next: DisplayMode = displayMode === 'plain' ? 'formatted' : 'plain';
    positionStore.setDisplayMode(next);
    setDisplayModePref(publicationId, next).catch(() => { /* ignore */ });
  }, [displayMode, publicationId]);

  const { stopAtChapterEnd } = useChapterFlow();
  const stopAtChapterEndRef = useRef(stopAtChapterEnd);
  stopAtChapterEndRef.current = stopAtChapterEnd;

  const navigate = useNavigate();
  const { announce } = useAnnounce();

  const currentChapter = chapters[chapterIdx] ?? chapters[0] ?? null;
  const currentChapterId = currentChapter?.id ?? 0;

  const isPdfBook =
    !isImageBook &&
    chapters.length > 0 &&
    chapters[0].meta != null &&
    typeof (chapters[0].meta as Record<string, unknown>).startPage === 'number';

  /* ---- Segment loader (with translators) ---- */
  const [loaderState, translators] = useSegmentLoader({
    publicationId,
    chapterId: currentChapterId,
  });

  /* ---- All-chapter segments (plain mode, paused only) ----
     Plain mode's paused scroll view renders the whole book so users can
     scroll continuously across chapters, mirroring what FormattedView
     does via chapters.map. We only load this when it'll actually be
     used: displayMode === 'plain' && !isPlaying && !image/pdf. Playing
     mode keeps its per-chapter loader — the engine auto-advances
     chapters on its own. */
  const allChaptersEnabled =
    displayMode === 'plain' && !isPlaying && !isImageBook && !isPdfBook;
  const allChaptersState = useAllChapterSegments(
    publicationId,
    chapters,
    allChaptersEnabled,
  );

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
  // Tracks the restore-scroll lifecycle so playwright (and future
  // diagnostics) can assert on the outcome. 'idle' at mount, 'pending'
  // while useFormattedViewCursorSync is waiting for prior sections to
  // render, 'done' once the restore scroll has been committed, or
  // 'degraded' when the priors-ready budget was exhausted and the code
  // fell back to segment-center. Surfaced via data-restore-state on
  // the viewport root below.
  const [restoreState, setRestoreState] =
    useState<'idle' | 'pending' | 'done' | 'degraded'>('idle');

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
  const [gazeState, gazeRef, gazeActions, gazeVideoRef, gazeLandmarksRef] = useGazeTracker();
  const [showCalibration, setShowCalibration] = useState(false);
  const [gazeSensitivity, setGazeSensitivity] = useState(1.0);
  const hasCalibrated = useRef(!!(() => { try { return localStorage.getItem('speedreader_gaze_calibration'); } catch { return null; } })());

  /* ---- The single playback controller ---- */
  const handleAutoAdvance = useCallback((): boolean => {
    const nextIdx = positionStore.getSnapshot().chapterIdx + 1;
    if (nextIdx >= chapters.length) {
      announce('Book finished');
      return false;
    }
    if (stopAtChapterEndRef.current) {
      announce(`Chapter complete: ${chapters[nextIdx - 1]?.title ?? ''}`);
      return false;
    }
    // Move the cursor to the next chapter. Return true so the engine
    // keeps isPlaying=true — the rAF loop stops but the UI stays in
    // playing mode. The auto-resume effect below calls resumeLoop()
    // when the new chapter's segments arrive.
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
    return true;
  }, [chapters, announce]);

  const autoAdvanceRef = useRef(false);

  const controller = usePlaybackController({
    segments: loaderState.segments,
    totalSegments: loaderState.totalSegments,
    translators,
    focusContainerRef,
    focusItemOffsetsRef: focusItemRefsMap,
    formattedViewRef,
    velocityProfileRef,
    gazeRef,
    onComplete: handleAutoAdvance,
  });

  /* ---- User-facing pause/toggle wrappers ---- */
  // The auto-advance flow (engine completes chapter → handleAutoAdvance
  // sets autoAdvanceRef → effect below resumes play when next chapter's
  // segments load) was racing user pause: if the user pressed pause
  // mid-auto-advance, the effect would still re-fire play() and the
  // pause never took effect. Worst on books with several short opening
  // sections — phrase mode sweeps through Cover/Title-Page/Contents
  // in seconds and the user can't pause at all.
  //
  // Fix: any user-initiated pause clears autoAdvanceRef so the auto-
  // play effect stays inactive. The internal pause paths (visibility,
  // gaze loss) don't need to clear it — those are pause-equivalents,
  // not abort-the-auto-advance signals.
  const userPause = useCallback(() => {
    autoAdvanceRef.current = false;
    controller.pause();
  }, [controller]);
  const userTogglePlayPause = useCallback(() => {
    if (positionStore.getSnapshot().isPlaying) {
      autoAdvanceRef.current = false;
    }
    controller.togglePlayPause();
  }, [controller]);

  /* ---- Auto-resume after auto-advance ---- */
  // Fired by handleAutoAdvance via autoAdvanceRef. Wait for the new
  // chapter's segments to load, then restart the tick loop via
  // resumeLoop() — isPlaying never went false so no UI chrome flashes.
  useEffect(() => {
    if (!autoAdvanceRef.current) return;
    if (loaderState.segments.length === 0) return;
    autoAdvanceRef.current = false;
    controller.resumeLoop();
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
    } else if (!wasPlayingBeforeLost && !showCalibration) {
      gazeActions.pauseTracking();
    }
  }, [readingMode, isPlaying, wasPlayingBeforeLost, gazeActions, showCalibration]);

  // Ensure camera feed + frame capture are active while calibration is open
  useEffect(() => {
    if (showCalibration && readingMode === 'track') {
      gazeActions.resumeTracking();
    }
  }, [showCalibration, readingMode, gazeActions]);

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
  const flatTocLocations = useMemo(
    () => (tocTree ? flattenTocLocations(tocTree) : []),
    [tocTree],
  );
  const tocTitleByKey = useMemo(
    () => new Map(flatTocLocations.map((entry) => [entry.key, entry.title])),
    [flatTocLocations],
  );
  const currentSectionTocLocations = useMemo(
    () => flatTocLocations.filter((entry) => entry.sectionIndex === chapterIdx),
    [chapterIdx, flatTocLocations],
  );
  const activeTocLocationKey =
    preferredTocLocation.key ??
    visualActiveTocLocationKey ??
    currentSectionTocLocations[0]?.key ??
    null;

  // Reset visual key on chapter change so a stale key from the previous
  // chapter doesn't flash before the tracking effect re-resolves.
  useEffect(() => {
    setVisualActiveTocLocationKey(null);
  }, [chapterIdx]);

  useEffect(() => {
    if (preferredTocLocation.key) return;
    if (currentSectionTocLocations.length <= 1) return;

    const handle = formattedViewRef.current;
    if (!handle?.isSectionReady(chapterIdx)) return;

    const container = handle.getScrollContainer();
    const sectionEl = handle.getSectionEl(chapterIdx);
    if (!container || !sectionEl) return;

    let cancelled = false;
    let rafId = 0;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const resolveActiveKey = () => {
      if (cancelled) return;

      const containerRect = container.getBoundingClientRect();
      const sectionRect = sectionEl.getBoundingClientRect();
      const sectionTop = sectionRect.top - containerRect.top + container.scrollTop;
      const focusTop = container.scrollTop + container.clientHeight * REFERENCE_LINE_RATIO;

      let activeKey: string | null = currentSectionTocLocations[0]?.key ?? null;
      let firstFutureKey: string | null = null;

      for (const entry of currentSectionTocLocations) {
        let targetTop = sectionTop;
        const anchor = normalizeHtmlAnchor(entry.htmlAnchor);
        if (anchor) {
          const anchorEl = findAnchorElement(sectionEl, anchor);
          if (!anchorEl) continue;
          const anchorRect = anchorEl.getBoundingClientRect();
          targetTop = anchorRect.top - containerRect.top + container.scrollTop;
        }

        if (targetTop <= focusTop) {
          activeKey = entry.key;
          continue;
        }

        firstFutureKey = entry.key;
        break;
      }

      const nextKey = activeKey ?? firstFutureKey ?? currentSectionTocLocations[0]?.key ?? null;
      if (!cancelled) {
        setVisualActiveTocLocationKey((prev) => (prev === nextKey ? prev : nextKey));
      }
    };

    rafId = requestAnimationFrame(() => {
      timeoutId = setTimeout(resolveActiveKey, 0);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [
    preferredTocLocation.key,
    currentSectionTocLocations,
    chapterIdx,
    absoluteSegmentIndex,
    layoutVersion,
  ]);

  /* ---- Mode switching: just dispatch ---- */
  // pause + setMode. The controller's tick reads mode from the store
  // each frame; no per-mode seek, no carry-wpm dance, no align effects.
  const switchToMode = useCallback((next: ReadingMode) => {
    controller.pause();

    // Sync position from the pip before switching. Effect 3 updates the
    // store via a rAF callback that may still be pending when the user
    // switches modes. Without this sync, the mode switch would use a
    // stale absoluteSegmentIndex from before the user's last scroll.
    const snap = positionStore.getSnapshot();
    if (snap.displayMode === 'formatted') {
      const handle = formattedViewRef.current;
      if (handle) {
        handle.refreshPipPosition();
        const segs = loaderState.segments;
        const detected = handle.detectAtViewportCenter(snap.chapterIdx, segs);
        if (detected?.arrIdx != null) {
          const abs = translators.arrayToAbsolute(detected.arrIdx);
          if (abs != null && abs !== snap.absoluteSegmentIndex) {
            positionStore.setPosition(
              { absoluteSegmentIndex: abs, wordIndex: 0 },
              'user-scroll',
            );
          }
        }
      }
    }

    // Eagerly persist current mode's WPM so it survives rapid switching
    const currentSnap = positionStore.getSnapshot();
    const existing = readStoredPrefs(publicationId);
    const wpmByMode = {
      ...existing?.wpmByMode,
      [currentSnap.mode]: currentSnap.wpm,
    };
    writeStoredPrefs(publicationId, {
      wpm: currentSnap.wpm,
      readingMode: currentSnap.mode,
      wpmByMode,
    });

    // Resolve and apply the target mode's WPM (clamped to valid range)
    const targetWpm = wpmByMode[next] ?? existing?.wpm ?? 250;
    positionStore.setMode(next);
    controller.setWpm(targetWpm);
  }, [controller, publicationId, formattedViewRef, loaderState.segments, translators]);

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
  // Pass the formatted view ref so the saver can read live scrollTop
  // from the DOM rather than relying on the position store (which may
  // lag behind the actual scroll position by one rAF).
  const formattedScrollContainerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Keep the ref pointing to the current scroll container
    const el = formattedViewRef.current?.getScrollContainer() ?? null;
    formattedScrollContainerRef.current = el;
  });
  useProgressSaver({ publicationId, scrollContainerRef: formattedScrollContainerRef, formattedViewRef });

  /* ---- Bookmark store init + auto bookmarks ---- */
  const haptics = useHaptics();

  useEffect(() => {
    bookmarkStore.init(publicationId);
    return () => { bookmarkStore.reset(); };
  }, [publicationId]);

  // Note: "last_opened" AND "farthest_read" auto-bookmarks are now both
  // continuously updated by useProgressSaver (single unified subscription),
  // so no dedicated farthest-read effect is needed here.

  // Bookmark selectors for quick-jump buttons & progress bar markers
  const hasLastOpened = useBookmarkSelector((s) => s.lastOpened !== null);
  const hasFarthestRead = useBookmarkSelector((s) => s.farthestRead !== null);

  /* ---- Book-wide progress: chapter offsets + totals ----
     The progress bar, bookmark markers, and scrub-seek all operate on
     whole-book fractions. We precompute a prefix-sum of segment_count
     across chapters so bookmark-chapter-idx → book-absolute index is a
     constant-time lookup, and book-fraction → (chapterIdx, inChapterAbs)
     is a linear scan over the (small) chapters array. */
  const { chapterOffsets, bookTotalSegments } = useMemo(() => {
    const offsets: number[] = new Array(chapters.length);
    let acc = 0;
    for (let i = 0; i < chapters.length; i++) {
      offsets[i] = acc;
      acc += chapters[i].segment_count ?? 0;
    }
    return { chapterOffsets: offsets, bookTotalSegments: acc };
  }, [chapters]);

  const bookProgress = useMemo(() => {
    if (bookTotalSegments <= 0) return 0;
    const offset = chapterOffsets[chapterIdx] ?? 0;
    const globalIdx = offset + absoluteSegmentIndex;
    return Math.min(1, globalIdx / bookTotalSegments);
  }, [chapterOffsets, bookTotalSegments, chapterIdx, absoluteSegmentIndex]);

  const lastOpenedProgressRaw = useBookmarkSelector((s) => {
    const b = s.lastOpened;
    if (!b || bookTotalSegments <= 0) return undefined;
    const offset = chapterOffsets[b.chapter_idx] ?? 0;
    return Math.min(1, (offset + b.absolute_segment_index) / bookTotalSegments);
  });
  const farthestReadProgress = useBookmarkSelector((s) => {
    const b = s.farthestRead;
    if (!b || bookTotalSegments <= 0) return undefined;
    const offset = chapterOffsets[b.chapter_idx] ?? 0;
    return Math.min(1, (offset + b.absolute_segment_index) / bookTotalSegments);
  });
  // Hide the Last Opened marker when it coincides with Farthest Read (within
  // 0.5% of the bar width) — they render at the same spot and the Farthest
  // Read marker is the semantically meaningful one. 0.5% ≈ 2px on a 400px
  // bar, which comfortably exceeds any single-segment rounding gap but is
  // small enough that visibly-distinct positions remain distinct.
  const lastOpenedProgress =
    lastOpenedProgressRaw != null &&
    farthestReadProgress != null &&
    Math.abs(lastOpenedProgressRaw - farthestReadProgress) < 0.005
      ? undefined
      : lastOpenedProgressRaw;

  /* ---- Navigation seam (TOC, bookmark, prev/next, progress scrub) ----
     Declared up here because the progress / bookmark / jump handlers
     below close over `navigateToPosition`. */
  const {
    pendingTocTargetRef,
    clearPendingTocTarget,
    navigationRevision,
    bumpNavigationRevision,
  } = useTocNavigation();

  const { navigateToPosition } = useNavigateToPosition({
    chapters,
    controller,
    formattedViewRef,
    pendingTocTargetRef,
    bumpNavigationRevision,
  });

  const handleProgressSeek = useCallback((fraction: number) => {
    if (bookTotalSegments <= 0) return;
    const target = Math.min(
      bookTotalSegments - 1,
      Math.max(0, Math.round(fraction * bookTotalSegments)),
    );
    // Find the chapter whose offset range contains `target`.
    let targetChapterIdx = 0;
    for (let i = chapters.length - 1; i >= 0; i--) {
      if (chapterOffsets[i] <= target) { targetChapterIdx = i; break; }
    }
    const inChapter = target - chapterOffsets[targetChapterIdx];
    navigateToPosition({
      chapterIdx: targetChapterIdx,
      absoluteSegmentIndex: inChapter,
      origin: 'user-seek',
    });
  }, [chapters.length, chapterOffsets, bookTotalSegments, navigateToPosition]);

  const handleJumpLastOpened = useCallback(() => {
    const b = bookmarkStore.getSnapshot().lastOpened;
    if (!b) return;
    navigateToPosition({
      chapterIdx: b.chapter_idx,
      absoluteSegmentIndex: b.absolute_segment_index,
      wordIndex: b.word_index,
      origin: 'bookmark',
    });
  }, [navigateToPosition]);

  const handleJumpFarthestRead = useCallback(() => {
    const b = bookmarkStore.getSnapshot().farthestRead;
    if (!b) return;
    navigateToPosition({
      chapterIdx: b.chapter_idx,
      absoluteSegmentIndex: b.absolute_segment_index,
      wordIndex: b.word_index,
      origin: 'bookmark',
    });
  }, [navigateToPosition]);

  /* ---- PIP tap → bookmark menu ---- */
  const [pipMenuOpen, setPipMenuOpen] = useState(false);
  // Captured PIP-resolved position at the moment of the tap. The menu
  // overlay covers the viewport center, so by the time the action is
  // chosen the pip block ref has been nulled out; we must resolve
  // authoritative coordinates BEFORE opening the menu. Cross-chapter
  // user-scroll also commits a placeholder absoluteSegmentIndex=0 that
  // Effect 3's rAF-deferred detector only refines on its next frame,
  // so reading snap.absoluteSegmentIndex here would save abs=0 instead
  // of the visual PIP position.
  const pipTapPositionRef = useRef<{
    chapterId: number
    chapterIdx: number
    absoluteSegmentIndex: number
    wordIndex: number
  } | null>(null);

  const capturePipPosition = useCallback(() => {
    const snap = positionStore.getSnapshot();
    if (snap.isPlaying) return null;
    if (snap.chapterId === 0) return null;

    let abs = snap.absoluteSegmentIndex;
    let word = snap.wordIndex;
    if (snap.displayMode === 'formatted') {
      const handle = formattedViewRef.current;
      if (handle) {
        handle.refreshPipPosition();
        const detected = handle.detectAtViewportCenter(snap.chapterIdx, loaderState.segments);
        if (detected?.arrIdx != null) {
          const resolved = translators.arrayToAbsolute(detected.arrIdx);
          if (resolved != null) {
            abs = resolved;
            word = 0;
          }
        }
      }
    }
    const captured = {
      chapterId: snap.chapterId,
      chapterIdx: snap.chapterIdx,
      absoluteSegmentIndex: abs,
      wordIndex: word,
    };
    pipTapPositionRef.current = captured;
    return captured;
  }, [loaderState.segments, translators]);

  // Quick tap on the PIP: skip the single-option ActionSheet and
  // open the bookmark-naming dialog directly. Long-press still opens
  // the sheet so future secondary options can live there.
  const handlePipTap = useCallback(() => {
    if (!capturePipPosition()) return;
    const snap = positionStore.getSnapshot();
    if (snap.chapterId === 0) return;
    const captured = pipTapPositionRef.current;
    if (!captured) return;
    const snippet = extractSnippet(
      loaderState.segments,
      captured.absoluteSegmentIndex,
      captured.wordIndex,
    );
    setBookmarkNaming({
      chapterId: captured.chapterId,
      chapterIdx: captured.chapterIdx,
      absoluteSegmentIndex: captured.absoluteSegmentIndex,
      wordIndex: captured.wordIndex,
      snippet,
    });
    haptics.success();
  }, [capturePipPosition, loaderState.segments, haptics]);

  const handlePipLongPress = useCallback(() => {
    if (!capturePipPosition()) return;
    setPipMenuOpen(true);
  }, [capturePipPosition]);

  const handlePipAddBookmark = useCallback(() => {
    const captured = pipTapPositionRef.current;
    const snap = positionStore.getSnapshot();
    if (snap.chapterId === 0) return;
    const chapterId = captured?.chapterId ?? snap.chapterId;
    const chapterIdx = captured?.chapterIdx ?? snap.chapterIdx;
    const abs = captured?.absoluteSegmentIndex ?? snap.absoluteSegmentIndex;
    const word = captured?.wordIndex ?? snap.wordIndex;

    const snippet = extractSnippet(
      loaderState.segments,
      abs,
      word,
    );

    setBookmarkNaming({
      chapterId,
      chapterIdx,
      absoluteSegmentIndex: abs,
      wordIndex: word,
      snippet,
    });
    haptics.success();
    setPipMenuOpen(false);
    pipTapPositionRef.current = null;
  }, [loaderState.segments, haptics]);

  const handleBookmarkConfirm = useCallback((name: string) => {
    if (!bookmarkNaming) return;
    bookmarkStore.addBookmark({
      chapter_id: bookmarkNaming.chapterId,
      chapter_idx: bookmarkNaming.chapterIdx,
      absolute_segment_index: bookmarkNaming.absoluteSegmentIndex,
      word_index: bookmarkNaming.wordIndex,
      snippet: bookmarkNaming.snippet,
      name,
    });
    setBookmarkNaming(null);
    announce(`Bookmark created: ${name}`);
  }, [bookmarkNaming, announce]);

  const handleBookmarkJump = useCallback((position: {
    chapterId: number
    chapterIdx: number
    absoluteSegmentIndex: number
    wordIndex: number
  }) => {
    navigateToPosition({
      chapterIdx: position.chapterIdx,
      absoluteSegmentIndex: position.absoluteSegmentIndex,
      wordIndex: position.wordIndex,
      origin: 'bookmark',
    });
  }, [navigateToPosition]);

  /* ---- Chapter announcements ---- */
  useEffect(() => {
    if (currentChapter && cursorRevisionRef.current > 0) {
      announce(`Chapter: ${currentChapter.title}`);
    }
  }, [currentChapter, announce]);

  /* ---- Chapter navigation (TOC, prev/next) ---- */
  // NOTE: there used to be a separate "scroll-section-into-view on
  // chapter change" effect here. It fought with the auto-scroll effect
  // below — both fired on TOC clicks, both targeted the same container,
  // and the second one (auto-scroll) would override the first
  // (instant-jump-to-section-top). The auto-scroll effect alone is now
  // the single source of truth for ALL formatted-view scrolling. The
  // scrollSectionIntoView imperative method is gone from FormattedView.

  // Formatted-view IntersectionObserver fires when scroll lands in a
  // new section. Convert to a CHAPTER_NAV via setPosition — but mark
  // origin as 'user-scroll' if the user is currently driving the
  // scroll, so the auto-scroll effect doesn't snap them back to the
  // start of the new chapter. The user is the source of truth when
  // they're scrolling; we follow them, we don't override.
  //
  // Also used as onPipSectionChange: when the PIP (at the 40% reference
  // line) detects it's in a different section than chapterIdx, Effect 3
  // calls this to make the PIP authoritative for chapter display.
  const handleVisibleSectionChange = useCallback(
    (idx: number) => {
      if (idx === chapterIdx) return;
      if (idx < 0 || idx >= chapters.length) return;
      // The IntersectionObserver inside FormattedView only fires
      // dispatches when the user actually scrolled (its scrollTop guard
      // bails on layout reflows, and the programmatic-scroll flag bails
      // on auto-scrolls). Anything that reaches us here is therefore a
      // user-driven scroll, so we always commit with 'user-scroll'
      // origin — that prevents the auto-scroll effect from snapping the
      // user back to the start of the new chapter.
      //
      // absoluteSegmentIndex is set to 0 as a placeholder. Effect 3
      // detects the real position once segments load for the new chapter
      // and commits with 'user-scroll'. The progress saver skips writing
      // when absoluteSegmentIndex is 0 and the origin indicates a
      // cross-chapter transition (see useProgressSaver).

      // Clear sticky preferred TOC location — the user scrolled away
      // from whatever they clicked. Without this the TOC highlight stays
      // stuck on the old entry while the header moves to the new chapter.
      setPreferredTocLocation({ key: null, title: null, sectionIndex: null, htmlAnchor: null });

      positionStore.setPosition(
        {
          chapterId: chapters[idx].id,
          chapterIdx: idx,
          absoluteSegmentIndex: 0,
          wordIndex: 0,
        },
        'user-scroll',
      );
    },
    [chapterIdx, chapters, setPreferredTocLocation],
  );

  useFormattedViewCursorSync({
    showFormattedView,
    isPlaying,
    tocNavigationRevision: navigationRevision,
    chapterIdx,
    absoluteSegmentIndex,
    cursorOrigin,
    layoutVersion,
    segments: loaderState.segments,
    translators,
    formattedViewRef,
    pendingTocTargetRef,
    clearPendingTocTarget,
    onPipSectionChange: handleVisibleSectionChange,
    onRestoreStateChange: setRestoreState,
  });

  const handlePrevChapter = useCallback(() => {
    if (chapterIdx > 0) {
      navigateToPosition({ chapterIdx: chapterIdx - 1, origin: 'chapter-nav' });
    }
  }, [chapterIdx, navigateToPosition]);

  const handleNextChapter = useCallback(() => {
    if (chapterIdx < chapters.length - 1) {
      navigateToPosition({ chapterIdx: chapterIdx + 1, origin: 'chapter-nav' });
    }
  }, [chapterIdx, chapters.length, navigateToPosition]);

  /* ---- Orientation resilience ---- */
  useOrientationResilience();

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
    onTogglePlay: userTogglePlayPause,
    onSpeedUp: useCallback(() => controller.adjustWpm(1), [controller]),
    onSpeedDown: useCallback(() => controller.adjustWpm(-1), [controller]),
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

  // RSVP display values come from the controller (live word ticks at
  // 4-12 Hz, isolated re-render).
  const rsvpWord = controller.rsvpWord;
  const rsvpOrpIndex = controller.rsvpOrpIndex;
  // Book-wide progress fraction. `bookProgress` is computed above from the
  // chapter-offset prefix sum; fall back to chapter-local derivation when
  // chapters haven't reported segment_count (shouldn't happen post-upload,
  // but keeps the bar sensible if the field is 0).
  const chapterLocalProgress = useDerivedProgress(
    activeArrayIdx,
    loaderState.segments,
    loaderState.totalSegments,
  );
  const progress = bookTotalSegments > 0 ? bookProgress : chapterLocalProgress;

  // Derive the header subtitle from the active TOC key so it always
  // matches the TOC highlight. Falls back to the chapter title when
  // the TOC tree doesn't cover the current section.
  const displaySectionTitle = useMemo(() => {
    const tocTitle = tocTitleByKey.get(activeTocLocationKey ?? '');
    if (tocTitle) return tocTitle;
    return currentChapter?.title ?? 'Untitled';
  }, [activeTocLocationKey, tocTitleByKey, currentChapter]);

  return (
    <div
      className="reader-viewport"
      role="main"
      aria-label="Book reader"
      id="main-content"
      data-restore-state={restoreState}
    >
      <ReaderHeader
        bookTitle={bookTitle}
        sectionTitle={displaySectionTitle}
        displayMode={displayMode}
        onToggleDisplayMode={isImageBook ? undefined : handleToggleDisplayMode}
        hideDisplayToggle={isImageBook}
        formattedSuppressed={phraseLikeMode && displayMode === 'formatted'}
        onOpenToc={() => setTocOpen(true)}
        onOpenBookmarks={() => setBookmarksOpen(true)}
        onExit={() => {
          if (readingMode === 'track') {
            positionStore.setMode('scroll');
            const existing = readStoredPrefs(publicationId);
            writeStoredPrefs(publicationId, { ...existing, wpm: existing?.wpm ?? wpm, readingMode: 'scroll' });
          }
          navigate('/');
        }}
      />
      <TocSidebar
        open={tocOpen}
        chapters={chapters}
        tocTree={tocTree}
        activeLocationKey={activeTocLocationKey}
        activeLocationTitle={preferredTocLocation.title}
        activeLocationSectionIndex={preferredTocLocation.sectionIndex}
        activeLocationAnchor={preferredTocLocation.htmlAnchor}
        onJump={(idx, htmlAnchor, tocKey) => {
          const title =
            tocTitleByKey.get(tocKey) ??
            chapters[idx]?.title ??
            'Untitled';
          setPreferredTocLocation({
            key: tocKey || `${idx}`,
            title,
            sectionIndex: idx,
            htmlAnchor: htmlAnchor ?? null,
          });
          navigateToPosition({ chapterIdx: idx, htmlAnchor, origin: 'toc' });
        }}
        onClose={() => setTocOpen(false)}
      />
      <BookmarksPanel
        open={bookmarksOpen}
        chapters={chapters}
        onJump={handleBookmarkJump}
        onClose={() => setBookmarksOpen(false)}
      />
      {pipMenuOpen && (
        <ActionSheet
          title="Position"
          options={[
            { label: 'Add Bookmark', onSelect: handlePipAddBookmark },
          ]}
          onClose={() => {
          setPipMenuOpen(false);
          pipTapPositionRef.current = null;
        }}
        />
      )}
      {bookmarkNaming && (
        <BookmarkNameDialog
          defaultName={`Bookmark ${bookmarkStore.getUserBookmarkCount() + 1}`}
          onConfirm={handleBookmarkConfirm}
          onCancel={() => setBookmarkNaming(null)}
        />
      )}

      {/* CBZ and PDF views are conditionally rendered (they're cheap and
          rarely used). The HTML FormattedView is ALWAYS mounted to avoid
          the multi-second remount cost on every pause from phrase/RSVP —
          its body innerHTML write, velocity profile build, and segment
          range index build are all amortized over the session. CSS
          visibility is gated on showFormattedView. The IntersectionObserver
          inside FormattedView consults the same prop so it doesn't
          dispatch chapter-nav while hidden. */}
      {showFormattedView && isImageBook && (
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
          onTap={isPlaying ? userPause : undefined}
        />
      )}
      {showFormattedView && !isImageBook && isPdfBook && (
        <PdfFormattedView
          publicationId={publicationId}
          chapters={chapters}
          currentSectionIndex={chapterIdx}
          onVisibleSectionChange={handleVisibleSectionChange}
          onTap={isPlaying ? userPause : undefined}
        />
      )}
      {!isImageBook && !isPdfBook && (
        <div className="long-press-wrapper">
          <FormattedView
            ref={formattedViewRef}
            publicationId={publicationId}
            chapters={chapters}
            currentSectionIndex={chapterIdx}
            onVisibleSectionChange={handleVisibleSectionChange}
            onTap={isPlaying ? userPause : undefined}
            onPipTap={handlePipTap}
            onPipLongPress={handlePipLongPress}
            showPip={!isPlaying}
            velocityProfileRef={velocityProfileRef}
            onLayoutChange={onFormattedLayoutChange}
            visible={showFormattedView}
            prioritizeAllPriorOnRestore={cursorOrigin === 'restore'}
          />
          {showFormattedView && VelocityProfileDebugOverlay && (
            <Suspense fallback={null}>
              <VelocityProfileDebugOverlay
                formattedViewRef={formattedViewRef}
                velocityProfileRef={velocityProfileRef}
                wpm={wpm}
              />
            </Suspense>
          )}

          {!showFormattedView && (
          <GestureLayer
            onTap={isPlaying ? userPause : undefined}
            onSwipeLeft={isPlaying ? handleNextChapter : undefined}
            onSwipeRight={isPlaying ? handlePrevChapter : undefined}
            onSwipeUp={isPlaying ? () => controller.adjustWpm(1) : undefined}
            onSwipeDown={isPlaying ? () => controller.adjustWpm(-1) : undefined}
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
              allChapters={allChaptersState.chapters}
              currentChapterIdx={chapterIdx}
              currentAbsoluteIndex={absoluteSegmentIndex}
              onCrossChapterSeek={(targetChapterIdx, absoluteSegmentIndex) =>
                navigateToPosition({
                  chapterIdx: targetChapterIdx,
                  absoluteSegmentIndex,
                  origin: 'user-seek',
                })
              }
            />
          </GestureLayer>
          )}
        </div>
      )}

      {/* GazeIndicator now renders inside ControlsBottomSheet strip */}

      {showCalibration && (
        <TrackCalibration
          onComplete={() => { setShowCalibration(false); hasCalibrated.current = true; }}
          onSkip={() => { setShowCalibration(false); hasCalibrated.current = true; }}
          onCalibratePoint={gazeActions.calibratePoint}
          onFinish={gazeActions.finishCalibration}
          videoRef={gazeVideoRef}
          landmarksRef={gazeLandmarksRef}
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
        onTogglePlay={userTogglePlayPause}
        onSetWpm={controller.setWpm}
        onAdjustWpm={controller.adjustWpm}
        mode={readingMode}
        onToggleMode={handleToggleMode}
        onSetMode={handleSetMode}
        gazeSensitivity={gazeSensitivity}
        onGazeSensitivityChange={(val) => { setGazeSensitivity(val); gazeActions.setSensitivity(val); }}
        onRecalibrate={() => {
          hasCalibrated.current = false;
          try { localStorage.removeItem('speedreader_gaze_calibration'); } catch {}
          setShowCalibration(true);
        }}
        onJumpLastOpened={handleJumpLastOpened}
        onJumpFarthestRead={handleJumpFarthestRead}
        lastOpenedProgress={lastOpenedProgress}
        farthestReadProgress={farthestReadProgress}
        onSeek={handleProgressSeek}
        gazeDirection={gazeState.direction}
        gazeIntensity={gazeState.intensity}
        gazeStatus={readingMode === 'track' ? gazeState.status : undefined}
        gazeVideoRef={gazeVideoRef}
        gazeLandmarksRef={gazeLandmarksRef}
        onOpenToc={() => setTocOpen(true)}
        onOpenBookmarks={() => setBookmarksOpen(true)}
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
