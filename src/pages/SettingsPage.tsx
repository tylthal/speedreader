import { useTheme, type Theme } from '../hooks/useTheme';
import StorageStatus from '../components/StorageStatus';

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
  { value: 'bedtime', label: 'Bedtime', description: 'No blue light', preview: '#1a0f0a', icon: '\u2B50' },
  { value: 'forest', label: 'Forest', description: 'Earthy & calm', preview: '#1A2118', icon: '\uD83C\uDF3F' },
  { value: 'ocean', label: 'Ocean', description: 'Deep & tranquil', preview: '#0F1923', icon: '\uD83C\uDF0A' },
];

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="app-page" role="main" aria-label="Settings" id="main-content">
      <header className="page-header">
        <h1 className="page-header__title">Settings</h1>
        <p className="page-header__subtitle">Customize your reading experience</p>
      </header>

      {/* Theme selection */}
      <section className="settings-section">
        <h2 className="settings-section__title">Appearance</h2>
        <p className="settings-section__description">
          Choose a theme that suits your environment. Evening and Bedtime themes are designed to reduce eye strain during night reading.
        </p>
        <div className="theme-grid" role="radiogroup" aria-label="Choose theme">
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
      </section>

      {/* Storage */}
      <section className="settings-section">
        <h2 className="settings-section__title">Storage</h2>
        <p className="settings-section__description">
          Books are stored locally on your device. No data is sent to any server.
        </p>
        <StorageStatus />
      </section>

      {/* Reading (placeholder) */}
      <section className="settings-section">
        <h2 className="settings-section__title">Reading</h2>
        <div className="settings-placeholder">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <line x1="8" y1="9" x2="16" y2="9" />
            <line x1="8" y1="13" x2="13" y2="13" />
          </svg>
          <span>Reading preferences coming soon</span>
        </div>
      </section>

      {/* About */}
      <section className="settings-section">
        <h2 className="settings-section__title">About</h2>
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
      </section>
    </div>
  );
}
