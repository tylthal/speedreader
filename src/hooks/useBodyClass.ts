import { useEffect } from 'react';

/**
 * Toggle a class on <body> while the calling component is mounted and `active`.
 * Used to let CSS reserve bottom-safe-area budget when overlays like the install
 * banner are mounted, so FAB / toasts / nav padding can respond declaratively.
 */
export function useBodyClass(className: string, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    document.body.classList.add(className);
    return () => {
      document.body.classList.remove(className);
    };
  }, [className, active]);
}
