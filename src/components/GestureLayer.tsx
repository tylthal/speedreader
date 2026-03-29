import type { ReactNode } from 'react';
import { useGestures } from '../hooks/useGestures';

interface GestureLayerProps {
  onTap?: () => void;
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  children: ReactNode;
}

export default function GestureLayer({
  onTap,
  onSwipeUp,
  onSwipeDown,
  onSwipeLeft,
  onSwipeRight,
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
    <div className="gesture-layer" aria-hidden="true" {...pointerHandlers}>
      {children}
    </div>
  );
}
