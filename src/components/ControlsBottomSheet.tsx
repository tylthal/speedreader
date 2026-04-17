import { useState, useRef, useEffect, useCallback, type CSSProperties } from 'react';
import { useAnnounce } from '../hooks/useAnnounce';
import { useHaptics } from '../hooks/useHaptics';
import type { ReadingMode } from '../types';
import type { GazeDirection } from '../lib/gazeProcessor';
import type { GazeStatus, FaceLandmark } from '../hooks/useGazeTracker';
import GazeIndicator from './GazeIndicator';
import WpmPresetPicker from './WpmPresetPicker';

interface ControlsBottomSheetProps {
  isPlaying: boolean;
  wpm: number;
  progress: number;
  onTogglePlay: () => void;
  onSetWpm: (wpm: number) => void;
  onAdjustWpm: (delta: number) => void;
  mode?: ReadingMode;
  onToggleMode?: () => void;
  onSetMode?: (mode: ReadingMode) => void;
  gazeSensitivity?: number;
  onGazeSensitivityChange?: (value: number) => void;
  onRecalibrate?: () => void;
  onJumpLastOpened?: () => void;
  onJumpFarthestRead?: () => void;
  /** 0-1 fraction for "last opened" bookmark position on the progress bar. */
  lastOpenedProgress?: number;
  /** 0-1 fraction for "farthest read" bookmark position on the progress bar. */
  farthestReadProgress?: number;
  /** Callback when the user scrubs the progress bar. Receives 0-1 fraction. */
  onSeek?: (progress: number) => void;
  // Legacy boolean props (kept for backwards compat, ignored if progress fractions provided)
  hasLastOpened?: boolean;
  hasFarthestRead?: boolean;
  /** Gaze tracking state — when provided, the face HUD renders inside the strip. */
  gazeDirection?: GazeDirection;
  gazeIntensity?: number;
  gazeStatus?: GazeStatus;
  gazeVideoRef?: React.RefObject<HTMLVideoElement | null>;
  gazeLandmarksRef?: React.RefObject<FaceLandmark[] | null>;
  /** Open the Table of Contents panel. */
  onOpenToc?: () => void;
  /** Open the Bookmarks panel. */
  onOpenBookmarks?: () => void;
}

const MODE_META: Record<ReadingMode, { label: string; short: string; description: string }> = {
  phrase: { label: 'Focus', short: 'Focus', description: 'One phrase at a time' },
  rsvp: { label: 'Word-by-word', short: 'Word', description: 'Single words at speed' },
  scroll: { label: 'Scroll', short: 'Scroll', description: 'Continuous teleprompter view' },
  track: { label: 'Hands-free', short: 'Free', description: 'Scroll with head tracking' },
};
const ALL_MODES: ReadingMode[] = ['phrase', 'rsvp', 'scroll', 'track'];

