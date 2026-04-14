import { useSyncExternalStore, useRef } from 'react'

interface Store<S> {
  getSnapshot(): S
  subscribe(listener: () => void): () => void
}

/**
 * Creates a selector hook for a module-scope store.
 * Equivalent to a minimal Zustand useStore(selector, equalityFn).
 */
export function createSelector<S>(store: Store<S>) {
  return function useSelector<T>(
    selector: (s: S) => T,
    equalityFn: (a: T, b: T) => boolean = Object.is,
  ): T {
    const lastRef = useRef<T | undefined>(undefined)
    const lastSnapshotRef = useRef<S | null>(null)

    const getSelected = (): T => {
      const snapshot = store.getSnapshot()
      if (lastSnapshotRef.current === snapshot && lastRef.current !== undefined) {
        return lastRef.current
      }
      const next = selector(snapshot)
      if (lastRef.current === undefined || !equalityFn(lastRef.current, next)) {
        lastRef.current = next
      }
      lastSnapshotRef.current = snapshot
      return lastRef.current!
    }

    return useSyncExternalStore(store.subscribe, getSelected, getSelected)
  }
}
