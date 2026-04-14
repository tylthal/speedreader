import { useState, useCallback } from 'react'

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
      try {
        localStorage.setItem(key, next)
      } catch {
        /* localStorage unavailable */
      }
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
  try {
    const raw = localStorage.getItem(key)
    if (raw != null) {
      const valid = validate(raw)
      if (valid !== undefined) return valid
    }
  } catch {
    /* localStorage unavailable */
  }
  return fallback
}
