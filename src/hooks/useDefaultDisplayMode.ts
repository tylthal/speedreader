import { useState, useCallback } from 'react'
import type { DisplayMode } from '../api/types'

const STORAGE_KEY = 'speedreader-default-display-mode'

function readStored(): DisplayMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'plain' || v === 'formatted') return v
  } catch {
    /* localStorage unavailable */
  }
  return 'plain' // PRD §4.1 — Plain text is the default
}

interface UseDefaultDisplayModeReturn {
  defaultDisplayMode: DisplayMode
  setDefaultDisplayMode: (mode: DisplayMode) => void
}

export function useDefaultDisplayMode(): UseDefaultDisplayModeReturn {
  const [mode, setMode] = useState<DisplayMode>(readStored)

  const setDefaultDisplayMode = useCallback((next: DisplayMode) => {
    setMode(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* localStorage unavailable */
    }
  }, [])

  return { defaultDisplayMode: mode, setDefaultDisplayMode }
}

/** Read the default display mode synchronously, outside of React. */
export function readDefaultDisplayMode(): DisplayMode {
  return readStored()
}
