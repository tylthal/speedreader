import type { DisplayMode } from '../api/types'
import { useLocalStoragePreference, readStoredPreference } from './useLocalStoragePreference'

const KEY = 'speedreader-default-display-mode'
const validate = (v: string): DisplayMode | undefined =>
  v === 'plain' || v === 'formatted' ? v : undefined

interface UseDefaultDisplayModeReturn {
  defaultDisplayMode: DisplayMode
  setDefaultDisplayMode: (mode: DisplayMode) => void
}

export function useDefaultDisplayMode(): UseDefaultDisplayModeReturn {
  const [defaultDisplayMode, setDefaultDisplayMode] = useLocalStoragePreference<DisplayMode>(
    KEY,
    validate,
    'formatted',
  )
  return { defaultDisplayMode, setDefaultDisplayMode }
}

/** Read the default display mode synchronously, outside of React. */
export function readDefaultDisplayMode(): DisplayMode {
  return readStoredPreference(KEY, validate, 'formatted')
}
