import { useState, useEffect, useCallback, useRef } from 'react'

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

const SESSION_KEY = 'install-nudge-dismissed'

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

export function useInstallPrompt(): InstallPromptState {
  const [platform] = useState<Platform>(detectPlatform)
  const [isInstalled] = useState<boolean>(detectInstalled)
  const [isDismissed, setIsDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(SESSION_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const promptRef = useRef<BeforeInstallPromptEvent | null>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault()
      const evt = e as BeforeInstallPromptEvent
      promptRef.current = evt
      setPromptEvent(evt)
    }

    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const install = useCallback(async () => {
    const evt = promptRef.current
    if (!evt) return
    await evt.prompt()
    const choice = await evt.userChoice
    if (choice.outcome === 'accepted') {
      promptRef.current = null
      setPromptEvent(null)
    }
  }, [])

  const dismiss = useCallback(() => {
    setIsDismissed(true)
    try {
      sessionStorage.setItem(SESSION_KEY, 'true')
    } catch {
      // sessionStorage unavailable
    }
  }, [])

  const canInstall = (() => {
    if (isInstalled) return false
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
