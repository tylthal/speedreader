import type { Segment } from '../api/types'

/**
 * Extract a text snippet (~maxChars) starting from a given segment/word position.
 * Used as the preview text when creating bookmarks.
 */
export function extractSnippet(
  segments: Segment[],
  absoluteSegmentIndex: number,
  wordIndex: number,
  maxChars = 50,
): string {
  const seg = segments.find((s) => s.segment_index === absoluteSegmentIndex)
  if (!seg) return ''

  const words = seg.text.split(/\s+/).filter(Boolean)
  const startWords = words.slice(wordIndex)

  let text = startWords.join(' ')

  // If we don't have enough text from this segment, pull from subsequent segments
  if (text.length < maxChars) {
    const segIdx = segments.indexOf(seg)
    for (let i = segIdx + 1; i < segments.length && text.length < maxChars; i++) {
      text += ' ' + segments[i].text
    }
  }

  if (text.length <= maxChars) return text
  // Truncate at word boundary
  const truncated = text.slice(0, maxChars)
  const lastSpace = truncated.lastIndexOf(' ')
  return (lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated) + '...'
}
