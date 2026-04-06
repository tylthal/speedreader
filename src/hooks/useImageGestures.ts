import { useRef, useCallback, useEffect } from 'react';

interface UseImageGesturesOptions {
  onNextPage: () => void;
  onPrevPage: () => void;
  onZoomChange: (scale: number) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function useImageGestures({
  onNextPage,
  onPrevPage,
  onZoomChange,
  containerRef,
}: UseImageGesturesOptions) {
  const scale = useRef(1);
  const translateX = useRef(0);
  const translateY = useRef(0);

  // Touch tracking
  const touchStart = useRef<{ x: number; y: number; time: number } | null>(null);
  const pinchStart = useRef<number | null>(null);
  const pinchStartScale = useRef(1);

  const applyTransform = useCallback(() => {
    const el = containerRef.current?.querySelector('.image-page-viewer__img') as HTMLElement;
    if (el) {
      el.style.transform = `translate(${translateX.current}px, ${translateY.current}px) scale(${scale.current})`;
    }
  }, [containerRef]);

  const resetZoom = useCallback(() => {
    scale.current = 1;
    translateX.current = 0;
    translateY.current = 0;
    applyTransform();
    onZoomChange(1);
  }, [applyTransform, onZoomChange]);

  const setZoom = useCallback((newScale: number) => {
    scale.current = Math.max(0.5, Math.min(5, newScale));
    if (scale.current <= 1.05) {
      scale.current = 1;
      translateX.current = 0;
      translateY.current = 0;
    }
    applyTransform();
    onZoomChange(scale.current);
  }, [applyTransform, onZoomChange]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const getDistance = (t1: Touch, t2: Touch) => {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinchStart.current = getDistance(e.touches[0], e.touches[1]);
        pinchStartScale.current = scale.current;
        return;
      }
      if (e.touches.length === 1) {
        touchStart.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
          time: Date.now(),
        };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchStart.current !== null) {
        e.preventDefault();
        const dist = getDistance(e.touches[0], e.touches[1]);
        const newScale = pinchStartScale.current * (dist / pinchStart.current);
        setZoom(newScale);
        return;
      }

      if (e.touches.length === 1 && scale.current > 1 && touchStart.current) {
        e.preventDefault();
        const dx = e.touches[0].clientX - touchStart.current.x;
        const dy = e.touches[0].clientY - touchStart.current.y;
        translateX.current += dx;
        translateY.current += dy;
        touchStart.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
          time: touchStart.current.time,
        };
        applyTransform();
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (pinchStart.current !== null && e.touches.length < 2) {
        pinchStart.current = null;
        return;
      }

      if (touchStart.current && e.changedTouches.length === 1 && scale.current <= 1) {
        const dx = e.changedTouches[0].clientX - touchStart.current.x;
        const elapsed = Date.now() - touchStart.current.time;

        if (elapsed < 300 && Math.abs(dx) > 50) {
          if (dx < 0) onNextPage();
          else onPrevPage();
        }
      }

      touchStart.current = null;
    };

    // Double tap to zoom
    let lastTap = 0;
    const onDoubleTap = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const now = Date.now();
      if (now - lastTap < 300) {
        e.preventDefault();
        if (scale.current > 1) {
          resetZoom();
        } else {
          setZoom(2);
        }
      }
      lastTap = now;
    };

    el.addEventListener('touchstart', onDoubleTap, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', onDoubleTap);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [containerRef, onNextPage, onPrevPage, applyTransform, resetZoom, setZoom]);

  return { scale: scale.current, resetZoom, setZoom };
}
