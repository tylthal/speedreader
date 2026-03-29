import { useEffect, useRef } from 'react';

interface KeyboardHandlers {
  onTogglePlay?: () => void;
  onSpeedUp?: () => void;
  onSpeedDown?: () => void;
  onNextChunk?: () => void;
  onPrevChunk?: () => void;
  onNextChapter?: () => void;
  onPrevChapter?: () => void;
}

export function useKeyboardHandling(handlers: KeyboardHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when an input or textarea is focused
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const h = handlersRef.current;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          h.onTogglePlay?.();
          break;
        case 'ArrowUp':
          e.preventDefault();
          h.onSpeedUp?.();
          break;
        case 'ArrowDown':
          e.preventDefault();
          h.onSpeedDown?.();
          break;
        case 'ArrowRight':
          e.preventDefault();
          h.onNextChunk?.();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          h.onPrevChunk?.();
          break;
        case 'n':
        case 'PageDown':
          e.preventDefault();
          h.onNextChapter?.();
          break;
        case 'p':
        case 'PageUp':
          e.preventDefault();
          h.onPrevChapter?.();
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
