import { useState, useEffect, useCallback } from 'react';
import {
  getArchivedPublications,
  unarchivePublication,
  deletePublication,
} from '../api/client';
import type { Publication } from '../api/client';
import BookCard from '../components/BookCard';
import EmptyState from '../components/EmptyState';
import ActionSheet, { type ActionSheetOption } from '../components/ActionSheet';

export default function ArchivePage() {
  const [archived, setArchived] = useState<Publication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionSheet, setActionSheet] = useState<{ pub: Publication } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Publication | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);

  const fetchArchived = useCallback(async () => {
    try {
      setLoading(true);
      const pubs = await getArchivedPublications();
      // Newest first
      pubs.sort((a, b) => b.id - a.id);
      setArchived(pubs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load archive');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchArchived();
  }, [fetchArchived]);

  const handleRestore = async (pub: Publication) => {
    try {
      await unarchivePublication(pub.id);
      setArchived((prev) => prev.filter((p) => p.id !== pub.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed');
    }
  };

  const handleDelete = async (pub: Publication) => {
    setDeleting(pub.id);
    try {
      await deletePublication(pub.id);
      setArchived((prev) => prev.filter((p) => p.id !== pub.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(null);
    }
  };

  const handleTap = (pub: Publication) => {
    setActionSheet({ pub });
  };

  const handleLongPress = (pub: Publication, _rect: DOMRect) => {
    setActionSheet({ pub });
  };

  const handleOpenOptions = (pub: Publication, _rect: DOMRect) => {
    setActionSheet({ pub });
  };

  const getActionSheetOptions = (): ActionSheetOption[] => {
    if (!actionSheet) return [];
    const { pub } = actionSheet;
    return [
      {
        label: 'Restore to Library',
        icon: (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1,4 1,10 7,10" />
            <path d="M3.51 14.49A8 8 0 1 0 2 9" />
          </svg>
        ),
        onSelect: () => handleRestore(pub),
      },
      {
        label: 'Delete permanently',
        variant: 'danger',
        icon: (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3,6 5,6 17,6" />
            <path d="M7 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            <path d="M15 6v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            <line x1="9" y1="9" x2="9" y2="14" />
            <line x1="11" y1="9" x2="11" y2="14" />
          </svg>
        ),
        onSelect: () => {
          setActionSheet(null);
          setDeleteTarget(pub);
        },
      },
    ];
  };

  return (
    <div className="app-page" role="main" aria-label="Archived books" id="main-content">
      <header className="page-header">
        <h1 className="page-header__title">Archive</h1>
        <p className="page-header__subtitle">
          {archived.length === 0
            ? 'Books you\'ve archived appear here'
            : `${archived.length} archived book${archived.length !== 1 ? 's' : ''}`}
        </p>
      </header>

      {error && (
        <div className="toast toast--error" role="alert">
          <span>{error}</span>
          <button className="toast__dismiss" onClick={() => setError(null)} aria-label="Dismiss">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>
      )}

      <div className="archive-info">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="8" cy="8" r="7" />
          <line x1="8" y1="5" x2="8" y2="5.01" strokeWidth="2" />
          <line x1="8" y1="7.5" x2="8" y2="11" />
        </svg>
        <span>Archived books are hidden from your library but still stored on your device. Swipe left to restore.</span>
      </div>

      {loading ? (
        <div className="book-list">
          {[1, 2].map((i) => (
            <div key={i} className="book-card__skeleton">
              <div className="skeleton skeleton--title" />
              <div className="skeleton skeleton--text" />
            </div>
          ))}
        </div>
      ) : archived.length === 0 ? (
        <EmptyState
          icon="archive"
          title="No archived books"
          description="When you archive a book from your library, it will appear here. You can restore or permanently delete it."
        />
      ) : (
        <div className="book-list">
          {archived.map((pub) => (
            <BookCard
              key={pub.id}
              pub={pub}
              onTap={handleTap}
              onSwipeAction={handleRestore}
              onLongPress={handleLongPress}
              onOptions={handleOpenOptions}
              swipeLabel="Restore"
              swipeColor="accent"
              disabled={deleting === pub.id}
            />
          ))}
        </div>
      )}

      {actionSheet && (
        <ActionSheet
          title={actionSheet.pub.title}
          subtitle={actionSheet.pub.author || 'Unknown author'}
          options={getActionSheetOptions()}
          onClose={() => setActionSheet(null)}
        />
      )}

      {deleteTarget && (
        <ActionSheet
          title={`Delete "${deleteTarget.title}"?`}
          subtitle="This permanently removes the book from your device."
          options={[
            {
              label: 'Delete permanently',
              variant: 'danger',
              icon: (
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3,6 5,6 17,6" />
                  <path d="M7 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                  <path d="M15 6v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <line x1="9" y1="9" x2="9" y2="14" />
                  <line x1="11" y1="9" x2="11" y2="14" />
                </svg>
              ),
              onSelect: () => void handleDelete(deleteTarget),
            },
          ]}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
