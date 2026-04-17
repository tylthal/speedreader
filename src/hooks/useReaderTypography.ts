import { useCallback, useEffect, useState } from 'react';
import { getPref, setPref } from '../lib/uiPrefs';

/**
 * Global reader typography preferences (font scale, line height,
 * column width) persisted in localStorage. Applied as CSS custom
 * properties on the `.reader-viewport` element so formatted view,
 * focus overlay, scroll items, and RSVP wings all stay in sync.
 */

export const FONT_SCALES = {
  small: 0.9,
  medium: 1.0,
  large: 1.15,
} as const;

export const LINE_HEIGHTS = {
  tight: 1.45,
  normal: 1.65,
  loose: 1.85,
} as const;

export const COLUMN_WIDTHS = {
  narrow: 560,
  default: 680,
  wide: 820,
} as const;

export type FontScaleKey = keyof typeof FONT_SCALES;
export type LineHeightKey = keyof typeof LINE_HEIGHTS;
export type ColumnWidthKey = keyof typeof COLUMN_WIDTHS;

export interface ReaderTypography {
  fontScale: FontScaleKey;
  lineHeight: LineHeightKey;
  columnWidth: ColumnWidthKey;
}

const DEFAULTS: ReaderTypography = {
  fontScale: 'medium',
  lineHeight: 'normal',
  columnWidth: 'default',
};

function readInitial(): ReaderTypography {
  const fs = getPref('readerFontScale') as FontScaleKey | null;
  const lh = getPref('readerLineHeight') as LineHeightKey | null;
  const cw = getPref('readerColumnWidth') as ColumnWidthKey | null;
  return {
    fontScale: (fs && fs in FONT_SCALES) ? fs : DEFAULTS.fontScale,
    lineHeight: (lh && lh in LINE_HEIGHTS) ? lh : DEFAULTS.lineHeight,
    columnWidth: (cw && cw in COLUMN_WIDTHS) ? cw : DEFAULTS.columnWidth,
  };
}

export function useReaderTypography(): {
  typography: ReaderTypography;
  setFontScale: (key: FontScaleKey) => void;
  setLineHeight: (key: LineHeightKey) => void;
  setColumnWidth: (key: ColumnWidthKey) => void;
  cssVars: Record<string, string | number>;
} {
  const [typography, setTypography] = useState<ReaderTypography>(readInitial);

  useEffect(() => {
    setPref('readerFontScale', typography.fontScale);
    setPref('readerLineHeight', typography.lineHeight);
    setPref('readerColumnWidth', typography.columnWidth);
  }, [typography]);

  const setFontScale = useCallback((fontScale: FontScaleKey) => {
    setTypography((t) => ({ ...t, fontScale }));
  }, []);
  const setLineHeight = useCallback((lineHeight: LineHeightKey) => {
    setTypography((t) => ({ ...t, lineHeight }));
  }, []);
  const setColumnWidth = useCallback((columnWidth: ColumnWidthKey) => {
    setTypography((t) => ({ ...t, columnWidth }));
  }, []);

  const cssVars: Record<string, string | number> = {
    '--reader-font-scale': FONT_SCALES[typography.fontScale],
    '--reader-line-height': LINE_HEIGHTS[typography.lineHeight],
    '--reader-column-max': `${COLUMN_WIDTHS[typography.columnWidth]}px`,
  };

  return { typography, setFontScale, setLineHeight, setColumnWidth, cssVars };
}
