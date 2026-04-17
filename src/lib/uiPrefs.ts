/**
 * Typed localStorage wrapper for mobile-UX preference flags.
 * Falls back silently when storage is unavailable (private mode, iOS quota).
 */

export const PREF_KEYS = {
  hasEverImported: 'speedreader.hasEverImported',
  installBannerDismissedAt: 'speedreader.installBannerDismissedAt',
  swipeHintShown: 'speedreader.swipeHintShown',
  librarySort: 'speedreader.librarySort',
  readerHintSeen: 'speedreader.readerHintSeen.v1',
  readerFontScale: 'speedreader.reader.fontScale',
  readerLineHeight: 'speedreader.reader.lineHeight',
  readerColumnWidth: 'speedreader.reader.columnWidth',
  gazeSensitivity: 'speedreader.gazeSensitivity',
} as const;

export type PrefKey = keyof typeof PREF_KEYS;

export function getPref(key: PrefKey): string | null {
  try {
    return localStorage.getItem(PREF_KEYS[key]);
  } catch {
    return null;
  }
}

export function setPref(key: PrefKey, value: string): void {
  try {
    localStorage.setItem(PREF_KEYS[key], value);
  } catch {
    // storage unavailable
  }
}

export function removePref(key: PrefKey): void {
  try {
    localStorage.removeItem(PREF_KEYS[key]);
  } catch {
    // storage unavailable
  }
}

export function getBoolPref(key: PrefKey): boolean {
  return getPref(key) === '1';
}

export function setBoolPref(key: PrefKey, value: boolean): void {
  if (value) setPref(key, '1');
  else removePref(key);
}

export function getNumberPref(key: PrefKey, fallback: number): number {
  const raw = getPref(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function setNumberPref(key: PrefKey, value: number): void {
  setPref(key, String(value));
}
