import { createContext, useState, useCallback, useRef, type ReactNode } from 'react';

export interface A11yAnnouncerContextType {
  announce: (message: string) => void;
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
export const A11yAnnouncerContext = createContext<A11yAnnouncerContextType>(undefined!);

export function A11yAnnouncerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const announce = useCallback((msg: string) => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
    }
    // Clear first, then set after a tick so screen readers pick up repeated identical messages
    setMessage('');
    clearTimerRef.current = setTimeout(() => {
      setMessage(msg);
      clearTimerRef.current = setTimeout(() => {
        setMessage('');
      }, 100);
    }, 50);
  }, []);

  return (
    <A11yAnnouncerContext.Provider value={{ announce }}>
      {children}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="visually-hidden"
      >
        {message}
      </div>
    </A11yAnnouncerContext.Provider>
  );
}
