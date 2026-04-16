import { useState, useCallback } from 'react'
import { safeGetItem, safeSetItem } from '../lib/safeStorage'

/**
 * Generic hook for preferences persisted in localStorage.
 *
 * @param key       localStorage key
 * @param validate  Returns the value if valid, otherwise undefined
 * @param fallback  Default when storage is empty or invalid
 */
export function useLocalStoragePreference<T extends string>(
  key: string,
  validate: (raw: string) => T | undefined,
  fallback: T,
): [value: T, setValue: (next: T) => void] {
  const [value, setValueState] = useState<T>(() => readStored(key, validate, fallback))

  const setValue = useCallback(
    (next: T) => {
      setValueState(next)
      safeSetItem(key, next)
    },
    [key],
  )

  return [value, setValue]
}

/** Read a preference synchronously, outside of React. */
export function readStoredPreference<T extends string>(
  key: string,
  validate: (raw: string) => T | undefined,
  fallback: T,
): T {
  return readStored(key, validate, fallback)
}

function readStored<T extends string>(
  key: string,
  validate: (raw: string) => T | undefined,
  fallback: T,
): T {
  const raw = safeGetItem(key)
  if (raw != null) {
    const valid = validate(raw)
    if (valid !== undefined) return valid
  }
  return fallback
}
