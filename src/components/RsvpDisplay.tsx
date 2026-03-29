interface RsvpDisplayProps {
  currentWord: string;
  orpIndex: number;
  isPlaying: boolean;
  wpm: number;
  progress: number;
}

export default function RsvpDisplay({
  currentWord,
  orpIndex,
  isPlaying,
  wpm,
  progress,
}: RsvpDisplayProps) {
  const showPrompt = !isPlaying && !currentWord;

  const leftPart = currentWord.slice(0, orpIndex);
  const orpChar = currentWord[orpIndex] ?? '';
  const rightPart = currentWord.slice(orpIndex + 1);

  return (
    <div
      className="rsvp-container"
      role="region"
      aria-roledescription="RSVP speed reading display"
      aria-label="Current word"
    >
      {showPrompt ? (
        <span className="focus-overlay__prompt">RSVP Mode — Tap to start</span>
      ) : (
        <div className="rsvp-display" aria-live="off">
          <span className="rsvp-display__left">{leftPart}</span>
          <span className="rsvp-display__orp">{orpChar}</span>
          <span className="rsvp-display__right">{rightPart}</span>
        </div>
      )}
      <div className="rsvp-info">
        <span className="rsvp-info__wpm">{wpm} WPM</span>
        <span className="rsvp-info__progress">{Math.round(progress * 100)}%</span>
      </div>
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
