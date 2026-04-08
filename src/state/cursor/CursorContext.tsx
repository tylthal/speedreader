/* ------------------------------------------------------------------ */
/*  CursorContext                                                      */
/* ------------------------------------------------------------------ */
//
// Two-context split for hot-path performance.
//
//   CursorRefContext     — stable ref. Engine rAF loops read this without
//                          subscribing, so word-level RSVP ticks at 4-12 Hz
//                          don't trigger React renders downstream.
//   CursorStateContext   — re-rendering subscriber. Useful for components
//                          like FocusChunkOverlay or the controls sheet
//                          that need to re-render on commit (~6 Hz worst).
//   CursorDispatchContext — stable dispatch function. Always free to call.
//
// useCursorSelector is the recommended subscription path: pulls a slice
// from CursorStateContext and short-circuits on equality so unrelated
// commits don't re-render every consumer.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
} from 'react'

import {
  cursorReducer,
  type CursorAction,
} from './reducer'
import {
  initialCursorRootState,
  type CursorRootState,
} from './types'

const CursorStateContext = createContext<CursorRootState>(initialCursorRootState)
const CursorRefContext = createContext<MutableRefObject<CursorRootState>>({
  current: initialCursorRootState,
})
const CursorDispatchContext = createContext<Dispatch<CursorAction>>(() => {
  /* no-op default */
})

interface CursorProviderProps {
  initial?: CursorRootState
  children: ReactNode
}

export function CursorProvider({
  initial = initialCursorRootState,
  children,
}: CursorProviderProps) {
  const [state, baseDispatch] = useReducer(cursorReducer, initial)

  // Stable ref kept in sync with the latest reducer state. Engines that
  // need to read the cursor inside their rAF loop go through this — no
  // subscription, no re-render. We update it eagerly inside dispatch so
  // any synchronous follow-up call sees the new value.
  const stateRef = useRef<CursorRootState>(state)
  stateRef.current = state

  const dispatch = useCallback<Dispatch<CursorAction>>(
    (action) => {
      // Compute the next state synchronously so stateRef is updated
      // before the React re-render. The reducer is pure so this double-
      // application is safe — useReducer will arrive at the same value.
      stateRef.current = cursorReducer(stateRef.current, action)
      baseDispatch(action)
    },
    [],
  )

  // The state ref object is stable; only its .current changes.
  const refValue = useMemo(() => stateRef, [])

  return (
    <CursorRefContext.Provider value={refValue}>
      <CursorDispatchContext.Provider value={dispatch}>
        <CursorStateContext.Provider value={state}>
          {children}
        </CursorStateContext.Provider>
      </CursorDispatchContext.Provider>
    </CursorRefContext.Provider>
  )
}

/* ------------------------------------------------------------------ */
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

/** Subscribes to the entire cursor root state — re-renders on every commit. */
export function useCursorState(): CursorRootState {
  return useContext(CursorStateContext)
}

/** Stable ref to the latest cursor root state. Does NOT subscribe.
 *  Read this from inside a tick loop or imperative handler. */
export function useCursorRef(): MutableRefObject<CursorRootState> {
  return useContext(CursorRefContext)
}

/** Stable dispatch function. */
export function useCursorDispatch(): Dispatch<CursorAction> {
  return useContext(CursorDispatchContext)
}

/** Slice subscription with equality short-circuit. */
export function useCursorSelector<T>(
  selector: (state: CursorRootState) => T,
  equalityFn: (a: T, b: T) => boolean = Object.is,
): T {
  const state = useContext(CursorStateContext)
  const selected = selector(state)
  const ref = useRef<T>(selected)
  // Update ref only when equality fails. Returning the cached value when
  // equal lets downstream useEffect/useMemo deps see referential stability.
  if (!equalityFn(ref.current, selected)) {
    ref.current = selected
  }
  return ref.current
}

export { CursorStateContext, CursorRefContext, CursorDispatchContext }
