import { useContext } from 'react';
import { A11yAnnouncerContext } from '../components/A11yAnnouncer';

export function useAnnounce(): { announce: (msg: string) => void } {
  const context = useContext(A11yAnnouncerContext);
  if (!context) {
    throw new Error('useAnnounce must be used within an A11yAnnouncerProvider');
  }
  return context;
}
