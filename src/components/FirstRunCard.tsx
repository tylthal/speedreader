import { ACCEPTED_FORMAT_LABELS } from './UploadFAB';

interface FirstRunCardProps {
  onImport: () => void;
}

interface ModeBlurb {
  name: string;
  blurb: string;
  icon: React.ReactNode;
}

const MODES: ModeBlurb[] = [
  {
    name: 'Focus',
    blurb: 'One phrase at a time, so your eyes don’t wander.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="7" width="16" height="8" rx="1.5" />
        <path d="M7 11h8" />
      </svg>
    ),
  },
  {
    name: 'Word',
    blurb: 'Rapid single-word presentation — pick up 500+ WPM with practice.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="4" />
        <path d="M11 3v2 M11 17v2 M3 11h2 M17 11h2" />
      </svg>
    ),
  },
  {
    name: 'Scroll',
    blurb: 'Teleprompter-style auto-scroll at your pace.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 3v16" />
        <path d="M6 8l5-5 5 5" />
        <path d="M6 14l5 5 5-5" />
      </svg>
    ),
  },
  {
    name: 'Hands-free',
    blurb: 'Nod your head to advance — camera-based, never leaves your device.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="8" r="3.5" />
        <path d="M4 19c1-3.5 4-5 7-5s6 1.5 7 5" />
      </svg>
    ),
  },
];

export default function FirstRunCard({ onImport }: FirstRunCardProps) {
  return (
    <section className="first-run-card" aria-labelledby="first-run-title">
      <div className="first-run-card__headline">
        <h2 id="first-run-title" className="first-run-card__title">Welcome to SpeedReader</h2>
        <p className="first-run-card__lede">
          A private, local-first reader with four ways to move through a book.
        </p>
      </div>

      <ul className="first-run-card__modes" aria-label="Reading modes">
        {MODES.map((m) => (
          <li key={m.name} className="first-run-card__mode">
            <span className="first-run-card__mode-icon" aria-hidden="true">{m.icon}</span>
            <div className="first-run-card__mode-body">
              <h3 className="first-run-card__mode-name">{m.name}</h3>
              <p className="first-run-card__mode-blurb">{m.blurb}</p>
            </div>
          </li>
        ))}
      </ul>

      <div className="first-run-card__privacy">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 2l6 2v5c0 4-2.6 7-6 8-3.4-1-6-4-6-8V4l6-2z" />
          <path d="M6.5 9.2l1.7 1.8 3.3-3.4" />
        </svg>
        <span>Everything stays on this device. No accounts, no sync, no uploads.</span>
      </div>

      <button
        className="first-run-card__cta"
        type="button"
        onClick={onImport}
      >
        Import your first book
      </button>

      <div className="first-run-card__formats">
        <span className="first-run-card__formats-label">Works with</span>
        <ul className="first-run-card__format-chips" aria-label="Supported formats">
          {ACCEPTED_FORMAT_LABELS.map((f) => (
            <li key={f} className="first-run-card__format-chip">{f}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
