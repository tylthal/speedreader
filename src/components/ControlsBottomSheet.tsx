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
  isCurrentBookmarked?: boolean;
  onToggleBookmark?: () => void;
  mode?: ReadingMode;
  onToggleMode?: () => void;
  onExit?: () => void;
  chapters?: { id: number; title: string; chapter_index: number }[];
  currentChapterIndex?: number;
  onJumpToChapter?: (index: number) => void;
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
  isCurrentBookmarked = false,
  onToggleBookmark,
  mode = 'phrase',
  onToggleMode,
  onExit,
  chapters = [],
  currentChapterIndex = 0,
  onJumpToChapter,
}: ControlsBottomSheetProps) {
  const { announce } = useAnnounce();
  const haptics = useHaptics();
  const [showChapterList, setShowChapterList] = useState(false);

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
    <div className="controls" role="toolbar" aria-label="Reading controls">
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
        {onToggleMode && (
          <button
            className="controls__mode-btn"
            onClick={() => {
              onToggleMode();
              haptics.tap();
              announce(mode === 'phrase' ? 'Switched to RSVP mode' : 'Switched to phrase mode');
            }}
            aria-label={mode === 'phrase' ? 'Switch to RSVP mode' : 'Switch to phrase mode'}
          >
            {mode === 'phrase' ? 'RSVP' : 'Phrase'}
          </button>
        )}

        {/* Bookmark */}
        {onToggleBookmark && (
          <button
            className={`controls__bookmark-btn${isCurrentBookmarked ? ' controls__bookmark-btn--active' : ''}`}
            onClick={() => {
              onToggleBookmark();
              haptics.tap();
              announce(isCurrentBookmarked ? 'Bookmark removed' : 'Bookmark added');
            }}
            aria-label={isCurrentBookmarked ? 'Remove bookmark' : 'Add bookmark'}
          >
            {isCurrentBookmarked ? '\uD83D\uDD16' : '\u2606'}
          </button>
        )}

        {/* Play/Pause */}
        <button
          className="controls__btn controls__play-btn"
          onClick={handleTogglePlay}
          aria-label={isPlaying ? 'Pause reading' : 'Play reading'}
        >
          {isPlaying ? '\u23F8' : '\u25B6'}
        </button>

      </div>

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
