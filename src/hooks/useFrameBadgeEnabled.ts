import { useEffect, useState } from 'react'
import { safeGetItem, safeSetItem } from '../lib/safeStorage'

const KEY = 'speedreader.frameBadgeEnabled'

const subscribers = new Set<(v: boolean) => void>()

function read(): boolean {
  return safeGetItem(KEY) === '1'
}

export function useFrameBadgeEnabled(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(read)

  useEffect(() => {
    const cb = (v: boolean) => setEnabled(v)
    subscribers.add(cb)
    return () => {
      subscribers.delete(cb)
    }
  }, [])

  const set = (next: boolean) => {
    safeSetItem(KEY, next ? '1' : '0')
    subscribers.forEach((cb) => cb(next))
  }

  return [enabled, set]
}
