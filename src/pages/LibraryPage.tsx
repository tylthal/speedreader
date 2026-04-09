import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getPublications,
  uploadBook,
  getProgress,
  archivePublication,
  unarchivePublication,
} from '../api/client';
import type { Publication, ReadingProgress } from '../api/client';
import BookCard from '../components/BookCard';
import EmptyState from '../components/EmptyState';
import UploadFAB, { type UploadFABHandle } from '../components/UploadFAB';
import ActionSheet, { type ActionSheetOption } from '../components/ActionSheet';
import ProcessingDialog from '../components/ProcessingDialog';

function sortPublications(
  pubs: Publication[],
  progressByPublication: Record<number, ReadingProgress>,
): Publication[] {
  return [...pubs].sort((a, b) => {
    const pa = progressByPublication[a.id];
    const pb = progressByPublication[b.id];
    if (pa && pb) return new Date(pb.updated_at).getTime() - new Date(pa.updated_at).getTime();
    if (pa) return -1;
    if (pb) return 1;
    return b.id - a.id;
  });
}

export default function LibraryPage() {
  const [publications, setPublications] = useState<Publication[]>([]);
  const [progressMap, setProgressMap] = useState<Record<number, ReadingProgress>>({});
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadPhase, setUploadPhase] = useState('');
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadFilename, setUploadFilename] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [actionSheet, setActionSheet] = useState<{
    pub: Publication;
  } | null>(null);
  const [archiveUndo, setArchiveUndo] = useState<{
    pub: Publication;
    progress?: ReadingProgress;
  } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const uploadFabRef = useRef<UploadFABHandle>(null);
  const archiveUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();
  const featuredPublication = publications[0] ?? null;
  const remainingPublications = featuredPublication ? publications.slice(1) : [];
  const featuredProgress = featuredPublication ? progressMap[featuredPublication.id] : undefined;

  const fetchPubs = useCallback(async () => {
    try {
      setLoading(true);
      const pubs = await getPublications();

      const progressResults = await Promise.allSettled(
        pubs.map((p) => getProgress(p.id))
      );
      const map: Record<number, ReadingProgress> = {};
      progressResults.forEach((result, i) => {
        if (result.status === 'fulfilled' && result.value) {
          map[pubs[i].id] = result.value;
        }
      });
      setProgressMap(map);
      setPublications(sortPublications(pubs, map));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load library');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPubs();
  }, [fetchPubs]);

  const clearArchiveUndoTimer = useCallback(() => {
    if (archiveUndoTimerRef.current) {
      clearTimeout(archiveUndoTimerRef.current);
      archiveUndoTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => clearArchiveUndoTimer();
  }, [clearArchiveUndoTimer]);

  const showArchiveUndo = useCallback((pub: Publication, progress?: ReadingProgress) => {
    clearArchiveUndoTimer();
    setArchiveUndo({ pub, progress });
    archiveUndoTimerRef.current = setTimeout(() => {
      setArchiveUndo((current) => (current?.pub.id === pub.id ? null : current));
      archiveUndoTimerRef.current = null;
    }, 5000);
  }, [clearArchiveUndoTimer]);

  const handleFileSelect = async (file: File) => {
    setUploading(true);
    setUploadPhase('');
    setUploadPercent(0);
    setUploadFilename(file.name);
    setError(null);
    try {
      const pub = await uploadBook(file, (phase, percent) => {
        setUploadPhase(phase);
        setUploadPercent(percent);
      });
      navigate(`/read/${pub.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleArchive = async (pub: Publication) => {
    const removedProgress = progressMap[pub.id];
    clearArchiveUndoTimer();
    setArchiveUndo(null);
    setPublications((prev) => prev.filter((p) => p.id !== pub.id));
    setProgressMap((prev) => {
      const next = { ...prev };
      delete next[pub.id];
      return next;
    });
    try {
      await archivePublication(pub.id);
      showArchiveUndo(pub, removedProgress);
    } catch (err) {
      setProgressMap((prev) => {
        if (!removedProgress) return prev;
        return { ...prev, [pub.id]: removedProgress };
      });
      setPublications((prev) => sortPublications([...prev, pub], {
        ...progressMap,
        ...(removedProgress ? { [pub.id]: removedProgress } : {}),
      }));
      setError(err instanceof Error ? err.message : 'Archive failed');
    }
  };

  const handleUndoArchive = async () => {
    if (!archiveUndo) return;
    const undoTarget = archiveUndo;
    clearArchiveUndoTimer();
    setArchiveUndo(null);
    try {
      await unarchivePublication(undoTarget.pub.id);
      await fetchPubs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Undo failed');
      showArchiveUndo(undoTarget.pub, undoTarget.progress);
    }
  };

  const handleTap = (pub: Publication) => {
    navigate(`/read/${pub.id}`);
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
        label: 'Continue reading',
        icon: (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="6,3 18,10 6,17" />
          </svg>
        ),
        onSelect: () => navigate(`/read/${pub.id}`),
      },
      {
        label: 'Archive',
        icon: (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="16" height="4" rx="1" />
            <path d="M4 7v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" />
            <path d="M8 11h4" />
          </svg>
        ),
        onSelect: () => handleArchive(pub),
      },
    ];
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  };

  const onDragLeave = () => setDragActive(false);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  };

  return (
    <div
      className="app-page"
      role="main"
      aria-label="Book library"
      id="main-content"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Drag overlay */}
      {dragActive && (
        <div className="drag-overlay">
          <div className="drag-overlay__content">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round">
              <line x1="24" y1="8" x2="24" y2="40" />
              <line x1="8" y1="24" x2="40" y2="24" />
            </svg>
            <p>Drop your book here</p>
          </div>
        </div>
      )}

      <header className="page-header">
        <h1 className="page-header__title">Library</h1>
        <p className="page-header__subtitle">
          {publications.length === 0
            ? 'Add a book to get started'
            : featuredProgress
              ? 'Pick up where you left off'
              : `${publications.length} book${publications.length !== 1 ? 's' : ''} ready to read`}
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

      {loading ? (
        <div className="book-list">
          {[1, 2, 3].map((i) => (
            <div key={i} className="book-card__skeleton">
              <div className="skeleton skeleton--title" />
              <div className="skeleton skeleton--text" />
              <div className="skeleton skeleton--text skeleton--short" />
            </div>
          ))}
        </div>
      ) : publications.length === 0 ? (
        <EmptyState
          icon="library"
          title="Your library is empty"
          description="Import an EPUB, PDF, or other supported format to start reading. Your books stay on this device."
          action={{
            label: 'Import your first book',
            onClick: () => uploadFabRef.current?.openPicker(),
          }}
        />
      ) : (
        <>
          {featuredPublication && (
            <section className="library-section">
              <div className="library-section__header">
                <h2 className="library-section__title">
                  {featuredProgress ? 'Continue reading' : 'Start here'}
                </h2>
                <p className="library-section__description">
                  {featuredProgress
                    ? 'Your most recent book is ready where you left off.'
                    : 'Your newest book is ready to open.'}
                </p>
              </div>
              <BookCard
                key={featuredPublication.id}
                pub={featuredPublication}
                progress={featuredProgress}
                featured
                onTap={handleTap}
                onSwipeAction={handleArchive}
                onLongPress={handleLongPress}
                onOptions={handleOpenOptions}
                swipeLabel="Archive"
                swipeColor="accent"
              />
            </section>
          )}

          {remainingPublications.length > 0 && (
            <section className="library-section">
              <div className="library-section__header">
                <h2 className="library-section__title">Library</h2>
                {publications.length <= 3 && (
                  <p className="book-list__hint">
                    Swipe left to archive or use the menu for more options
                  </p>
                )}
              </div>
              <div className="book-list">
                {remainingPublications.map((pub) => (
                  <BookCard
                    key={pub.id}
                    pub={pub}
                    progress={progressMap[pub.id]}
                    onTap={handleTap}
                    onSwipeAction={handleArchive}
                    onLongPress={handleLongPress}
                    onOptions={handleOpenOptions}
                    swipeLabel="Archive"
                    swipeColor="accent"
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <UploadFAB
        ref={uploadFabRef}
        onFileSelect={handleFileSelect}
        uploading={uploading}
        uploadPhase={uploadPhase}
        uploadPercent={uploadPercent}
      />

      {archiveUndo && (
        <div className="undo-toast" role="status" aria-live="polite">
          <div className="undo-toast__content">
            <span className="undo-toast__label">Archived</span>
            <span className="undo-toast__title">{archiveUndo.pub.title}</span>
          </div>
          <button className="undo-toast__action" type="button" onClick={handleUndoArchive}>
            Undo
          </button>
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

      {uploading && (
        <ProcessingDialog
          filename={uploadFilename}
          phase={uploadPhase}
          percent={uploadPercent}
        />
      )}
    </div>
  );
}
