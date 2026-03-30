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
  const pointerHandlers = useGestures({
    onTap,
    onSwipeUp,
    onSwipeDown,
    onSwipeLeft,
    onSwipeRight,
  });

  return (
    <div
      className={`gesture-layer ${!enabled ? 'gesture-layer--passthrough' : ''}`}
      aria-hidden="true"
      {...(enabled ? pointerHandlers : {})}
    >
      {children}
    </div>
  );
}
