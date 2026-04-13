/* ------------------------------------------------------------------ */
/*  segmentRangeIndex                                                  */
/* ------------------------------------------------------------------ */
//
// Pure helpers for mapping reader segments to DOM Ranges inside a
// rendered formatted-view section. The motivation is word-accurate
// highlighting: the proportional / velocity-profile-weighted approach
// can be off by entire lines, especially in chapters with mixed block
// types. Reading the actual rendered text and finding each segment's
// character range gives a Range we can call `getClientRects()` on for
// the real per-line rects.
//
// Why a separate file: the algorithm is pure (TreeWalker + string
// math), easy to unit test, and totally decoupled from React. The
// owning React component (FormattedView) imports the build function,
// caches the result per-section in a ref, and invalidates the cache
// when it rewrites the section innerHTML.
//
// Architecture rule: nothing in this file knows about positionStore,
// the cursor, or React. It takes a DOM element and a list of segment
// texts, returns an array of resolved or null entries. The caller
// decides what to do when an entry is null.

/** A resolved range pointing into the section's text nodes. */
export interface SegmentRange {
  startNode: Text
  startOffset: number
  endNode: Text
  endOffset: number
}

/** One entry per input segment. `null` means the matcher couldn't
 *  locate the segment's text in the rendered DOM — caller should
 *  fall back to a coarser estimate for that one segment. */
export type SegmentRangeIndex = Array<SegmentRange | null>

/** Minimal segment shape the matcher needs. Decoupled from the full
 *  Segment type so this module doesn't depend on parser/db types. */
export interface SegmentLike {
  text: string
}

/* ------------------------------------------------------------------ */
/*  Normalization                                                      */
/* ------------------------------------------------------------------ */

// Whitespace classes we collapse: ASCII whitespace + non-breaking space
// + zero-width characters (commonly found in EPUBs from automated
// formatting tools). NFC normalization handles smart-quote / accent
// composition mismatches between source HTML and chunker output.
const WHITESPACE_RE = /[\s\u00A0\u200B-\u200D\uFEFF]+/g

// Typographic character normalization map. EPUBs frequently use smart
// quotes, em/en dashes, and other typographic characters that may
// differ from the chunker's output (which may use ASCII equivalents,
// or vice versa). Normalizing both sides to ASCII ensures matching.
const TYPOGRAPHIC_MAP: Record<string, string> = {
  '\u2018': "'",  // left single quote
  '\u2019': "'",  // right single quote
  '\u201A': "'",  // single low-9 quote
  '\u201B': "'",  // single high-reversed-9 quote
  '\u201C': '"',  // left double quote
  '\u201D': '"',  // right double quote
  '\u201E': '"',  // double low-9 quote
  '\u201F': '"',  // double high-reversed-9 quote
  '\u2014': '-',  // em dash
  '\u2013': '-',  // en dash
  '\u2012': '-',  // figure dash
  '\u2015': '-',  // horizontal bar
  '\u2026': '...', // ellipsis
  '\u00AB': '"',  // left-pointing double angle quote
  '\u00BB': '"',  // right-pointing double angle quote
  '\u2039': "'",  // single left-pointing angle quote
  '\u203A': "'",  // single right-pointing angle quote
}
const TYPOGRAPHIC_RE = new RegExp(
  '[' + Object.keys(TYPOGRAPHIC_MAP).join('') + ']',
  'g',
)

/** Collapse runs of whitespace to single ASCII spaces, NFC-normalize,
 *  normalize typographic characters, trim. Applied identically to
 *  segment.text and to the DOM-walked text so the comparison is
 *  symmetric. */
export function normalizeSegmentText(s: string): string {
  if (!s) return ''
  return s
    .normalize('NFC')
    .replace(TYPOGRAPHIC_RE, (ch) => TYPOGRAPHIC_MAP[ch] || ch)
    .replace(WHITESPACE_RE, ' ')
    .trim()
}

/** True if a character is whitespace under our normalization rules. */
function isWhitespaceChar(ch: string): boolean {
  return WHITESPACE_RE.test(ch)
}

