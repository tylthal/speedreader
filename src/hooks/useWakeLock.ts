import { useEffect, useRef } from 'react';

/**
 * Prevents the screen from dimming/sleeping while active.
 * Acquires a Wake Lock when `active` is true, releases when false.
 * Re-acquires automatically when the page becomes visible again
 * (wake locks are released on visibility change by the browser).
 */
export function useWakeLock(active: boolean): void {
  const lockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
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
