import { useEffect, useRef } from 'react';
import { isNative } from '../lib/platform';

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
        import('@capacitor-community/keep-awake').then(({ KeepAwake }) => {
          KeepAwake.keepAwake().catch(() => {});
        });
      } else {
        import('@capacitor-community/keep-awake').then(({ KeepAwake }) => {
          KeepAwake.allowSleep().catch(() => {});
        });
      }
      return () => {
        import('@capacitor-community/keep-awake').then(({ KeepAwake }) => {
          KeepAwake.allowSleep().catch(() => {});
        });
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
