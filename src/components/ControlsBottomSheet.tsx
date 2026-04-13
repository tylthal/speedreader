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
  mode?: ReadingMode;
  onToggleMode?: () => void;
  onSetMode?: (mode: ReadingMode) => void;
  gazeSensitivity?: number;
  onGazeSensitivityChange?: (value: number) => void;
  onRecalibrate?: () => void;
  onJumpLastOpened?: () => void;
  onJumpFarthestRead?: () => void;
  hasLastOpened?: boolean;
  hasFarthestRead?: boolean;
}

export default function ControlsBottomSheet({
  isPlaying,
  wpm,
  progress,
  onTogglePlay,
  onSetWpm: _onSetWpm,
  onAdjustWpm,
  mode = 'phrase',
  onToggleMode,
  onSetMode,
  gazeSensitivity = 1.0,
  onGazeSensitivityChange,
  onRecalibrate,
  onJumpLastOpened,
  onJumpFarthestRead,
  hasLastOpened = false,
  hasFarthestRead = false,
}: ControlsBottomSheetProps) {
  const { announce } = useAnnounce();
  const haptics = useHaptics();
  const [showModeList, setShowModeList] = useState(false);
  const [showTrackOptions, setShowTrackOptions] = useState(false);

  const modeMeta: Record<ReadingMode, { label: string; description: string }> = {
    phrase: { label: 'Focus', description: 'One phrase at a time' },
    rsvp: { label: 'Word-by-word', description: 'Single words at speed' },
    scroll: { label: 'Scroll', description: 'Continuous teleprompter view' },
    track: { label: 'Hands-free', description: 'Scroll with head tracking' },
  };
  const allModes: ReadingMode[] = ['phrase', 'rsvp', 'scroll', 'track'];
  const activeMode = modeMeta[mode];
  const canShowTrackOptions = mode === 'track' && Boolean(onGazeSensitivityChange || onRecalibrate);

  const handleTogglePlay = () => {
    onTogglePlay();
    haptics.tap();
    announce(isPlaying ? 'Paused' : `${activeMode.label} started`);
  };

  const handleAdjustWpm = (delta: number) => {
    onAdjustWpm(delta);
    haptics.tick();
    announce(`${wpm + delta} words per minute`);
  };

  const hasBookmarks = onJumpLastOpened || onJumpFarthestRead;

  return (
    <div className={`controls${isPlaying ? ' controls--playing' : ''}`} role="toolbar" aria-label="Reading controls">
      {/* Progress bar */}
      <div className="controls__progress">
        <div
          className="controls__progress-bar"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      {/* Compact controls row: WPM | mode | bookmarks */}
      <div className="controls__main-row">
        <div className="controls__wpm-group">
          <button
            className="controls__btn"
            onClick={() => handleAdjustWpm(-25)}
            aria-label="Decrease reading speed"
          >
            &minus;
          </button>
          <span className="controls__wpm-label" aria-live="polite">{wpm}</span>
          <button
            className="controls__btn"
            onClick={() => handleAdjustWpm(25)}
            aria-label="Increase reading speed"
          >
            +
          </button>
        </div>

        {(onToggleMode || onSetMode) && (
          <div className="controls__mode-wrapper">
            <button
              className="controls__mode-btn"
              onClick={() => {
                setShowModeList(v => !v);
                haptics.tap();
              }}
              aria-label={`Reading mode: ${activeMode.label}. ${activeMode.description}`}
              aria-expanded={showModeList}
            >
              {activeMode.label} &#9662;
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
                        announce(`Switched to ${modeMeta[m].label}`);
                      }
                      setShowModeList(false);
                      haptics.tap();
                    }}
                  >
                    <span className="controls__mode-list-label">{modeMeta[m].label}</span>
                    <span className="controls__mode-list-desc">{modeMeta[m].description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {hasBookmarks && <div className="controls__row-spacer" />}

        {onJumpLastOpened && (
          <button
            className="controls__bookmark-pill"
            onClick={() => { onJumpLastOpened(); haptics.tap(); announce('Jumped to last opened position'); }}
            disabled={!hasLastOpened}
            aria-label="Jump to last opened position"
          >
            Last Opened
          </button>
        )}
        {onJumpFarthestRead && (
          <button
            className="controls__bookmark-pill"
            onClick={() => { onJumpFarthestRead(); haptics.tap(); announce('Jumped to farthest read position'); }}
            disabled={!hasFarthestRead}
            aria-label="Jump to farthest read position"
          >
            Farthest Read
          </button>
        )}
      </div>

      <div className="controls__playing-hint" aria-hidden={!isPlaying}>
        {activeMode.label} mode · {wpm} WPM
      </div>

      {canShowTrackOptions && (
        <div className="controls__advanced">
          <button
            className={`controls__advanced-toggle${showTrackOptions ? ' controls__advanced-toggle--active' : ''}`}
            type="button"
            aria-expanded={showTrackOptions}
            onClick={() => {
              setShowTrackOptions((value) => !value);
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

      {/* Track mode controls */}
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

      {/* Play/Pause — large bottom target */}
      <button
        className="controls__play-bar"
        onClick={handleTogglePlay}
        aria-label={isPlaying ? 'Pause reading' : 'Play reading'}
      >
        <span className="controls__play-bar-icon">{isPlaying ? '\u2759\u2759' : '\u25B6\uFE0E'}</span>
        <span className="controls__play-bar-label">{isPlaying ? 'Pause' : 'Start reading'}</span>
      </button>
    </div>
  );
}
