import { useState, useEffect } from 'react';

interface StorageInfo {
  usage: number;
  quota: number;
  persisted: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function StorageStatus() {
  const [info, setInfo] = useState<StorageInfo | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function checkStorage() {
      if (!navigator.storage?.estimate) return;

      try {
        const estimate = await navigator.storage.estimate();
        let persisted = false;

        if (navigator.storage.persist) {
          persisted = await navigator.storage.persist();
        }

        if (!cancelled) {
          setInfo({
            usage: estimate.usage ?? 0,
            quota: estimate.quota ?? 0,
            persisted,
          });
        }
      } catch {
        // Storage API not available
      }
    }

    checkStorage();
    return () => { cancelled = true; };
  }, []);

  if (!info || info.quota === 0) return null;

  const usagePercent = (info.usage / info.quota) * 100;
  const isWarning = usagePercent > 80;

  return (
    <div className="storage-status">
      <div className="storage-status__header">
        <span className="storage-status__label">
          Storage: {formatBytes(info.usage)} / {formatBytes(info.quota)}
        </span>
        {info.persisted && (
          <span className="storage-status__persisted">Persistent</span>
        )}
      </div>
      <div className="storage-status__bar">
        <div
          className={`storage-status__fill${isWarning ? ' storage-status__fill--warning' : ''}`}
          style={{ width: `${Math.min(usagePercent, 100)}%` }}
        />
      </div>
      {isWarning && (
        <p className="storage-status__warning">
          Storage usage is above 80%. Consider removing unused books.
        </p>
      )}
    </div>
  );
}
