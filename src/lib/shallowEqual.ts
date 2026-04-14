/**
 * Shallow equality for plain objects. Returns true if a and b have the
 * same set of enumerable own keys and every corresponding value is
 * Object.is-equal.
 *
 * Used with createSelector's equalityFn to make composite slice
 * selectors stable across commits — the selector returns a fresh
 * object each call, but `usePositionSelector(fn, shallowEqual)` keeps
 * the old reference when every key is unchanged, so consumers can put
 * the slice directly in effect deps without spurious reruns.
 */
export function shallowEqual<T extends Record<string, unknown>>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (a == null || b == null) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i]
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!Object.is(a[key], b[key])) return false
  }
  return true
}