/* ------------------------------------------------------------------ */
/*  Builder                                                            */
/* ------------------------------------------------------------------ */

/** Walk the section's text nodes, advance a cursor through them, and
 *  match each segment.text in order. Returns one entry per segment.
 *
 *  Performance: O(total characters in the section) with a single linear
 *  pass — sub-millisecond for typical chapters, ~50ms for a 50k-char
 *  chapter. Called once per section after innerHTML lands.
 */
export function buildSegmentRangeIndex(
  sectionEl: HTMLElement,
  segments: ReadonlyArray<SegmentLike>,
): SegmentRangeIndex {
  const result: SegmentRangeIndex = new Array(segments.length).fill(null)
  if (segments.length === 0) return result

  // Collect text nodes in document order, skipping <script>/<style>.
  // We don't filter by visibility because TreeWalker doesn't know about
  // CSS — and the rendered text content is what we want to match,
  // even for elements that happen to be display:none (their Range
  // will produce empty rects on getClientRects, which the caller
  // handles by falling back).
  const textNodes: Text[] = []
  const walker = sectionEl.ownerDocument!.createTreeWalker(
    sectionEl,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        const tag = parent.tagName.toLowerCase()
        if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    },
  )
  let n: Node | null
  while ((n = walker.nextNode())) {
    textNodes.push(n as Text)
  }
  if (textNodes.length === 0) return result

  // Linearized representation of the section's text after
  // normalization, plus a parallel array that maps each character of
  // the linearized string back to (textNodeIndex, charOffset) in the
  // original DOM. The map lets us turn a matched substring [a..b] in
  // the linearized text into Range start/end node+offset.
  const linearChars: string[] = []
  const linearMap: Array<{ nodeIdx: number; offset: number }> = []
  // Track the previous emitted char so we can collapse runs of
  // whitespace WITHIN and ACROSS text nodes the same way the
  // segment.text normalization does.
  let prevWasSpace = true // start of section counts as "leading space" so
                          // a leading run of whitespace is dropped
  for (let i = 0; i < textNodes.length; i++) {
    const data = textNodes[i].data
    for (let j = 0; j < data.length; j++) {
      const ch = data[j]
      if (isWhitespaceChar(ch)) {
        if (prevWasSpace) continue
        linearChars.push(' ')
        linearMap.push({ nodeIdx: i, offset: j })
        prevWasSpace = true
      } else {
        // Typographic normalization: replace smart quotes, em dashes,
        // etc. with their ASCII equivalents so segment.text and DOM
        // text compare identically. For multi-char replacements
        // (ellipsis → "...") all output chars point to the same
        // source offset — the Range only needs the start/end boundaries.
        const replacement = TYPOGRAPHIC_MAP[ch]
        if (replacement) {
          for (let k = 0; k < replacement.length; k++) {
            linearChars.push(replacement[k])
            linearMap.push({ nodeIdx: i, offset: j })
          }
        } else {
          linearChars.push(ch)
          linearMap.push({ nodeIdx: i, offset: j })
        }
        prevWasSpace = false
      }
    }
  }
  // Trim trailing space the same way normalizeSegmentText does.
  while (linearChars.length > 0 && linearChars[linearChars.length - 1] === ' ') {
    linearChars.pop()
    linearMap.pop()
  }
  const linear = linearChars.join('').normalize('NFC')

  // Sequential matcher: walk segments in order, advance a cursor
  // through `linear`, find each segment as a substring starting at or
  // after the cursor. Sequential preserves order so identical text
  // appearing twice (e.g. "the") is resolved to the right occurrence.
  //
  // PERF GUARD RAILS — these matter for big books:
  //
  //   1. Per-segment search distance cap. If `target` doesn't appear
  //      within MAX_SEARCH_DISTANCE characters of the cursor, give up
  //      on that segment. The default JavaScript `indexOf` walks to the
  //      END of the string on every miss, so an unmatched segment in a
  //      1M-char book is O(1M) — and 20K unmatched segments would be
  //      ~20 BILLION character comparisons. Capping at e.g. 50K chars
  //      bounds the worst-case to ~1B which is still slow but won't
  //      block the main thread for 27 seconds.
  //
  //   2. Wall-clock budget. Bail out of the entire build after
  //      MAX_BUILD_MS. The remaining segments are marked null and the
  //      caller falls back to the proportional band for them. A
  //      partially-built index is far better than blocking playback.
  //
  // Both guards are no-ops on books where the matcher is fast (most
  // plain prose). They only kick in when something's gone wrong with
  // text→DOM normalization (e.g. an EPUB with typographic substitutions
  // the parser stripped but the rendered HTML preserves).
  const MAX_SEARCH_DISTANCE = 50000
  const MAX_BUILD_MS = 200
  const buildStart =
    typeof performance !== 'undefined' ? performance.now() : Date.now()
  const linearLen = linear.length

  let cursor = 0
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const target = normalizeSegmentText(segments[segIdx].text)
    if (target.length === 0) continue

    // Wall-clock guard. Check every 50 segments to avoid the cost of
    // performance.now() per iteration on fast books.
    if (segIdx % 50 === 0) {
      const now =
        typeof performance !== 'undefined' ? performance.now() : Date.now()
      if (now - buildStart > MAX_BUILD_MS) {
        // Out of budget — leave the rest as null. Fallback band will
        // render for those segments.
        break
      }
    }

    // Bound the indexOf search by truncating the haystack to the
    // window we're willing to search. Slicing a string is O(n) on
    // creation but the indexOf inside is bounded so the worst-case
    // total is O(MAX_SEARCH_DISTANCE) per call instead of O(linearLen).
    const searchEnd = Math.min(linearLen, cursor + MAX_SEARCH_DISTANCE)
    const haystack =
      searchEnd === linearLen ? linear : linear.slice(0, searchEnd)
    const found = haystack.indexOf(target, cursor)
    if (found === -1) {
      // Couldn't find this segment within the search window. Don't
      // advance — the next segment might still match. Caller falls
      // back to proportional for null entries.
      result[segIdx] = null
      continue
    }
    const startMap = linearMap[found]
    const endMap = linearMap[found + target.length - 1]
    if (!startMap || !endMap) {
      result[segIdx] = null
      continue
    }
    result[segIdx] = {
      startNode: textNodes[startMap.nodeIdx],
      startOffset: startMap.offset,
      endNode: textNodes[endMap.nodeIdx],
      // endOffset is exclusive in Range; the map gave us the index of
      // the last matched character, so add 1.
      endOffset: endMap.offset + 1,
    }
    cursor = found + target.length
  }

  return result
}

