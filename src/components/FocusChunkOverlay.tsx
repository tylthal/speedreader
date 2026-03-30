import { useState, useEffect, useRef, useMemo } from 'react';
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
  segments?: Segment[];
  currentIndex?: number;
}

const WING_COUNT = 3;

function getWingOpacity(distFromCenter: number, total: number): number {
  if (total <= 1) return 0.4;
  return 0.6 - (distFromCenter / total) * 0.4;
}

export default function FocusChunkOverlay({
  segment,
  isPlaying,
  progress,
  mode,
  rsvpWord = '',
  rsvpOrpIndex = 0,
  rsvpWpm = 250,
  segments,
  currentIndex,
}: FocusChunkOverlayProps) {
  const [displayText, setDisplayText] = useState('');
  const [animClass, setAnimClass] = useState('focus-overlay__text--visible');
  const prevTextRef = useRef('');
  const [wingsVisible, setWingsVisible] = useState(false);

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

  useEffect(() => {
    if (!isPlaying && segment) {
      const timer = setTimeout(() => setWingsVisible(true), 120);
      return () => clearTimeout(timer);
    } else {
      setWingsVisible(false);
    }
  }, [isPlaying, segment]);

  const wings = useMemo(() => {
    if (!segments || currentIndex == null) return { before: [], after: [] };
    const before: Segment[] = [];
    const after: Segment[] = [];
    for (let i = Math.max(0, currentIndex - WING_COUNT); i < currentIndex; i++) {
      before.push(segments[i]);
    }
    for (let i = currentIndex + 1; i <= Math.min(segments.length - 1, currentIndex + WING_COUNT); i++) {
      after.push(segments[i]);
    }
    return { before, after };
  }, [segments, currentIndex]);

  const showPrompt = !isPlaying && !segment;

  const renderWings = (items: Segment[], direction: 'before' | 'after') => (
    <div
      className={`focus-overlay__wings ${wingsVisible ? 'focus-overlay__wings--visible' : ''}`}
      aria-hidden="true"
    >
      {items.map((seg, i) => {
        const dist = direction === 'before'
          ? items.length - i   // first item = farthest
          : i + 1;             // last item = farthest
        return (
          <span
            key={seg.id}
            className="focus-overlay__wing-segment"
            style={{ opacity: getWingOpacity(dist, items.length + 1) }}
          >
            {seg.text}
          </span>
        );
      })}
    </div>
  );

  if (mode === 'rsvp') {
    return (
      <div
        className="focus-overlay"
        role="region"
        aria-roledescription="RSVP speed reading display"
        aria-label="RSVP reading display"
      >
        {renderWings(wings.before, 'before')}

        {!isPlaying && wingsVisible ? (
          <span className="focus-overlay__text focus-overlay__text--visible">
            {segment?.text ?? ''}
          </span>
        ) : (
          <RsvpDisplay
            currentWord={rsvpWord}
            orpIndex={rsvpOrpIndex}
            isPlaying={isPlaying}
            wpm={rsvpWpm}
            progress={progress}
          />
        )}

        {renderWings(wings.after, 'after')}
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
      {renderWings(wings.before, 'before')}

      {showPrompt ? (
        <span className="focus-overlay__prompt">Tap to start</span>
      ) : (
        <span className={`focus-overlay__text ${animClass}`}>{displayText}</span>
      )}

      {renderWings(wings.after, 'after')}

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
