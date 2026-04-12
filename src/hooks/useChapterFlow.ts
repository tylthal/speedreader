import { useState, useCallback } from 'react'

export type ChapterFlow = 'continuous' | 'pause'

const STORAGE_KEY = 'speedreader-chapter-flow'

function readStored(): ChapterFlow {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'continuous' || v === 'pause') return v
  } catch {
    /* localStorage unavailable */
  }
  return 'continuous'
}

interface UseChapterFlowReturn {
  chapterFlow: ChapterFlow
  setChapterFlow: (flow: ChapterFlow) => void
  stopAtChapterEnd: boolean
}

export function useChapterFlow(): UseChapterFlowReturn {
  const [flow, setFlow] = useState<ChapterFlow>(readStored)

  const setChapterFlow = useCallback((next: ChapterFlow) => {
    setFlow(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* localStorage unavailable */
    }
  }, [])

  return { chapterFlow: flow, setChapterFlow, stopAtChapterEnd: flow === 'pause' }
}

/** Read chapter flow synchronously, outside of React. */
export function readChapterFlow(): ChapterFlow {
  return readStored()
}
