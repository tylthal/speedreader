import { useState, useEffect, useCallback, useRef } from 'react'
import { Capacitor } from '@capacitor/core'
import { getBoolPref, getPref, setPref, PREF_KEYS } from '../lib/uiPrefs'

type Platform = 'ios' | 'android' | 'desktop' | 'unknown'

export interface InstallPromptState {
  canInstall: boolean
  isInstalled: boolean
  platform: Platform
  install: () => Promise<void>
  dismiss: () => void
  isDismissed: boolean
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

function readDismissed(): boolean {
  const iso = getPref('installBannerDismissedAt')
  if (!iso) return false
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return false
  // Treat future timestamps as "now" to survive clock skew.
  const age = Math.max(0, Date.now() - ts)
  return age < DISMISS_TTL_MS
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua) && /Safari|CriOS/.test(ua)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Windows|Macintosh|Linux/.test(ua) && !/Android/.test(ua)) return 'desktop'
  return 'unknown'
}

function detectInstalled(): boolean {
  if (window.matchMedia('(display-mode: standalone)').matches) return true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((navigator as any).standalone === true) return true
  return false
}

const NATIVE_STATE: InstallPromptState = {
  canInstall: false,
  isInstalled: true,
  platform: (typeof navigator !== 'undefined' && Capacitor.getPlatform() === 'ios' ? 'ios' : 'android') as Platform,
  install: async () => {},
  dismiss: () => {},
  isDismissed: false,
}

export function useInstallPrompt(): InstallPromptState {
  const isNativePlatform = Capacitor.isNativePlatform()

  const [platform] = useState<Platform>(detectPlatform)
  const [isInstalled] = useState<boolean>(detectInstalled)
  const [isDismissed, setIsDismissed] = useState<boolean>(readDismissed)
  const [hasEverImported, setHasEverImported] = useState<boolean>(() =>
    getBoolPref('hasEverImported'),
  )
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const promptRef = useRef<BeforeInstallPromptEvent | null>(null)

  // Pick up the flag when a first import completes in another hook/page.
  useEffect(() => {
    if (hasEverImported) return
    const onStorage = (e: StorageEvent) => {
      if (e.key === PREF_KEYS.hasEverImported && e.newValue === '1') {
        setHasEverImported(true)
      }
    }
    const onFocus = () => {
      if (getBoolPref('hasEverImported')) setHasEverImported(true)
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', onFocus)
    }
  }, [hasEverImported])

  useEffect(() => {
    if (isNativePlatform) return
    const handler = (e: Event) => {
      e.preventDefault()
      const evt = e as BeforeInstallPromptEvent
      promptRef.current = evt
      setPromptEvent(evt)
    }

    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [isNativePlatform])

  const install = useCallback(async () => {
    const evt = promptRef.current
    if (!evt) return
    try {
      await evt.prompt()
      const choice = await evt.userChoice
      if (choice.outcome === 'accepted') {
        promptRef.current = null
        setPromptEvent(null)
      }
    } catch {
      // Install prompt cancelled or unavailable on this browser
      promptRef.current = null
      setPromptEvent(null)
    }
  }, [])

  const dismiss = useCallback(() => {
    setIsDismissed(true)
    setPref('installBannerDismissedAt', new Date().toISOString())
  }, [])

  // On native Capacitor apps, there is no install prompt
  if (isNativePlatform) return NATIVE_STATE

  const canInstall = (() => {
    if (isInstalled) return false
    if (!hasEverImported) return false
    if (platform === 'android' && promptEvent !== null) return true
    if (platform === 'ios') return true
    if (platform === 'desktop' && promptEvent !== null) return true
    return false
  })()

  return {
    canInstall,
    isInstalled,
    platform,
    install,
    dismiss,
    isDismissed,
  }
}
