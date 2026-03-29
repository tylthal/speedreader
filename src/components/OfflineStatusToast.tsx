import { useState, useEffect, useRef } from 'react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export default function OfflineStatusToast() {
  const isOnline = useOnlineStatus();
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState('');
  const [variant, setVariant] = useState<'offline' | 'online'>('offline');
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hasBeenOfflineRef = useRef(false);

  useEffect(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
    }

    if (!isOnline) {
      hasBeenOfflineRef.current = true;
      setVariant('offline');
      setMessage("You're offline — cached content is still available");
      setVisible(true);
    } else if (hasBeenOfflineRef.current) {
      setVariant('online');
      setMessage('Back online');
      setVisible(true);
      hideTimerRef.current = setTimeout(() => {
        setVisible(false);
      }, 5000);
    }

    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
    };
  }, [isOnline]);

  if (!visible) return null;

  return (
    <div className={`offline-toast offline-toast--${variant}`}>
      <span className="offline-toast__message">{message}</span>
    </div>
  );
}
