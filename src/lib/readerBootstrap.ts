import {
  getAutoBookmark,
  getPublication,
  type Chapter,
  type ContentType,
  type DisplayMode as ApiDisplayMode,
  type TocNode,
} from '../api/client'
import { readDefaultDisplayMode } from '../hooks/useDefaultDisplayMode'
import type { DisplayMode } from '../state/position/types'
import type { ReadingMode } from '../types'
import { readStoredPrefs, readStoredPosition, pickFreshestPosition, resolveWpmForMode } from './readerProgress'

export interface ReaderBootstrapSeed {
  chapterId: number
  chapterIdx: number
  absoluteSegmentIndex: number
  wordIndex: number
  scrollTop: number
  wpm: number
  mode: ReadingMode
  displayMode: DisplayMode
  isPlaying: false
}

export interface ReaderBootstrapResult {
  seed: ReaderBootstrapSeed
  chapters: Chapter[]
  tocTree: TocNode[] | null
  contentType: ContentType
  bookTitle: string
}

const VALID_MODES: ReadingMode[] = ['phrase', 'rsvp', 'scroll', 'track']

function coerceMode(raw: string): ReadingMode {
  if ((VALID_MODES as readonly string[]).includes(raw)) return raw as ReadingMode
  if (raw === 'eyetrack') return 'track'
  return 'phrase'
}

export async function loadReaderBootstrap(
  publicationId: number,
): Promise<ReaderBootstrapResult> {
  const [pub, lastOpenedBookmark] = await Promise.all([
    getPublication(publicationId),
    getAutoBookmark(publicationId, 'last_opened').catch(() => null),
  ])

  const chapters = [...pub.chapters].sort(
    (a, b) => a.chapter_index - b.chapter_index,
  )

  if (chapters.length === 0) {
    throw new Error('No chapters found in this publication.')
  }

  // Pick the freshest position: IndexedDB bookmark vs localStorage snapshot
  const localSnapshot = readStoredPosition(publicationId)
  const position = pickFreshestPosition(lastOpenedBookmark, localSnapshot)

  // Restore preferences from localStorage
  const prefs = readStoredPrefs(publicationId)

  let chapterIdx = 0
  let absoluteSegmentIndex = 0
  let wordIndex = 0
  let wpm = 250
  let readingMode: ReadingMode = 'phrase'

  let scrollTop = 0

  if (position) {
    const restoredChapterIdx = chapters.findIndex(
      (chapter) => chapter.id === position.chapter_id,
    )
    if (restoredChapterIdx !== -1) {
      chapterIdx = restoredChapterIdx
      absoluteSegmentIndex = position.absolute_segment_index
      wordIndex = position.word_index ?? 0
      // scroll_top comes from localStorage only (not IndexedDB bookmark)
      scrollTop = (position as { scroll_top?: number }).scroll_top ?? 0
      // Read-side clamp: rescue users whose localStorage was poisoned
      // with a negative scroll_top by a pre-fix build. A negative
      // scrollTop fed into useFormattedViewCursorSync's restore-direct
      // path would pass the `snap.scrollTop > 0` check as false and
      // fall through to segment-center — but the positionStore would
      // still carry the negative value, so this is belt-and-braces.
      if (!Number.isFinite(scrollTop) || scrollTop < 0) scrollTop = 0
    }
  }

  if (prefs) {
    readingMode = coerceMode(prefs.readingMode)
    wpm = resolveWpmForMode(prefs, readingMode)
  }

  const initialDisplayMode: ApiDisplayMode =
    pub.display_mode_pref ?? readDefaultDisplayMode()

  return {
    seed: {
      chapterId: chapters[chapterIdx].id,
      chapterIdx,
      absoluteSegmentIndex,
      wordIndex,
      scrollTop,
      wpm,
      mode: readingMode,
      displayMode: initialDisplayMode as DisplayMode,
      isPlaying: false,
    },
    chapters,
    tocTree: pub.toc_tree ?? null,
    contentType: (pub.content_type ?? 'text') as ContentType,
    bookTitle: pub.title,
  }
}
