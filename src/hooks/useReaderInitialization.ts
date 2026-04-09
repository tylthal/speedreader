import { useEffect, useState } from 'react'
import { markNavigationStart } from '../lib/ttfcMetric'
import { positionStore } from '../state/position/positionStore'
import {
  loadReaderBootstrap,
  type ReaderBootstrapResult,
} from '../lib/readerBootstrap'

export type ReaderInitializationState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; position: ReaderBootstrapResult }

export function useReaderInitialization(
  publicationId: number,
): ReaderInitializationState {
  const [initState, setInitState] = useState<ReaderInitializationState>({
    status: 'loading',
  })

  useEffect(() => {
    markNavigationStart()
  }, [])

  useEffect(() => {
    let cancelled = false

    loadReaderBootstrap(publicationId)
      .then((bootstrap) => {
        if (cancelled) return
        positionStore.init(bootstrap.seed)

        setInitState({
          status: 'ready',
          position: bootstrap,
        })
      })
      .catch((err) => {
        if (cancelled) return

        setInitState({
          status: 'error',
          message:
            err instanceof Error ? err.message : 'Failed to load publication',
        })
      })

    return () => {
      cancelled = true
    }
  }, [publicationId])

  return initState
}
