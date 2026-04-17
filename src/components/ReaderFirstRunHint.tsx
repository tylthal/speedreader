import { useEffect } from 'react';

interface ReaderFirstRunHintProps {
  onDismiss: () => void;
}

export default function ReaderFirstRunHint({ onDismiss }: ReaderFirstRunHintProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onDismiss();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      className="reader-hint"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reader-hint-title"
      onClick={onDismiss}
    >
      <div className="reader-hint__body">
        <h3 id="reader-hint-title" className="reader-hint__title">Quick tips</h3>
        <ul className="reader-hint__list">
          <li className="reader-hint__item">
            <span className="reader-hint__icon">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="4" />
                <circle cx="11" cy="11" r="8.5" opacity="0.35" />
              </svg>
            </span>
            <span>Tap anywhere to pause or resume.</span>
          </li>
          <li className="reader-hint__item">
            <span className="reader-hint__icon">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 3v16" />
                <path d="M6 8l5-5 5 5" />
                <path d="M6 14l5 5 5-5" />
              </svg>
            </span>
            <span>Swipe up or down to adjust reading speed.</span>
          </li>
          <li className="reader-hint__item">
            <span className="reader-hint__icon">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 11h16" />
                <path d="M8 6l-5 5 5 5" />
                <path d="M14 6l5 5-5 5" />
              </svg>
            </span>
            <span>Swipe left or right to jump chapters.</span>
          </li>
        </ul>
        <button type="button" className="reader-hint__cta" onClick={onDismiss}>
          Got it
        </button>
      </div>
    </div>
  );
}
