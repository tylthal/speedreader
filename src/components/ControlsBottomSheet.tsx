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
  chapterTitle: string;
  onPrevChapter: () => void;
  onNextChapter: () => void;
  hasPrevChapter: boolean;
  hasNextChapter: boolean;
  mode?: ReadingMode;
  onToggleMode?: () => void;
  onSetMode?: (mode: ReadingMode) => void;
  onExit?: () => void;
  chapters?: { id: number; title: string; chapter_index: number }[];
  currentChapterIndex?: number;
  onJumpToChapter?: (index: number) => void;
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
  chapterTitle,
  onPrevChapter,
  onNextChapter,
  hasPrevChapter,
  hasNextChapter,
  mode = 'phrase',
  onToggleMode,
  onSetMode,
  onExit,
  chapters = [],
  currentChapterIndex = 0,
  onJumpToChapter,
  stopAtChapterEnd = false,
  onToggleStopAtChapter,
  gazeSensitivity = 1.0,
  onGazeSensitivityChange,
  onRecalibrate,
}: ControlsBottomSheetProps) {
  const { announce } = useAnnounce();
  const haptics = useHaptics();
  const [showChapterList, setShowChapterList] = useState(false);
  const [showModeList, setShowModeList] = useState(false);

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
        {onExit && (
          <button
            className="controls__btn controls__exit-btn"
            onClick={onExit}
            aria-label="Exit book"
          >
            &#x2190;
          </button>
        )}
        <button
          className="controls__btn"
          onClick={onPrevChapter}
          disabled={!hasPrevChapter}
          aria-disabled={!hasPrevChapter ? 'true' : undefined}
          aria-label="Previous chapter"
        >
          &#9664;
        </button>
        <button
          className="controls__chapter-title controls__chapter-title--tappable"
          onClick={() => setShowChapterList((v) => !v)}
          aria-label="Open chapter list"
          aria-expanded={showChapterList}
        >
          {chapterTitle}
        </button>
        <button
          className="controls__btn"
          onClick={onNextChapter}
          disabled={!hasNextChapter}
          aria-disabled={!hasNextChapter ? 'true' : undefined}
          aria-label="Next chapter"
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

        {/* Stop at chapter end */}
        {onToggleStopAtChapter && (
          <button
            className={`controls__chapter-stop-btn${stopAtChapterEnd ? ' controls__chapter-stop-btn--active' : ''}`}
            onClick={() => {
              onToggleStopAtChapter();
              haptics.tap();
              announce(stopAtChapterEnd ? 'Continuous reading on' : 'Pause between chapters on');
            }}
            aria-label={stopAtChapterEnd ? 'Switch to continuous reading' : 'Pause between chapters'}
            aria-pressed={stopAtChapterEnd}
          >
            {stopAtChapterEnd ? 'Ch. Pause' : 'Ch. Auto'}
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

      {/* Chapter list overlay */}
      {showChapterList && chapters.length > 0 && (
        <div className="chapter-list-overlay" role="dialog" aria-label="Chapter list">
          <div className="chapter-list">
            <div className="chapter-list__header">
              <span className="chapter-list__title">Chapters</span>
              <button
                className="controls__btn"
                onClick={() => setShowChapterList(false)}
                aria-label="Close chapter list"
              >
                &#x2715;
              </button>
            </div>
            <ul className="chapter-list__items" role="list">
              {chapters.map((ch, idx) => (
                <li key={ch.id}>
                  <button
                    className={`chapter-list__item${idx === currentChapterIndex ? ' chapter-list__item--active' : ''}`}
                    onClick={() => {
                      onJumpToChapter?.(idx);
                      setShowChapterList(false);
                      haptics.tap();
                      announce(`Jumped to ${ch.title}`);
                    }}
                  >
                    <span className="chapter-list__item-number">{idx + 1}</span>
                    <span className="chapter-list__item-title">{ch.title}</span>
                    {idx === currentChapterIndex && (
                      <span className="chapter-list__item-current" aria-label="Current chapter">&#x25CF;</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
