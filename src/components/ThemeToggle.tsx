import { useTheme, type Theme } from '../hooks/useTheme';

const options: { value: Theme; label: string; icon: string }[] = [
  { value: 'system', label: 'System theme', icon: '\u2699' },   // gear
  { value: 'light', label: 'Light theme', icon: '\u2600' },     // sun
  { value: 'dark', label: 'Dark theme', icon: '\u263E' },       // moon
  { value: 'bedtime', label: 'Bedtime theme', icon: '\uD83D\uDECF' }, // bed
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
          {opt.icon}
        </button>
      ))}
    </div>
  );
}
