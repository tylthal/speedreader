import { useLocalStoragePreference, readStoredPreference } from './useLocalStoragePreference'

export type ChapterFlow = 'continuous' | 'pause'

const KEY = 'speedreader-chapter-flow'
const validate = (v: string): ChapterFlow | undefined =>
  v === 'continuous' || v === 'pause' ? v : undefined

interface UseChapterFlowReturn {
  chapterFlow: ChapterFlow
  setChapterFlow: (flow: ChapterFlow) => void
  stopAtChapterEnd: boolean
}

export function useChapterFlow(): UseChapterFlowReturn {
  const [chapterFlow, setChapterFlow] = useLocalStoragePreference<ChapterFlow>(
    KEY,
    validate,
    'continuous',
  )
  return { chapterFlow, setChapterFlow, stopAtChapterEnd: chapterFlow === 'pause' }
}

/** Read chapter flow synchronously, outside of React. */
export function readChapterFlow(): ChapterFlow {
  return readStoredPreference(KEY, validate, 'continuous')
}
