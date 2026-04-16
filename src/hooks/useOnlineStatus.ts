import { useState, useEffect } from 'react';
import { isNative } from '../lib/platform';

export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(() =>
    isNative() ? true : navigator.onLine
  );

  useEffect(() => {
    // On native (Capacitor), navigator.onLine is meaningless and the app is
    // always considered "online" from the webview's perspective. Skip
    // attaching listeners entirely.
    if (isNative()) return;
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}
