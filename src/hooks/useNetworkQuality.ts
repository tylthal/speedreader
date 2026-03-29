import { useState, useEffect } from 'react';

interface NetworkQuality {
  effectiveType: '4g' | '3g' | '2g' | 'slow-2g' | 'unknown';
  downlink: number; // Mbps estimate
  rtt: number; // ms estimate
  saveData: boolean;
}

const DEFAULT_QUALITY: NetworkQuality = {
  effectiveType: 'unknown',
  downlink: 10,
  rtt: 50,
  saveData: false,
};

function readConnection(): NetworkQuality {
  const conn = (navigator as any).connection;
  if (!conn) return DEFAULT_QUALITY;

  return {
    effectiveType: conn.effectiveType ?? 'unknown',
    downlink: conn.downlink ?? 10,
    rtt: conn.rtt ?? 50,
    saveData: conn.saveData === true,
  };
}

export function useNetworkQuality(): NetworkQuality {
  const [quality, setQuality] = useState<NetworkQuality>(readConnection);

  useEffect(() => {
    const conn = (navigator as any).connection;
    if (!conn) return;

    const handler = () => {
      setQuality(readConnection());
    };

    conn.addEventListener('change', handler);
    return () => conn.removeEventListener('change', handler);
  }, []);

  return quality;
}
