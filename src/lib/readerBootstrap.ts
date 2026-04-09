import {
  getProgress,
  getPublication,
  type Chapter,
  type ContentType,
  type DisplayMode as ApiDisplayMode,
  type TocNode,
} from '../api/client'
import { readDefaultDisplayMode } from '../hooks/useDefaultDisplayMode'
import type { DisplayMode } from '../state/position/types'
import type { ReadingMode } from '../types'
import { pickFreshestProgress, readStoredProgress } from './readerProgress'

export interface ReaderBootstrapSeed {
  chapterId: number
  chapterIdx: number
  absoluteSegmentIndex: number
  wordIndex: number
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
  const [pub, apiProgress] = await Promise.all([
    getPublication(publicationId),
    getProgress(publicationId).catch(() => null),
  ])

  const chapters = [...pub.chapters].sort(
    (a, b) => a.chapter_index - b.chapter_index,
  )

  if (chapters.length === 0) {
    throw new Error('No chapters found in this publication.')
  }

  const progress = pickFreshestProgress(
    apiProgress,
    readStoredProgress(publicationId),
  )

  let chapterIdx = 0
  let absoluteSegmentIndex = 0
  let wordIndex = 0
  let wpm = 250
  let readingMode: ReadingMode = 'phrase'

  if (progress) {
    const restoredChapterIdx = chapters.findIndex(
      (chapter) => chapter.id === progress.chapter_id,
    )
    if (restoredChapterIdx !== -1) {
      chapterIdx = restoredChapterIdx
      absoluteSegmentIndex = progress.absolute_segment_index
      wordIndex = progress.word_index ?? 0
      wpm = progress.wpm
      readingMode = coerceMode(progress.reading_mode)
    }
  }

  const initialDisplayMode: ApiDisplayMode =
    pub.display_mode_pref ?? readDefaultDisplayMode()

  return {
    seed: {
      chapterId: chapters[chapterIdx].id,
      chapterIdx,
      absoluteSegmentIndex,
      wordIndex,
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
