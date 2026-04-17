import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { formatBytes } from '../lib/format';

interface StorageInfo {
  usage: number;
  quota: number;
  persisted: boolean;
}

interface StorageStatusProps {
  /** When provided, rendered alongside the byte totals as "N books · X%". */
  bookCount?: number;
  /** When true, shows a "Manage books" link to /archive when >80% used. */
  showArchiveLink?: boolean;
}

export default function StorageStatus({ bookCount, showArchiveLink = true }: StorageStatusProps) {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [persistHelp, setPersistHelp] = useState(false);

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
  const countLabel =
    typeof bookCount === 'number'
      ? `${bookCount} book${bookCount === 1 ? '' : 's'}`
      : null;
  const percentLabel = `${usagePercent < 1 ? '<1' : Math.round(usagePercent)}%`;

  return (
    <div className="storage-status">
      <div className="storage-status__header">
        <span className="storage-status__label">
          {countLabel ? (
            <>
              {countLabel} &middot; {percentLabel} of {formatBytes(info.quota)}
            </>
          ) : (
            <>
              Storage: {formatBytes(info.usage)} / {formatBytes(info.quota)}
            </>
          )}
        </span>
        {info.persisted && (
          <span className="storage-status__persisted-wrap">
            <span className="storage-status__persisted">Persistent</span>
            <button
              type="button"
              className="storage-status__help"
              onClick={() => setPersistHelp((v) => !v)}
              aria-expanded={persistHelp}
              aria-label="What does Persistent mean?"
            >
              ?
            </button>
          </span>
        )}
      </div>
      {persistHelp && (
        <p className="storage-status__help-body">
          Your browser has promised to keep SpeedReader&rsquo;s library
          on disk and won&rsquo;t evict it automatically to reclaim space.
        </p>
      )}
      <div className="storage-status__bar">
        <div
          className={`storage-status__fill${isWarning ? ' storage-status__fill--warning' : ''}`}
          style={{ width: `${Math.min(usagePercent, 100)}%` }}
        />
      </div>
      {isWarning && (
        <div className="storage-status__warning-wrap">
          <p className="storage-status__warning">
            Storage usage is above 80%. Consider removing unused books.
          </p>
          {showArchiveLink && (
            <Link to="/archive" className="storage-status__archive-link">
              Manage books
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