/* ------------------------------------------------------------------ */
/*  Materialization                                                    */
/* ------------------------------------------------------------------ */

export interface RectInContainer {
  topPx: number
  leftPx: number
  widthPx: number
  heightPx: number
}

/** Materialize a SegmentRange into one or more rects in the
 *  container's scroll-coordinate system. Returns the per-line rects
 *  from `range.getClientRects()` (one per visual line) so the caller
 *  can render multi-line bands that hug the actual text. */
export function materializeRangeRects(
  range: SegmentRange,
  container: HTMLElement,
): RectInContainer[] {
  const r = container.ownerDocument!.createRange()
  try {
    r.setStart(range.startNode, range.startOffset)
    r.setEnd(range.endNode, range.endOffset)
  } catch {
    return []
  }
  const containerRect = container.getBoundingClientRect()
  const scrollTop = container.scrollTop
  const scrollLeft = container.scrollLeft
  const rects = r.getClientRects()
  const out: RectInContainer[] = []
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i]
    if (rect.width === 0 || rect.height === 0) continue
    out.push({
      topPx: rect.top - containerRect.top + scrollTop,
      leftPx: rect.left - containerRect.left + scrollLeft,
      widthPx: rect.width,
      heightPx: Math.max(2, rect.height),
    })
  }
  return out
}
