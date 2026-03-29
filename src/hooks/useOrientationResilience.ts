import { useState, useEffect, useRef, useCallback } from 'react';

type Orientation = 'portrait' | 'landscape';

function getCurrentOrientation(): Orientation {
  if (typeof window === 'undefined') return 'portrait';
  return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
}

export function useOrientationResilience(onOrientationChange?: () => void) {
  const [orientation, setOrientation] = useState<Orientation>(getCurrentOrientation);
  const callbackRef = useRef(onOrientationChange);
  callbackRef.current = onOrientationChange;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleChange = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      const newOrientation = getCurrentOrientation();
      setOrientation((prev) => {
        if (prev !== newOrientation) {
          callbackRef.current?.();
        }
        return newOrientation;
      });
    }, 200);
  }, []);

  useEffect(() => {
    window.addEventListener('orientationchange', handleChange);
    window.addEventListener('resize', handleChange);
    return () => {
      window.removeEventListener('orientationchange', handleChange);
      window.removeEventListener('resize', handleChange);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [handleChange]);

  return orientation;
}
