import { useState, useEffect, useCallback } from 'react'
import { isNative } from '../lib/platform'

/**
 * Detects when a new service worker is waiting and provides a function
 * to activate it. Works with vite-plugin-pwa's autoUpdate registration.
 *
 * On native (Capacitor), there is no service worker to update, so the hook
 * becomes a no-op.
 */
export function useServiceWorkerUpdate() {
  const [updateAvailable, setUpdateAvailable] = useState(false)

  useEffect(() => {
    if (isNative()) return
    if (!('serviceWorker' in navigator)) return

    const checkForUpdate = async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration()
        if (!reg) return

        // New SW already waiting
        if (reg.waiting) {
          setUpdateAvailable(true)
          return
        }

        // Listen for new SW becoming available
        reg.addEventListener('updatefound', () => {
          const newSW = reg.installing
          if (!newSW) return

          newSW.addEventListener('statechange', () => {
            if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
              setUpdateAvailable(true)
            }
          })
        })
      } catch {
        // SW registration not available
      }
    }

    checkForUpdate()
  }, [])

  const applyUpdate = useCallback(() => {
    // Listen for controller change BEFORE posting SKIP_WAITING to avoid race
    let refreshing = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true
        window.location.reload()
      }
    })

    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg?.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' })
      } else {
        // No waiting SW — force reload as fallback
        window.location.reload()
      }
    }).catch(() => {
      window.location.reload()
    })
  }, [])

  return { updateAvailable, applyUpdate }
}
