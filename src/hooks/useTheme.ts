import { useState, useEffect, useCallback } from 'react';

export type Theme = 'light' | 'dark' | 'bedtime' | 'evening' | 'forest' | 'ocean' | 'system';
export type ResolvedTheme = 'light' | 'dark' | 'bedtime' | 'evening' | 'forest' | 'ocean';

interface UseThemeReturn {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const STORAGE_KEY = 'speedreader-theme';
const DARK_MQ = '(prefers-color-scheme: dark)';

const ALL_THEMES: Theme[] = ['system', 'light', 'dark', 'evening', 'bedtime', 'forest', 'ocean'];

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia(DARK_MQ).matches ? 'dark' : 'light';
}

function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'system') return getSystemTheme();
  return theme;
}

const META_THEME_COLORS: Record<ResolvedTheme, string> = {
  dark: '#1C1C1E',
  light: '#FAF9F6',
  bedtime: '#1a0f0a',
  evening: '#1A1A2E',
  forest: '#1A2118',
  ocean: '#0F1923',
};

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.setAttribute('data-theme', resolved);
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', META_THEME_COLORS[resolved]);
  }

  // Sync native status bar on Capacitor
  import('../lib/platform').then(({ isNative }) => {
    if (!isNative()) return;
    import('@capacitor/status-bar').then(({ StatusBar, Style }) => {
      const isDark = resolved !== 'light';
      StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light }).catch(() => {});
      StatusBar.setBackgroundColor({ color: META_THEME_COLORS[resolved] }).catch(() => {});
    }).catch(() => {});
  });
}

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && ALL_THEMES.includes(stored as Theme)) {
      return stored as Theme;
    }
  } catch {
    // localStorage unavailable
  }
  return 'system';
}

export function useTheme(): UseThemeReturn {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(readStoredTheme())
  );

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    try {
      localStorage.setItem(STORAGE_KEY, newTheme);
    } catch {
      // localStorage unavailable
    }
  }, []);

  // Apply theme whenever theme preference changes
  useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    applyTheme(resolved);
  }, [theme]);

  // Listen for system preference changes when in 'system' mode
  useEffect(() => {
    if (theme !== 'system') return;

    const mql = window.matchMedia(DARK_MQ);
    const handler = () => {
      const resolved = getSystemTheme();
      setResolvedTheme(resolved);
      applyTheme(resolved);
    };

    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [theme]);

  return { theme, resolvedTheme, setTheme };
}
