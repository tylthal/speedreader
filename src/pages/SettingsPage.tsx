import { useEffect, useState } from 'react';
import { useTheme, type Theme } from '../hooks/useTheme';
import { useDefaultDisplayMode } from '../hooks/useDefaultDisplayMode';
import { useChapterFlow, type ChapterFlow } from '../hooks/useChapterFlow';
import { getPublications, type DisplayMode } from '../db/localClient';
import StorageStatus from '../components/StorageStatus';
import Accordion from '../components/Accordion';

interface ThemeOption {
  value: Theme;
  label: string;
  description: string;
  preview: string; // CSS color for preview swatch
  icon: string;
}

const themeOptions: ThemeOption[] = [
  { value: 'system', label: 'System', description: 'Match your device', preview: 'linear-gradient(135deg, #1C1C1E 50%, #FAF9F6 50%)', icon: '\u2699' },
  { value: 'light', label: 'Light', description: 'Warm paper feel', preview: '#FAF9F6', icon: '\u2600' },
  { value: 'dark', label: 'Dark', description: 'Easy on the eyes', preview: '#1C1C1E', icon: '\u263E' },
  { value: 'evening', label: 'Evening', description: 'Reduces eye strain', preview: '#1A1A2E', icon: '\uD83C\uDF19' },
  { value: 'bedtime', label: 'Bedtime', description: 'No blue light', preview: '#1a0f0a', icon: '\uD83D\uDECF' },
  { value: 'forest', label: 'Forest', description: 'Earthy & calm', preview: '#1A2118', icon: '\uD83C\uDF3F' },
  { value: 'ocean', label: 'Ocean', description: 'Deep & tranquil', preview: '#0F1923', icon: '\uD83C\uDF0A' },
];

interface DisplayModeOption {
  value: DisplayMode;
  label: string;
  description: string;
}

const displayModeOptions: DisplayModeOption[] = [
  { value: 'plain', label: 'Plain text', description: 'Speed-reader view' },
  { value: 'formatted', label: 'Formatted', description: 'Original layout' },
];

interface ChapterFlowOption {
  value: ChapterFlow;
  label: string;
  description: string;
}

const chapterFlowOptions: ChapterFlowOption[] = [
  { value: 'continuous', label: 'Auto-continue', description: 'Keeps reading into the next chapter' },
  { value: 'pause', label: 'Pause', description: 'Stops at each chapter break' },
];

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { defaultDisplayMode, setDefaultDisplayMode } = useDefaultDisplayMode();
  const { chapterFlow, setChapterFlow } = useChapterFlow();
  const [bookCount, setBookCount] = useState<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getPublications()
      .then((pubs) => { if (!cancelled) setBookCount(pubs.length); })
      .catch(() => { if (!cancelled) setBookCount(undefined); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="app-page app-page--settings" role="main" aria-label="Settings" id="main-content">
      <header className="page-header">
        <h1 className="page-header__title">Settings</h1>
        <p className="page-header__subtitle">Customize your reading experience</p>
      </header>

      <Accordion title="Appearance" defaultOpen>
        <p className="settings-section__description">
          Choose a theme that suits your environment. Evening and Bedtime themes are designed to reduce eye strain during night reading.
        </p>
        <div className="theme-grid theme-grid--scroll" role="radiogroup" aria-label="Choose theme">
          {themeOptions.map((opt) => (
            <button
              key={opt.value}
              className={`theme-option${theme === opt.value ? ' theme-option--active' : ''}`}
              onClick={() => setTheme(opt.value)}
              role="radio"
              aria-checked={theme === opt.value}
              aria-label={`${opt.label} theme: ${opt.description}`}
            >
              <div
                className="theme-option__swatch"
                style={{ background: opt.preview }}
              >
                <span className="theme-option__icon">{opt.icon}</span>
              </div>
              <span className="theme-option__label">{opt.label}</span>
              <span className="theme-option__desc">{opt.description}</span>
            </button>
          ))}
        </div>
      </Accordion>

      <Accordion title="Reading">
        <p className="settings-section__description">
          The default display mode is used the first time you open a new book. Each book can be toggled individually from the reader.
        </p>
        <div className="theme-grid theme-grid--compact" role="radiogroup" aria-label="Default display mode for new books">
          {displayModeOptions.map((opt) => (
            <button
              key={opt.value}
              className={`theme-option${defaultDisplayMode === opt.value ? ' theme-option--active' : ''}`}
              onClick={() => setDefaultDisplayMode(opt.value)}
              role="radio"
              aria-checked={defaultDisplayMode === opt.value}
              aria-label={`${opt.label}: ${opt.description}`}
            >
              <span className="theme-option__label">{opt.label}</span>
              <span className="theme-option__desc">{opt.description}</span>
            </button>
          ))}
        </div>

        <h3 className="settings-section__subtitle">Chapter flow</h3>
        <p className="settings-section__description">
          Controls whether playback continues automatically into the next chapter or pauses at each break.
        </p>
        <div className="theme-grid theme-grid--compact" role="radiogroup" aria-label="Chapter flow">
          {chapterFlowOptions.map((opt) => (
            <button
              key={opt.value}
              className={`theme-option${chapterFlow === opt.value ? ' theme-option--active' : ''}`}
              onClick={() => setChapterFlow(opt.value)}
              role="radio"
              aria-checked={chapterFlow === opt.value}
              aria-label={`${opt.label}: ${opt.description}`}
            >
              <span className="theme-option__label">{opt.label}</span>
              <span className="theme-option__desc">{opt.description}</span>
            </button>
          ))}
        </div>
      </Accordion>

      <Accordion title="Hands-free reading">
        <p className="settings-section__description">
          Hands-free mode is designed for reading without touching the screen. Tracking runs on-device and only while you choose that mode.
        </p>
        <div className="settings-about settings-about--compact">
          <div className="settings-about__row">
            <span className="settings-about__label">Privacy</span>
            <span className="settings-about__value">Camera input stays on this device</span>
          </div>
          <div className="settings-about__row">
            <span className="settings-about__label">Tune it</span>
            <span className="settings-about__value">Open Tracking options in the reader</span>
          </div>
          <div className="settings-about__row">
            <span className="settings-about__label">Reset</span>
            <span className="settings-about__value">Recalibrate any time from that panel</span>
          </div>
        </div>
      </Accordion>

      <Accordion title="Storage">
        <p className="settings-section__description">
          Books are stored locally on your device. No data is sent to any server.
        </p>
        <StorageStatus bookCount={bookCount} />
      </Accordion>

      <Accordion title="About">
        <div className="settings-about">
          <div className="settings-about__row">
            <span className="settings-about__label">App</span>
            <span className="settings-about__value">SpeedReader</span>
          </div>
          <div className="settings-about__row">
            <span className="settings-about__label">Storage</span>
            <span className="settings-about__value">Local only (IndexedDB + OPFS)</span>
          </div>
          <div className="settings-about__row">
            <span className="settings-about__label">Formats</span>
            <span className="settings-about__value">EPUB, PDF, DOCX, FB2, HTML, MD, TXT, RTF, CBZ</span>
          </div>
        </div>
      </Accordion>
    </div>
  );
}
