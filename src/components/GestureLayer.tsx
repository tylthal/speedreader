import type { ReactNode } from 'react';
import { useGestures } from '../hooks/useGestures';

interface GestureLayerProps {
  onTap?: () => void;
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  enabled?: boolean;
  children: ReactNode;
}

export default function GestureLayer({
  onTap,
  onSwipeUp,
  onSwipeDown,
  onSwipeLeft,
  onSwipeRight,
  enabled = true,
  children,
}: GestureLayerProps) {
  // Always listen for taps (so user can tap to resume when paused).
  // Only listen for swipes when enabled.
  const pointerHandlers = useGestures({
    onTap,
    onSwipeUp: enabled ? onSwipeUp : undefined,
    onSwipeDown: enabled ? onSwipeDown : undefined,
    onSwipeLeft: enabled ? onSwipeLeft : undefined,
    onSwipeRight: enabled ? onSwipeRight : undefined,
  });

  return (
    <div
      className={`gesture-layer ${!enabled ? 'gesture-layer--passthrough' : ''}`}
      aria-hidden="true"
      {...pointerHandlers}
    >
      {children}
    </div>
  );
}
