/** Shared text normalization utilities for parsers. */

export const WHITESPACE_RE = /\s+/g

/** Collapse all whitespace runs to single spaces and trim. */
export function normalizeWhitespace(text: string): string {
  return text.replace(WHITESPACE_RE, ' ').trim()
}