export default function ControlsBottomSheet({
  isPlaying,
  wpm,
  progress,
  onTogglePlay,
  onSetWpm,
  onAdjustWpm,
  mode = 'phrase',
  onToggleMode,
  onSetMode,
  gazeSensitivity = 1.0,
  onGazeSensitivityChange,
  onRecalibrate,
  onJumpLastOpened,
  onJumpFarthestRead,
  lastOpenedProgress,
  farthestReadProgress,
  onSeek,
  gazeDirection,
  gazeIntensity,
  gazeStatus,
  gazeVideoRef,
  gazeLandmarksRef,
  onOpenToc,
  onOpenBookmarks,
}: ControlsBottomSheetProps) {
  const { announce } = useAnnounce();
  const haptics = useHaptics();
  const [showTrackOptions, setShowTrackOptions] = useState(false);
  const [isStripExpanded, setIsStripExpanded] = useState(false);
  const [wpmPickerOpen, setWpmPickerOpen] = useState(false);

  // Scrubbing state
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubProgress, setScrubProgress] = useState(0);
  const progressRef = useRef<HTMLDivElement>(null);

  // WPM bump animation
  const [wpmBump, setWpmBump] = useState(false);
  const prevWpmRef = useRef(wpm);
  const bumpTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Strip WPM pulse
  const [stripWpmChanged, setStripWpmChanged] = useState(false);
  const stripPulseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Long-press acceleration for speed buttons
  const speedIntervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const speedCountRef = useRef(0);

  useEffect(() => {
    if (wpm !== prevWpmRef.current) {
      prevWpmRef.current = wpm;
      setWpmBump(true);
      setStripWpmChanged(true);
      clearTimeout(bumpTimerRef.current);
      clearTimeout(stripPulseTimerRef.current);
      bumpTimerRef.current = setTimeout(() => setWpmBump(false), 150);
      stripPulseTimerRef.current = setTimeout(() => setStripWpmChanged(false), 300);
    }
  }, [wpm]);

  // Reset strip expanded when playback stops
  useEffect(() => {
    if (!isPlaying) setIsStripExpanded(false);
  }, [isPlaying]);

  const activeMode = MODE_META[mode];
  const activeIndex = ALL_MODES.indexOf(mode);
  const canShowTrackOptions = mode === 'track' && Boolean(onGazeSensitivityChange || onRecalibrate);
  const displayProgress = isScrubbing ? scrubProgress : progress;

  // ── Progress bar scrubbing ──
  const updateScrubProgress = useCallback((e: React.PointerEvent) => {
    const rect = progressRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setScrubProgress(fraction);
  }, []);

  const handleProgressPointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsScrubbing(true);
    const rect = progressRef.current?.getBoundingClientRect();
    if (rect) {
      setScrubProgress(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
    }
    haptics.tick();
  }, [haptics]);

  const handleProgressPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isScrubbing) return;
    const rect = progressRef.current?.getBoundingClientRect();
    if (rect) {
      setScrubProgress(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
    }
  }, [isScrubbing]);

  const handleProgressPointerUp = useCallback(() => {
    if (!isScrubbing) return;
    setIsScrubbing(false);
    onSeek?.(scrubProgress);
    haptics.tap();
    announce(`Seeked to ${Math.round(scrubProgress * 100)}%`);
  }, [isScrubbing, scrubProgress, onSeek, haptics, announce]);

  // ── Play/pause ──
  const handleTogglePlay = useCallback(() => {
    onTogglePlay();
    haptics.tap();
    announce(isPlaying ? 'Paused' : `${activeMode.label} started`);
  }, [onTogglePlay, haptics, announce, isPlaying, activeMode.label]);

  // ── WPM adjustment with long-press ──
  const handleAdjustWpm = useCallback((direction: number) => {
    onAdjustWpm(direction);
    haptics.tick();
    const predicted = Math.max(50, Math.min(1200, wpm + (direction > 0 ? 25 : -25)));
    announce(`${predicted} words per minute`);
  }, [onAdjustWpm, haptics, wpm, announce]);

  const startSpeedRepeat = useCallback((direction: number) => {
    handleAdjustWpm(direction);
    speedCountRef.current = 0;
    speedIntervalRef.current = setInterval(() => {
      speedCountRef.current++;
      onAdjustWpm(direction);
      haptics.tick();
      // Accelerate after ~1 second (6 ticks at 150ms)
      if (speedCountRef.current === 6 && speedIntervalRef.current) {
        clearInterval(speedIntervalRef.current);
        speedIntervalRef.current = setInterval(() => {
          onAdjustWpm(direction);
          haptics.tick();
        }, 80);
      }
    }, 150);
  }, [handleAdjustWpm, onAdjustWpm, haptics]);

  const stopSpeedRepeat = useCallback(() => {
    if (speedIntervalRef.current) {
      clearInterval(speedIntervalRef.current);
      speedIntervalRef.current = undefined;
    }
    speedCountRef.current = 0;
  }, []);

  // ── Strip expand ──
  const handleStripTap = useCallback((e: React.MouseEvent) => {
    // Don't expand if tapping the pause button
    if ((e.target as HTMLElement).closest('.controls__strip-pause')) return;
    setIsStripExpanded(true);
    haptics.tap();
  }, [haptics]);

  const className = [
    'controls',
    isPlaying ? 'controls--playing' : '',
    isStripExpanded ? 'controls--expanded' : '',
  ].filter(Boolean).join(' ');

  const controlsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = controlsRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const write = (h: number) => {
      document.documentElement.style.setProperty('--controls-height', `${Math.round(h)}px`);
    };
    write(el.getBoundingClientRect().height);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) write(entry.contentRect.height);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty('--controls-height');
    };
  }, []);

  return (
    <div ref={controlsRef} className={className} role="toolbar" aria-label="Reading controls">
      {/* ── Interactive Progress Bar ── */}
      <div
        className={`controls__progress-wrap${isScrubbing ? ' controls__progress-wrap--scrubbing' : ''}`}
        style={{ '--scrub-left': `${displayProgress * 100}%` } as CSSProperties}
        onPointerDown={onSeek ? handleProgressPointerDown : undefined}
        onPointerMove={onSeek ? handleProgressPointerMove : undefined}
        onPointerUp={onSeek ? handleProgressPointerUp : undefined}
        onPointerCancel={onSeek ? handleProgressPointerUp : undefined}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(displayProgress * 100)}
        aria-label="Reading progress"
      >
        <div className="controls__progress" ref={progressRef}>
          <div
            className="controls__progress-bar"
            style={{ width: `${displayProgress * 100}%` }}
          />
          <div
            className="controls__progress-thumb"
            style={{ left: `${displayProgress * 100}%` }}
          />

          {/* Bookmark markers */}
          {lastOpenedProgress != null && onJumpLastOpened && (
            <button
              className="controls__progress-marker"
              style={{ left: `${lastOpenedProgress * 100}%` }}
              onClick={(e) => { e.stopPropagation(); onJumpLastOpened(); haptics.tap(); announce('Jumped to last opened position'); }}
              aria-label={`Last opened position: ${Math.round(lastOpenedProgress * 100)}%`}
              data-label="Last Opened"
            />
          )}
          {farthestReadProgress != null && onJumpFarthestRead && (
            <button
              className="controls__progress-marker controls__progress-marker--farthest"
              style={{ left: `${farthestReadProgress * 100}%` }}
              onClick={(e) => { e.stopPropagation(); onJumpFarthestRead(); haptics.tap(); announce('Jumped to farthest read position'); }}
              aria-label={`Farthest read position: ${Math.round(farthestReadProgress * 100)}%`}
              data-label="Farthest Read"
            />
          )}
        </div>

        <span className="controls__progress-label">
          {isScrubbing
            ? `${Math.round(scrubProgress * 100)}%`
            : `${Math.round(progress * 100)}%`}
        </span>
      </div>

      {/* ── Segmented Mode Control ── */}
      {(onToggleMode || onSetMode) && (
        <div
          className="controls__segment-group"
          role="radiogroup"
          aria-label="Reading mode"
          style={{ '--active-index': activeIndex } as CSSProperties}
        >
          {ALL_MODES.map((m) => (
            <button
              key={m}
              className={`controls__segment${m === mode ? ' controls__segment--active' : ''}`}
              role="radio"
              aria-checked={m === mode}
              aria-label={`${MODE_META[m].label}: ${MODE_META[m].description}`}
              onClick={() => {
                if (m !== mode && onSetMode) {
                  onSetMode(m);
                  announce(`Switched to ${MODE_META[m].label}`);
                }
                haptics.tap();
              }}
            >
              {MODE_META[m].short}
            </button>
          ))}
        </div>
      )}

      {/* ── Track mode options ── */}
      {canShowTrackOptions && (
        <div className="controls__advanced">
          <button
            className={`controls__advanced-toggle${showTrackOptions ? ' controls__advanced-toggle--active' : ''}`}
            type="button"
            aria-expanded={showTrackOptions}
            onClick={() => {
              setShowTrackOptions((v) => !v);
              haptics.tap();
            }}
          >
            {showTrackOptions ? 'Hide tracking options' : 'Tracking options'}
          </button>
          <p className="controls__advanced-note">
            Hands-free mode uses your camera on this device only.
          </p>
        </div>
      )}

      {canShowTrackOptions && showTrackOptions && (
        <div className="controls__track-row">
          {onGazeSensitivityChange && (
            <label className="controls__sensitivity-label">
              Sensitivity
              <input
                type="range"
                min="0.5"
                max="3"
                step="0.25"
                value={gazeSensitivity}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  onGazeSensitivityChange(val);
                  haptics.tick();
                }}
                className="controls__sensitivity-slider"
                aria-label={`Gaze sensitivity: ${gazeSensitivity.toFixed(1)}x`}
              />
              <span className="controls__sensitivity-value">{gazeSensitivity.toFixed(1)}x</span>
            </label>
          )}
          {onRecalibrate && (
            <button
              className="controls__secondary-pill"
              onClick={() => {
                onRecalibrate();
                haptics.tap();
                announce('Recalibrating head tracking');
              }}
            >
              Recalibrate
            </button>
          )}
        </div>
      )}

      {/* ── Speed Row ── */}
      <div className="controls__speed-row">
        <button
          className="controls__speed-btn"
          onPointerDown={() => startSpeedRepeat(-1)}
          onPointerUp={stopSpeedRepeat}
          onPointerLeave={stopSpeedRepeat}
          onPointerCancel={stopSpeedRepeat}
          aria-label="Decrease reading speed"
        >
          &minus;
        </button>
        <button
          type="button"
          className="controls__speed-display controls__speed-display--interactive"
          onClick={() => { setWpmPickerOpen(true); haptics.tap(); }}
          aria-label={`Open speed picker. Current speed: ${wpm} words per minute`}
        >
          <span className={`controls__speed-value${wpmBump ? ' controls__speed-value--bump' : ''}`}>
            {wpm}
          </span>
          <span className="controls__speed-unit">WPM</span>
        </button>
        <button
          className="controls__speed-btn"
          onPointerDown={() => startSpeedRepeat(1)}
          onPointerUp={stopSpeedRepeat}
          onPointerLeave={stopSpeedRepeat}
          onPointerCancel={stopSpeedRepeat}
          aria-label="Increase reading speed"
        >
          +
        </button>
      </div>

      {/* ── Playing-State Strip ── */}
      <div
        className="controls__strip"
        onClick={handleStripTap}
        role="button"
        tabIndex={0}
        aria-label="Expand controls"
        aria-expanded={isStripExpanded}
      >
        <div className="controls__strip-progress">
          <div
            className="controls__strip-progress-fill"
            style={{ width: `${progress * 100}%` }}
          />
        </div>

        {/* Face HUD embedded in strip when in track mode */}
        {gazeStatus && gazeStatus !== 'idle' && (
          <div className="controls__strip-hud">
            <GazeIndicator
              direction={gazeDirection ?? 'neutral'}
              intensity={gazeIntensity ?? 0}
              status={gazeStatus}
              videoRef={gazeVideoRef}
              landmarksRef={gazeLandmarksRef}
            />
          </div>
        )}

        <div className="controls__strip-center">
          <span className="controls__strip-mode">{activeMode.label}</span>
          <div className="controls__strip-speed">
            <button
              className="controls__strip-speed-btn"
              onClick={(e) => { e.stopPropagation(); handleAdjustWpm(-1); }}
              aria-label="Decrease speed"
            >
              &minus;
            </button>
            <button
              type="button"
              className={`controls__strip-wpm controls__strip-wpm--interactive${stripWpmChanged ? ' controls__strip-wpm--changed' : ''}`}
              onClick={(e) => { e.stopPropagation(); setWpmPickerOpen(true); haptics.tap(); }}
              aria-label={`Open speed picker. Current speed: ${wpm} words per minute`}
              aria-live="polite"
            >
              {wpm}
            </button>
            <span className="controls__strip-wpm-unit">WPM</span>
            <button
              className="controls__strip-speed-btn"
              onClick={(e) => { e.stopPropagation(); handleAdjustWpm(1); }}
              aria-label="Increase speed"
            >
              +
            </button>
          </div>
        </div>

        <button
          className="controls__strip-pause"
          onClick={(e) => { e.stopPropagation(); handleTogglePlay(); }}
          aria-label="Pause reading"
        >
          &#x2759;&#x2759;
        </button>
      </div>

      {/* ── Thumb-zone Nav (TOC + Bookmarks) ── */}
      {(onOpenToc || onOpenBookmarks) && (
        <div className="controls__nav-row">
          {onOpenToc && (
            <button
              type="button"
              className="controls__nav-pill"
              onClick={() => { onOpenToc(); haptics.tap(); }}
              aria-label="Open table of contents"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <line x1="3" y1="4" x2="13" y2="4" />
                <line x1="3" y1="8" x2="13" y2="8" />
                <line x1="3" y1="12" x2="13" y2="12" />
              </svg>
              <span>Contents</span>
            </button>
          )}
          {onOpenBookmarks && (
            <button
              type="button"
              className="controls__nav-pill"
              onClick={() => { onOpenBookmarks(); haptics.tap(); }}
              aria-label="Open bookmarks"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 2h8v12l-4-3-4 3z" />
              </svg>
              <span>Bookmarks</span>
            </button>
          )}
        </div>
      )}

      {/* ── Play/Pause Button ── */}
      <button
        className="controls__play-bar"
        onClick={handleTogglePlay}
        aria-label={isPlaying ? 'Pause reading' : 'Play reading'}
      >
        <span className="controls__play-bar-icon">
          {isPlaying ? '\u2759\u2759' : '\u25B6\uFE0E'}
        </span>
        <span className="controls__play-bar-label">
          {isPlaying ? 'Pause' : 'Start reading'}
        </span>
      </button>

      {wpmPickerOpen && (
        <WpmPresetPicker
          wpm={wpm}
          onSetWpm={onSetWpm}
          onClose={() => setWpmPickerOpen(false)}
        />
      )}
    </div>
  );
}
