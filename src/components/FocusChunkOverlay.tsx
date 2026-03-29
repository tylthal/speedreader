import { useState, useEffect, useRef } from 'react';
import type { Segment } from '../types';
import type { ReadingMode } from '../types';
import RsvpDisplay from './RsvpDisplay';

interface FocusChunkOverlayProps {
  segment: Segment | null;
  isPlaying: boolean;
  progress: number;
  mode: ReadingMode;
  rsvpWord?: string;
  rsvpOrpIndex?: number;
  rsvpWpm?: number;
}

export default function FocusChunkOverlay({
  segment,
  isPlaying,
  progress,
  mode,
  rsvpWord = '',
  rsvpOrpIndex = 0,
  rsvpWpm = 250,
}: FocusChunkOverlayProps) {
  const [displayText, setDisplayText] = useState('');
  const [animClass, setAnimClass] = useState('focus-overlay__text--visible');
  const prevTextRef = useRef('');

  useEffect(() => {
    const newText = segment?.text ?? '';
    if (newText !== prevTextRef.current) {
      setAnimClass('focus-overlay__text--entering');
      const timer = setTimeout(() => {
        setDisplayText(newText);
        prevTextRef.current = newText;
        setAnimClass('focus-overlay__text--visible');
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [segment]);

  const showPrompt = !isPlaying && !segment;

  if (mode === 'rsvp') {
    return (
      <div
        className="focus-overlay"
        role="region"
        aria-roledescription="RSVP speed reading display"
        aria-label="RSVP reading display"
      >
        <RsvpDisplay
          currentWord={rsvpWord}
          orpIndex={rsvpOrpIndex}
          isPlaying={isPlaying}
          wpm={rsvpWpm}
          progress={progress}
        />
      </div>
    );
  }

  return (
    <div
      className="focus-overlay"
      role="region"
      aria-roledescription="speed reading display"
      aria-label="Current reading segment"
    >
      {showPrompt ? (
        <span className="focus-overlay__prompt">Tap to start</span>
      ) : (
        <span className={`focus-overlay__text ${animClass}`}>{displayText}</span>
      )}
      <div
        className="focus-overlay__progress"
        role="progressbar"
        aria-valuenow={Math.round(progress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Reading progress"
      >
        <div
          className="focus-overlay__progress-bar"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}
