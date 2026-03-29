import { useState, useEffect } from 'react';

export function useDataSaver(): boolean {
  const [isDataSaver, setIsDataSaver] = useState(() => {
    // Check Network Information API
    const conn = (navigator as any).connection;
    return conn?.saveData === true;
  });

  useEffect(() => {
    const conn = (navigator as any).connection;
    if (!conn) return;

    const handler = () => {
      setIsDataSaver(conn.saveData === true);
    };

    conn.addEventListener('change', handler);
    return () => conn.removeEventListener('change', handler);
  }, []);

  return isDataSaver;
}
