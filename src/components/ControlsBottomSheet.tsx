import { useState } from 'react';
import { useAnnounce } from '../hooks/useAnnounce';
import { useHaptics } from '../hooks/useHaptics';
import type { ReadingMode } from '../types';

interface ControlsBottomSheetProps {
  isPlaying: boolean;
  wpm: number;
  progress: number;
  onTogglePlay: () => void;
  onSetWpm: (wpm: number) => void;
  onAdjustWpm: (delta: number) => void;
  onPrevChapter: () => void;
  onNextChapter: () => void;
  hasPrevChapter: boolean;
  hasNextChapter: boolean;
  mode?: ReadingMode;
  onToggleMode?: () => void;
  onSetMode?: (mode: ReadingMode) => void;
  stopAtChapterEnd?: boolean;
  onToggleStopAtChapter?: () => void;
  gazeSensitivity?: number;
  onGazeSensitivityChange?: (value: number) => void;
  onRecalibrate?: () => void;
}

export default function ControlsBottomSheet({
  isPlaying,
  wpm,
  progress,
  onTogglePlay,
  onSetWpm: _onSetWpm,
  onAdjustWpm,
  onPrevChapter,
  onNextChapter,
  hasPrevChapter,
  hasNextChapter,
  mode = 'phrase',
  onToggleMode,
  onSetMode,
  stopAtChapterEnd = false,
  onToggleStopAtChapter,
  gazeSensitivity = 1.0,
  onGazeSensitivityChange,
  onRecalibrate,
}: ControlsBottomSheetProps) {
  const { announce } = useAnnounce();
  const haptics = useHaptics();
  const [showModeList, setShowModeList] = useState(false);

  // PRD §9.3 — Image mode is gone (CBZ now uses formatted view always).
  const modeNames: Record<string, string> = { phrase: 'Phrase', rsvp: 'RSVP', scroll: 'Scroll', track: 'Track' };
  const allModes: ReadingMode[] = ['phrase', 'rsvp', 'scroll', 'track'];

  const handleTogglePlay = () => {
    onTogglePlay();
    haptics.tap();
    announce(isPlaying ? 'Paused' : 'Playing');
  };

  const handleAdjustWpm = (delta: number) => {
    onAdjustWpm(delta);
    haptics.tick();
    announce(`${wpm + delta} words per minute`);
  };

  return (
    <div className={`controls${isPlaying ? ' controls--playing' : ''}`} role="toolbar" aria-label="Reading controls">
      {/* Progress bar */}
      <div className="controls__progress">
        <div
          className="controls__progress-bar"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      {/* Chapter navigation row */}
      <div className="controls__chapter-row">
        <button
          className="controls__btn"
          onClick={onPrevChapter}
          disabled={!hasPrevChapter}
          aria-disabled={!hasPrevChapter ? 'true' : undefined}
          aria-label="Previous section"
        >
          &#9664;
        </button>
        <span className="controls__chapter-spacer" />
        <button
          className="controls__btn"
          onClick={onNextChapter}
          disabled={!hasNextChapter}
          aria-disabled={!hasNextChapter ? 'true' : undefined}
          aria-label="Next section"
        >
          &#9654;
        </button>
      </div>

      {/* Main controls row */}
      <div className="controls__main-row">
        {/* WPM controls */}
        <div className="controls__wpm-group">
          <button
            className="controls__btn"
            onClick={() => handleAdjustWpm(-25)}
            aria-label="Decrease reading speed"
          >
            &minus;
          </button>
          <span className="controls__wpm-label" aria-live="polite">{wpm} WPM</span>
          <button
            className="controls__btn"
            onClick={() => handleAdjustWpm(25)}
            aria-label="Increase reading speed"
          >
            +
          </button>
        </div>

        {/* Mode toggle */}
        {(onToggleMode || onSetMode) && (
          <div className="controls__mode-wrapper">
            <button
              className="controls__mode-btn"
              onClick={() => {
                setShowModeList(v => !v);
                haptics.tap();
              }}
              aria-label={`Reading mode: ${modeNames[mode]}`}
              aria-expanded={showModeList}
            >
              {modeNames[mode]} &#9662;
            </button>
            {showModeList && (
              <div className="controls__mode-list" role="listbox" aria-label="Select reading mode">
                {allModes.map(m => (
                  <button
                    key={m}
                    className={`controls__mode-list-item${m === mode ? ' controls__mode-list-item--active' : ''}`}
                    role="option"
                    aria-selected={m === mode}
                    onClick={() => {
                      if (m !== mode && onSetMode) {
                        onSetMode(m);
                        announce(`Switched to ${modeNames[m]} mode`);
                      }
                      setShowModeList(false);
                      haptics.tap();
                    }}
                  >
                    {modeNames[m]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Stop at section end */}
        {onToggleStopAtChapter && (
          <button
            className={`controls__chapter-stop-btn${stopAtChapterEnd ? ' controls__chapter-stop-btn--active' : ''}`}
            onClick={() => {
              onToggleStopAtChapter();
              haptics.tap();
              announce(stopAtChapterEnd ? 'Continuous reading on' : 'Pause between sections on');
            }}
            aria-label={stopAtChapterEnd ? 'Switch to continuous reading' : 'Pause between sections'}
            aria-pressed={stopAtChapterEnd}
          >
            {stopAtChapterEnd ? 'Sec. Pause' : 'Sec. Auto'}
          </button>
        )}
      </div>

      {/* Track mode controls */}
      {mode === 'track' && onGazeSensitivityChange && (
        <div className="controls__track-row">
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
          {onRecalibrate && (
            <button
              className="controls__chapter-stop-btn"
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

      {/* Play/Pause — large bottom target */}
      <button
        className="controls__play-bar"
        onClick={handleTogglePlay}
        aria-label={isPlaying ? 'Pause reading' : 'Play reading'}
      >
        <span className="controls__play-bar-icon">{isPlaying ? '\u2759\u2759' : '\u25B6\uFE0E'}</span>
        <span className="controls__play-bar-label">{isPlaying ? 'Tap to Pause' : 'Tap to Play'}</span>
      </button>
    </div>
  );
}
