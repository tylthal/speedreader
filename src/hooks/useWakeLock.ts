import { useEffect, useRef } from 'react';
import { isNative } from '../lib/platform';

/** Cached dynamic import to avoid repeated round-trips. */
let keepAwakePromise: Promise<typeof import('@capacitor-community/keep-awake')> | null = null;

function getKeepAwake() {
  if (!keepAwakePromise) {
    keepAwakePromise = import('@capacitor-community/keep-awake');
  }
  return keepAwakePromise;
}

/**
 * Prevents the screen from dimming/sleeping while active.
 * Uses @capacitor-community/keep-awake on native (Web Wake Lock API
 * is unsupported in iOS WKWebView), falls back to Web Wake Lock on web.
 */
export function useWakeLock(active: boolean): void {
  const lockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (isNative()) {
      // Native path: use KeepAwake plugin
      if (active) {
        getKeepAwake().then(({ KeepAwake }) => {
          KeepAwake.keepAwake().catch((err) => {
            if (import.meta.env.DEV) console.warn('[WakeLock] keepAwake failed:', err);
          });
        }).catch((err) => {
          if (import.meta.env.DEV) console.warn('[WakeLock] import failed:', err);
        });
      } else {
        getKeepAwake().then(({ KeepAwake }) => {
          KeepAwake.allowSleep().catch(() => {});
        }).catch(() => {});
      }
      return () => {
        getKeepAwake().then(({ KeepAwake }) => {
          KeepAwake.allowSleep().catch(() => {});
        }).catch(() => {});
      };
    }

    // Web path: use Wake Lock API
    if (!active) {
      lockRef.current?.release().catch(() => {});
      lockRef.current = null;
      return;
    }

    if (!('wakeLock' in navigator)) return;

    const acquire = async () => {
      try {
        lockRef.current = await navigator.wakeLock.request('screen');
      } catch {
        // Wake lock request failed (e.g., low battery, browser restriction)
      }
    };

    acquire();

    // Re-acquire when page becomes visible (browser releases lock on hide)
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && active) {
        acquire();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      lockRef.current?.release().catch(() => {});
      lockRef.current = null;
    };
  }, [active]);
}
