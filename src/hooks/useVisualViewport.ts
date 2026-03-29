import { useState, useEffect } from 'react';

interface VisualViewportState {
  viewportHeight: number;
  isKeyboardOpen: boolean;
}

export function useVisualViewport(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(() => ({
    viewportHeight: typeof window !== 'undefined'
      ? (window.visualViewport?.height ?? window.innerHeight)
      : 0,
    isKeyboardOpen: false,
  }));

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const viewportHeight = vv.height;
      const layoutHeight = window.innerHeight;
      const isKeyboardOpen = layoutHeight - viewportHeight > 150;
      setState({ viewportHeight, isKeyboardOpen });
    };

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return state;
}
