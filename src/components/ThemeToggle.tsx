import { useTheme, type Theme } from '../hooks/useTheme';

interface ThemeOption {
  value: Theme;
  label: string;
  short: string;
  icon: React.ReactNode;
}

const options: ThemeOption[] = [
  {
    value: 'system',
    label: 'System theme',
    short: 'Auto',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="14" height="10" rx="1.5" />
        <path d="M6 16h6" />
      </svg>
    ),
  },
  {
    value: 'light',
    label: 'Light theme',
    short: 'Light',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="9" r="3" />
        <path d="M9 2v1.5 M9 14.5V16 M2 9h1.5 M14.5 9H16 M4 4l1.1 1.1 M12.9 12.9 14 14 M4 14l1.1-1.1 M12.9 5.1 14 4" />
      </svg>
    ),
  },
  {
    value: 'dark',
    label: 'Dark theme',
    short: 'Dark',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.5 10.5A6 6 0 1 1 7.5 3.5a5 5 0 0 0 7 7z" />
      </svg>
    ),
  },
  {
    value: 'bedtime',
    label: 'Bedtime theme',
    short: 'Bedtime',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12.5 7.5a3.5 3.5 0 0 0-3.5-3.5H5v3" />
        <path d="M2 12h14v2H2z" />
        <path d="M2 10h14" />
      </svg>
    ),
  },
];

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      {options.map((opt) => (
        <button
          key={opt.value}
          className={`theme-toggle__btn${theme === opt.value ? ' theme-toggle__btn--active' : ''}`}
          onClick={() => setTheme(opt.value)}
          role="radio"
          aria-checked={theme === opt.value}
          aria-label={opt.label}
          title={opt.label}
        >
          <span className="theme-toggle__icon">{opt.icon}</span>
          <span className="theme-toggle__label">{opt.short}</span>
        </button>
      ))}
    </div>
  );
}
