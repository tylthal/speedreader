import { useSyncExternalStore, useRef } from 'react'

interface Store<S> {
  getSnapshot(): S
  subscribe(listener: () => void): () => void
}

/**
 * Creates a selector hook for a module-scope store.
 * Equivalent to a minimal Zustand useStore(selector, equalityFn).
 *
 * We rely on `useSyncExternalStore`'s built-in snapshot-identity bailout
 * and only add the custom `equalityFn` layer so that selectors returning
 * new object/array shapes with structurally-equal content (e.g. composite
 * selectors using `shallowEqual`) don't force re-renders.
 */
export function createSelector<S>(store: Store<S>) {
  return function useSelector<T>(
    selector: (s: S) => T,
    equalityFn: (a: T, b: T) => boolean = Object.is,
  ): T {
    const lastRef = useRef<T | undefined>(undefined)

    const getSelected = (): T => {
      const next = selector(store.getSnapshot())
      if (lastRef.current === undefined || !equalityFn(lastRef.current, next)) {
        lastRef.current = next
      }
      return lastRef.current!
    }

    return useSyncExternalStore(store.subscribe, getSelected, getSelected)
  }
}
