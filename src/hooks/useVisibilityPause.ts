import { useEffect, useRef } from 'react';

export function useVisibilityPause(
  isPlaying: boolean,
  onPause: () => void,
  onResume: () => void
) {
  // Track whether we auto-paused due to visibility
  const autoPausedRef = useRef(false);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && isPlaying) {
        autoPausedRef.current = true;
        onPause();
      } else if (!document.hidden && autoPausedRef.current) {
        autoPausedRef.current = false;
        onResume();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isPlaying, onPause, onResume]);
}
