import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getPublications, uploadBook, getProgress, deletePublication } from '../api/client';
import type { Publication, ReadingProgress } from '../api/client';
import StorageStatus from '../components/StorageStatus';

export default function LibraryPage() {
  const [publications, setPublications] = useState<Publication[]>([]);
  const [progressMap, setProgressMap] = useState<Record<number, ReadingProgress>>({});
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const handleDelete = async (e: React.MouseEvent, pub: Publication) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Delete "${pub.title}"? This cannot be undone.`)) return;
    setDeleting(pub.id);
    try {
      await deletePublication(pub.id);
      setPublications((prev) => prev.filter((p) => p.id !== pub.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(null);
    }
  };

  const fetchPubs = useCallback(async () => {
    try {
      setLoading(true);
      const pubs = await getPublications();
      setPublications(pubs);

      // Fetch progress for all publications in parallel
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

      // Sort: most recently read first, then unread books by id descending
      pubs.sort((a, b) => {
        const pa = map[a.id];
        const pb = map[b.id];
        if (pa && pb) return new Date(pb.updated_at).getTime() - new Date(pa.updated_at).getTime();
        if (pa) return -1;
        if (pb) return 1;
        return b.id - a.id;
      });
      setPublications([...pubs]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load library');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPubs();
  }, [fetchPubs]);

  const handleFileSelect = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const pub = await uploadBook(file);
      navigate(`/read/${pub.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
  };

  const onDropZoneClick = () => {
    fileInputRef.current?.click();
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  };

  return (
    <div className="library" role="main" aria-label="Book library" id="main-content">
      <h1 className="library__title">Library</h1>

      {/* Upload drop zone */}
      <div
        className="library__drop-zone"
        onClick={onDropZoneClick}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".epub"
          onChange={onInputChange}
          style={{ display: 'none' }}
        />
        <p className="library__drop-zone-text">
          <button
            type="button"
            className="library__upload-btn"
            onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
            aria-label="Upload EPUB book"
          >
            Tap to upload
          </button>{' '}
          or drag an EPUB file here
        </p>
        {uploading && <p className="library__uploading">Uploading...</p>}
        {error && <p className="library__error">{error}</p>}
      </div>

      <StorageStatus />

      {/* Publications list */}
      {loading ? (
        <div className="library__empty">Loading library...</div>
      ) : publications.length === 0 ? (
        <div className="library__empty">
          No books yet. Upload an EPUB to get started.
        </div>
      ) : (
        <div className="library__list">
          {publications.map((pub) => (
            <Link
              key={pub.id}
              to={`/read/${pub.id}`}
              className="library__card"
              role="article"
              aria-label={`${pub.title} by ${pub.author}`}
            >
              <div className="library__card-header">
                <div className="library__card-title">{pub.title}</div>
                <button
                  className="library__card-delete"
                  onClick={(e) => handleDelete(e, pub)}
                  disabled={deleting === pub.id}
                  aria-label={`Delete ${pub.title}`}
                >
                  {deleting === pub.id ? '...' : '\u00D7'}
                </button>
              </div>
              <div className="library__card-author">{pub.author}</div>
              <div className="library__card-meta">
                {pub.total_segments.toLocaleString()} segments
                {progressMap[pub.id] && (
                  <span className="library__card-progress-text">
                    {' · '}{Math.round((progressMap[pub.id].segments_read / pub.total_segments) * 100)}% read
                  </span>
                )}
              </div>
              {progressMap[pub.id] && (
                <div className="library__card-progress-bar">
                  <div
                    className="library__card-progress-fill"
                    style={{ width: `${Math.min(100, (progressMap[pub.id].segments_read / pub.total_segments) * 100)}%` }}
                  />
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
